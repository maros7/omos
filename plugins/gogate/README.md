# gogate — Go quality gate for OpenCode

`gogate` runs the Go toolchain and emits a **structured, model-friendly report**: per-step
status, parsed diagnostics (file/line/col/message), test counts, and coverage. The CLI
defaults to a compact text report (`-format json` for the machine-readable version).

It always runs the **full gate** — `go build`, `go test` (with coverage), and
`golangci-lint` — in one pass, short-circuiting test and lint if the build fails. A
recognized Go command just *triggers* the gate; a `go test …` command additionally
**scopes the test step** (build and lint always cover `./...`). So whichever command the
model reaches for first (`go build ./...`, `go test -run=X ./pkg`, `golangci-lint run`)
gets the complete build+test+lint result in one call — it never has to run the other
steps separately.

It ships as:

- a **Go binary** (`cmd/gogate`) — a thin wrapper around the `gogate` package, which
  holds all logic and is independently tested (100% statement coverage),
- an **OpenCode custom tool** (`.opencode/tool/gogate.ts`) that calls the binary
  (with `-format=text`) and returns its compact, structured text report to the model,
- an **OpenCode plugin** (`.opencode/plugin/go-gate.ts`) whose hook rewrites recognized
  Go commands the model runs into a `gogate` invocation.

## Layout

```
cmd/gogate/main.go        thin CLI wrapper
gogate/                   library (gate/command orchestration + parsers)
.opencode/tool/gogate.ts  custom tool: locate binary, run, return text report
.opencode/lib/rewrite.ts  command recognizer (prepends gogate); unit-tested
.opencode/plugin/go-gate.ts plugin hook: rewrite recognized commands
```

## Install

