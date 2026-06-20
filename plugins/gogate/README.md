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

```sh
go install github.com/maros7/omos/plugins/gogate/cmd/gogate@latest   # puts gogate on PATH
# or, in this repo, for development:
go build -o bin/gogate ./cmd/gogate
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
  flaky tests. Resolves the binary as `./bin/gogate` (when developing gogate itself) else
  `gogate` on `PATH`.
- **Plugin** `go-gate` — intercepts `bash` calls and rewrites a recognized Go command by
  **prepending `gogate`** (e.g. `go test -run X ./...` → `gogate go test -run X ./...`),
  so the model's habitual `go build`/`go test`/`golangci-lint` each trigger the full gate
  in one call; everything else (`go mod`, `go run`, `go get`, …) passes through untouched.
  Set `GOGATE_MODE=off` to disable, or `GOGATE_RERUN_FAILS=N` to re-run flaky tests.

The rewriter leaves a command alone when it isn't a single, recognized invocation: shell
pipes / chaining / redirects / command substitution / env prefixes, and unrecognized
commands. Logic lives in `.opencode/lib/rewrite.ts` and is unit-tested (`bun test` in
`.opencode/`).

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
× amd64/arm64 (`CGO_ENABLED=0`, static). Pushing a `v*` tag runs
`.github/workflows/release.yml`, which publishes the archives + `checksums.txt` to a
GitHub Release **and** publishes the npm packages (see below). Publishing requires an
`NPM_TOKEN` repository secret with publish rights on the `gogate` package and the
`@gogate` scope.

The `npm/` package wraps the binary so it runs via `bunx`/`npx` — no Go needed. Its
launcher (`npm/bin/gogate.cjs`) resolves the binary in order: `$GOGATE_BIN` → the
`@gogate/<os>-<arch>` platform package (when published) → a local `bin/gogate` dev build.

**Use it locally right now** (points at this repo, pre-publish):

```sh
go build -o bin/gogate ./cmd/gogate   # the launcher's local fallback
cd npm && bun link                    # register "gogate" globally
bunx gogate go test -run=TestX ./...  # runs the gate via the local binary
# (bun unlink in npm/ to undo)
```

**Publishing** is automated by `npm/scripts/publish.mjs` (invoked from the release
workflow on a `v*` tag). It reads the binaries out of the GoReleaser archives in `dist/`
and publishes the `npm/` package as `gogate` plus one `@gogate/<os>-<arch>` package per
platform (each carrying its binary with `os`/`cpu` constraints) listed under
`optionalDependencies` — the esbuild pattern, so a published `bunx gogate` installs only
the matching prebuilt binary. All versions are derived from the pushed tag (the `0.1.0`
in `npm/package.json` is just a placeholder the script rewrites). The launcher already
resolves those packages.

## Requirements

- Go 1.26+
- golangci-lint v2 (uses `--output.json.path stdout`)
