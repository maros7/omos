# review-fixer — token-minimized PR review-thread handling for OpenCode

`review-fixer` triages and resolves **pull-request review threads from any reviewer** and
emits **compact, TOKEN-MINIMIZED text** so an LLM spends few tokens per call. It lists
unresolved threads on a PR and, once you've fixed the code, posts each reply and resolves
the thread.

It ships as:

- a **Go binary** (`cmd/review-fixer`) — a thin wrapper around the `reviewfixer`
  package, which holds all logic and is independently tested,
- an **OpenCode custom tool** (`review-fixer`) that calls the binary (with
  `-format=text`) and returns its compact text output to the model,
- an **OpenCode plugin** that registers that tool and **auto-downloads** the prebuilt
  binary on first use (see [Distribution](#distribution)).

Unlike `gogate`, this plugin does **not** rewrite bash commands — it only registers the
`review-fixer` tool plus binary resolution.

## Layout

```
cmd/review-fixer/main.go   thin CLI wrapper
reviewfixer/               library (command orchestration + GitHub API)
src/index.ts               plugin: registers the review-fixer custom tool
src/resolve.ts             binary resolution (override → dev build → cache → download)
src/args.ts                maps tool args → binary argv + stdin payload
```

## Install

Nothing to install — enable the plugin in your `opencode.json` (point at the
`plugins/review-fixer` directory) and it downloads the matching binary from the latest
GitHub Release on first use. For Go-based local development you can still build it:

```sh
go build -o bin/review-fixer ./cmd/review-fixer   # the plugin prefers this dev build
```

## CLI contract

Binary name: `review-fixer`. Always exits `0` (success) / `1` (error) / `2` (usage).
Global flags (parsed **before** the subcommand): `-token`, `-api-base`,
`-format text|json` (default `text`).

```sh
review-fixer -format=text list   [-pr <int>] [-repo owner/name] [-author <login>]
review-fixer -format=text apply  [-pr <int>] [-repo owner/name] [-author <login>]   # items JSON on stdin
review-fixer -format=text verify [-pr <int>] [-repo owner/name] [-author <login>]
```

`apply` reads a JSON array of `{ "threadId": "...", "body": "..." }` from **stdin**, and
for each item posts the reply and resolves the thread. `verify` reports a PR's remaining
unresolved threads.

## OpenCode integration

The `review-fixer` tool is callable by the model. **You** fix the code; this tool posts
the reply and resolves the thread. It takes an `action` plus the fields that action needs:

| arg      | type                                | actions            |
| -------- | ----------------------------------- | ------------------ |
| `action` | enum (`list`/`apply`/`verify`)      | (required) all     |
| `pr`     | int                                 | list, apply, verify|
| `repo`   | string (owner/name)                 | list, apply, verify|
| `author` | string (substring filter on login)  | list, apply, verify|
| `items`  | array of `{ threadId, body }`       | apply              |

Globals come first (`-format=text` then the subcommand), then `-pr`/`-repo`/`-author` as
provided. For `apply`, `items` is **not** placed on the command line — it is streamed to
the binary's stdin as JSON. A missing flag is passed through so the binary returns its own
usage error (exit 2), which the tool surfaces verbatim. Binary resolution order is
described under [Distribution](#distribution).

Install plugin dependencies (OpenCode runs `bun install` at startup):

```sh
bun install
```

## Develop & test

```sh
bun test --cwd plugins/review-fixer            # TS unit tests (resolve + arg building)
bun run --cwd plugins/review-fixer typecheck   # tsc --noEmit
go test ./reviewfixer/ -cover                  # Go unit tests
```

The TS tests mock the filesystem/platform and do not depend on a built binary existing.

## Distribution

Prebuilt binaries are built by **GoReleaser** for darwin/linux/windows × amd64/arm64.
Pushing a `v*` tag uploads the archives plus `checksums.txt` to a **GitHub Release**.
There is **no npm package** — the OpenCode plugin is the only distribution path.

On first use the plugin downloads the binary matching your OS/arch from the **latest**
GitHub Release, verifies it against `checksums.txt` (SHA-256), and caches it under
`$XDG_CACHE_HOME/review-fixer` (or `~/.cache/review-fixer`). After that it runs entirely
from the cache — no per-call network.

`resolveBinary` picks the binary in this order (first hit wins):

1. **`REVIEW_FIXER_BIN`** — explicit path to a binary (override everything).
2. **`<plugin>/bin/review-fixer`** — a local dev build, when present.
3. **`<cache>/bin/review-fixer`** — a previously downloaded binary (no network).
4. **download + verify + cache** the release binary.

Set **`REVIEW_FIXER_VERSION`** to pin a specific release tag (e.g. `v1.2.3`); otherwise
the latest release is used and cached forever. If `GITHUB_TOKEN` is set it is sent as a
bearer token on the GitHub API call (useful to avoid rate limits).
