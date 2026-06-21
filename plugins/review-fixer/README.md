# review-fixer — token-minimized PR review-thread handling for OpenCode

`review-fixer` triages and resolves **pull-request review threads from any reviewer**
and emits **compact, TOKEN-MINIMIZED text** so an LLM spends few tokens per call. It
lists unresolved threads on a PR and, once you've fixed the code, posts each reply and
resolves the thread — in pure TypeScript. **No Go binary, no download.**

It ships as:

- an **OpenCode custom tool** (`review-fixer`) — pure TS, registered by the plugin,
- a **plugin** (`opencode-review-fixer`) that registers the tool, and
- a **skill** (`SKILL.md`) that's auto-installed into your opencode config dir on
  `postinstall` (best-effort; copyable by hand if needed).

## Layout

```
src/index.ts        plugin entry: registers the review-fixer custom tool
src/actions.ts      top-level wiring (token/repo/PR resolve → list/apply/verify)
src/github.ts       minimal GitHub GraphQL + REST client
src/resolve.ts      token / repo / PR discovery (flag → env → gh / git)
src/report.ts       pure rendering + filtering (byte-exact output contracts)
src/apply.ts        reply+resolve orchestration over a batch of items
src/deps.ts         side-effect seam (env / fetch / subprocess) for tests
install-skill.mjs   best-effort postinstall: copies SKILL.md into ~/.config
testdata/*.golden   committed golden text used by tests (source of truth)
```

## Install

Enable the plugin in your `opencode.json` by adding it to the `plugin` array, then
reference the published npm package:

```jsonc
{
  "plugin": {
    "opencode-review-fixer": "npm:opencode-review-fixer"
  }
}
```

```sh
bun install   # or npm install / pnpm install
```

The bundled `SKILL.md` is auto-copied to
`$XDG_CONFIG_HOME/opencode/skills/review-fixer/SKILL.md` (default
`~/.config/opencode/skills/review-fixer/SKILL.md`) by `postinstall`. The copy is
**best-effort** — if it fails (permissions, read-only mount, etc.) install still
succeeds and a warning is printed to stderr. You can always copy `SKILL.md` by hand
from the package if needed.

## `review-fixer` tool args

| arg      | type                                | actions             |
| -------- | ----------------------------------- | ------------------- |
| `action` | enum (`list`/`apply`/`verify`)      | (required) all      |
| `pr`     | int                                 | list, apply, verify |
| `repo`   | string (owner/name)                 | list, apply, verify |
| `author` | string (substring filter on login)  | list, apply, verify |
| `items`  | array of `{ threadId, body }`       | apply               |

`pr`, `repo`, and `author` are auto-resolved from `gh` / `git` when omitted (`gh auth
token`, `gh repo view`, current branch → `gh pr list`). `author` omitted means
**all reviewers**.

## Two-call workflow

```
1. { "action": "list" }                                  → see unresolved threads
2. { "action": "apply", "items": [...] }                 → reply + resolve all at once
3. { "action": "verify" }    (only if remaining > 0)     → confirm what's left
```

Example:

```json
{
  "action": "apply",
  "items": [
    { "threadId": "PRRT_kwDOExample", "body": "Fixed: extracted the helper and added a nil check." }
  ]
}
```

Resolve a thread only after you've actually addressed (or rebutted) it.

## Develop & test

```sh
bun install
cd plugins/review-fixer
bun test                  # all unit tests
bun run typecheck         # tsc --noEmit
bun test -u               # REGENERATE testdata/*.golden from current output
bun test --coverage       # tests with coverage (target: 100%)
```

The test suite is table-driven with committed **golden files** for every text-producing
function (`renderList`, `renderVerify`, `renderApply`, `applyLine`, end-to-end
`runAction`). Run `bun test -u` whenever you intentionally change a byte of output, then
review the diff in `testdata/*.golden`.

## Release

Published to npm via **release-please** on tag `opencode-review-fixer-v*` (Conventional
Commits drive the version). No GoReleaser, no binaries — `npm publish` is the whole
story.