Nothing to install by hand — enable the plugin in your `opencode.json` (point at the
`plugins/gogate` directory) and it downloads the matching binary from the latest GitHub
Release on first use (see [Distribution](#distribution)). For local development you can
still build it directly:

```sh
go build -o bin/gogate ./cmd/gogate   # the plugin prefers this dev build
# or put it on PATH:
go install github.com/maros7/omos/plugins/gogate/cmd/gogate@latest
```

## CLI usage

```sh
gogate [-dir .] [-timeout 120s] [-format text|json] [-pretty] [-rerun-fails N]
gogate [flags] <go test ... | go build ... | golangci-lint run ...>   # gate; a go test scopes the test step
```

Output is a compact **plain-text summary by default** — easier for an LLM to read —
covering every step, all diagnostics, and coverage. Repeated identical diagnostics (one
linter finding across many lines) collapse to a single message plus a list of locations,
and each under-100% function lists its **exact uncovered line ranges** (so untaken
`if`/`else` branches show as their line numbers). Pass `-format json` for the structured
report (`-pretty` to indent it) — same information, for machines/CI. Every form runs
build + test + lint:

```sh
gogate                                 # build ./... + test ./... + lint ./...
gogate go test -run=TestFoo ./...      # build ./... + test -run=TestFoo ./... + lint ./...
gogate go test -race -count=1 ./pkg    # build ./... + test (those flags, ./pkg) + lint ./...
gogate go build ./...                  # build ./... + test ./... + lint ./...  (build/lint ignore the command's packages)
```

A `go test` command's flags/packages scope only the **test** step — `build` and `lint`
always cover `./...` (build is cheap; lint is a whole-module check). golangci-lint
auto-discovers `.golangci.{yml,yaml,toml,json}` from the repo root, and the lint step
passes `--allow-parallel-runners` so concurrent agents don't fail on its lock.

### Re-running flaky tests (`-rerun-fails`)

`-rerun-fails=N` re-runs failed tests (by name, via a combined `-run ^(TestA|TestB)$`)
up to N attempts until they pass. A test that only passes on a re-run is reported in the
test step's `flaky` list and counted as passed; tests that keep failing stay failed.
Re-running is skipped when there are more than 10 failures (likely real breakage, not
flakiness) or when the failure is a package-level panic/timeout that can't be isolated by
name. Coverage is taken from the first run.

```sh
gogate -rerun-fails=3 go test ./...
# → "12 passed, 0 failed, 0 skipped (1 flaky)", with "flaky": ["TestSometimes"]
```

### Example output

Default text:

```text
gogate: FAIL (1265ms)

build pass    ok
test  fail    30 passed, 1 failed, 0 skipped
  foo_test.go:42  go test: TestThing failed in …/foo
lint  pass    0 issues

coverage: 73.0%
  …/gogate  73.0%
  uncovered (add tests here):
    Classify  40.0%  p/p.go:2  uncovered lines: 6-9
```

The same report with `-format json`:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "durationMs": 1265,
  "steps": [
    { "name": "build", "status": "pass", "durationMs": 285, "summary": "ok" },
    {
      "name": "test", "status": "fail", "durationMs": 479,
      "summary": "30 passed, 1 failed, 0 skipped",
      "tests": { "passed": 30, "failed": 1, "skipped": 0 },
      "diagnostics": [ { "file": "foo_test.go", "line": 42, "severity": "error", "source": "go test", "message": "TestThing failed in …/foo" } ]
    },
    { "name": "lint", "status": "pass", "durationMs": 499, "summary": "0 issues" }
  ],
  "coverage": {
    "totalPct": 73.0,
    "byPackage": [ { "package": "…/p", "pct": 40.0 } ],
    "uncovered": [ { "file": "p/p.go", "line": 2, "function": "Classify", "pct": 40.0, "uncoveredLines": [ { "start": 6, "end": 9 } ] } ]
  }
}
```

Step `status` is one of `pass`, `fail`, `skipped`, `error` (`error` = the step could not
run, e.g. golangci-lint not installed, or an unrecognized command). A build that
fails with no parseable compiler diagnostics surfaces its raw stderr in the step's
`error`. Diagnostics are capped at 50 per step (`truncated` / `omittedCount` flag the
rest). The process always exits 0 and always prints the report — failures live inside it.
(Usage errors exit 2.)

> **Coverage:** `byPackage` percentages come from `go test -cover` and reflect what the
> tests that actually ran exercised — so `gogate go test -run=TestX ./pkg` reports the
> coverage *TestX* produces. `totalPct` is the statement-weighted total from
> `go tool cover -func` over a profile gogate writes (skipped when you pass your own
> coverage flag). `uncovered` lists functions below 100% (most-uncovered first, capped at
> 20) with their exact uncovered line ranges (from the coverprofile's per-block data, so
> an untaken `if`/`else` arm shows as its lines) — pointing the model at what to test.

## OpenCode integration

The `.opencode/` directory is loaded automatically when OpenCode runs in this project.

- **Tool** `gogate` — callable by the model. Always runs the gate; pass an optional
  `command` (a `go test …`) to scope the test step, and optionally `rerunFails` to re-run
  flaky tests.   Pass `directory` to run the **whole gate** (build+test+lint) inside that
  directory — use it for a **nested Go module / subdirectory** (e.g. `plugin/`), and
  prefer it over `cd nested && go test …`. You may also prefix `command` with one or
  more `VAR=val` env assignments (e.g. `GOWORK=off`, `GOFLAGS=…`, `GOPRIVATE=…`); they
  scope the **whole gate** (build+test+lint). For a nested module and/or env vars, reach
  for the `directory` arg + a leading `VAR=val` prefix on `command` — don't
  `cd`/pipe/reconstruct the binary; the report is already compact. The tool accepts a
  **single** go/golangci command: a trailing output sink (`| tail`, `> file`, `2>&1`) is
  auto-stripped, and compound commands (`;`, `&&`, command substitution) are rejected.
  Resolves the binary via the order described under [Distribution](#distribution)
  (auto-downloading it on first use if needed).
- **Plugin** `go-gate` — intercepts `bash` calls and rewrites recognized Go commands by
  **prepending `gogate`** (e.g. `go test -run X ./...` → `gogate go test -run X ./...`),
  so the model's habitual `go build`/`go test`/`golangci-lint` each trigger the full gate
  in one call; everything else (`go mod`, `go run`, `go get`, …) passes through untouched.

The bash rewrite wraps recognized commands **in place** and **preserves the surrounding
shell structure verbatim** — pipes, redirects, chains (`&&`/`||`/`;`), and `cd …` are kept
as written. The command is split on top-level shell control operators (quote-aware, via
`src/shell.ts`'s `splitShell`) and each recognized go/golangci segment is wrapped
individually; the rest is reassembled byte-for-byte. Two conveniences: redundant gates over
the **same directory** collapse to one (gogate runs the whole gate regardless of subcommand,
so `go build ./... && go test ./...` gates that dir once), and a leading `rtk` (a fellow
output-minimizing wrapper) is stripped from a recognized segment. The report is already
canonical and compact, so piping it through `tail`/`head` is unnecessary. Logic lives in
`src/shell.ts` + `src/rewrite.ts` and is unit-tested (`bun test`).

### Env flags

- `GOGATE_MODE=off` — disable the bash rewrite entirely (the explicit `gogate` tool still
  works).
- `GOGATE_DISABLED` — also disables the bash rewrite when set to any non-empty value other
  than `0` (e.g. `1`, `true`, `yes`); `0` and unset/empty leave it enabled.
- `GOGATE_RERUN_FAILS=N` — re-run failed tests up to N attempts (flaky-test guard) for the
  rewrite path.

Install plugin dependencies (OpenCode runs `bun install` at startup):

```sh
cd .opencode && bun install
```

## Develop & test

```sh
go test ./gogate/ -cover          # unit tests, 100% statement coverage
go test ./gogate/ -short          # skip the e2e tests (which drive the real toolchain)
go vet ./...
golangci-lint run ./...
```

E2E tests (`gogate/e2e_test.go`) run the gate with the real `go`/`golangci-lint` against
throwaway modules in `t.TempDir()` (gate pass, build-fail short-circuit, test-fail, lint
violation, and a deterministically-flaky `-rerun-fails` run). They are slow and need
golangci-lint, so `-short` skips them and they skip themselves when it isn't installed.

## Distribution

Prebuilt binaries are built by **GoReleaser** (`.goreleaser.yaml`) for darwin/linux/windows
× amd64/arm64 (`CGO_ENABLED=0`, static). Releases are managed by **release-please**
(component `opencode-gogate`): merging its release PR tags `opencode-gogate-v*` and creates
a **GitHub Release**, to which CI builds and uploads the archives plus `checksums.txt`. The
Go binary itself is not shipped via npm — the TS plugin (`opencode-gogate`) is published to
npm (OIDC Trusted Publishing), and at runtime it auto-downloads + caches the matching binary
from the GitHub Release on first use. A best-effort
`postinstall` hook also installs the bundled `SKILL.md` to
`~/.config/opencode/skills/gogate/` so the model prefers `gogate` over running
`go build`/`go test`/`golangci-lint` separately.

On first use the plugin downloads the binary matching your OS/arch from the GitHub Release
for the plugin's own version (tag `opencode-gogate-v<version>`), verifies it against
`checksums.txt` (SHA-256), and caches it under
`$XDG_CACHE_HOME/gogate` (or `~/.cache/gogate`). A cache entry is only trusted once a
`.ok` success marker is written next to the binary — written **last**, after the checksum,
extraction, and `chmod` all succeed — so an interrupted install is never reused. After a
successful install it runs entirely from the cache — no per-call network.

`resolveBinary` picks the binary in this order (first hit wins):

1. **`GOGATE_BIN`** — explicit path to a binary (overrides everything).
2. **`<plugin>/bin/gogate`** — a local dev build, when present.
3. **version-aware cache hit** — the cached binary **and** its `.ok` marker are both
   present (no network).
4. **download + verify + extract + chmod + write marker** the release binary.

By default the plugin resolves the release matching its **own version** (tag
`opencode-gogate-v<version>`), so the binary always matches the installed plugin. Set
**`GOGATE_VERSION`** to pin a different release tag (e.g. `opencode-gogate-v1.2.3`). A
pinned version is cached under its own tag-keyed path (`<cache>/bin/<version>/gogate`), so
setting or changing the pin forces a download of exactly that tag instead of reusing the
default binary. Unpinned, the version-matched release is cached at `<cache>/bin/gogate`. If
`GITHUB_TOKEN` is set it is sent as a bearer token on the GitHub API call (useful to avoid
rate limits).

To force a re-install (e.g. after a corrupted download or to re-fetch the unpinned
binary): delete the cache directory (`$XDG_CACHE_HOME/gogate` or `~/.cache/gogate`) or
just remove the `<cachedBin>.ok` marker, and the next run re-downloads and re-verifies.

## Requirements

- Go 1.26+
- golangci-lint v2 (uses `--output.json.path stdout`)

## Development

The TS plugin shim (`src/`) wraps the Go binary. To develop and test the TS layer:

```sh
bun test                 # unit tests
bun run typecheck        # tsc --noEmit
bun run lint             # eslint
```
