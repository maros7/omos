# gogate

Go quality gate. ONE call runs `go build` + `go test` (coverage) +
`golangci-lint`. Prefer it over running those commands separately — it
short-circuits on build failure, parses diagnostics, returns a compact report.

## Rule

Don't run `go build`, `go test`, or `golangci-lint` yourself — call `gogate`.
After it returns: read `ok` + each step's `status`, fix all issues in one batch,
re-run once. Don't repeat its individual steps — the report already has
everything.

## Scoping

- `gogate` (no args) — full gate over `./...`
- `command: "go test -run=X ./pkg/..."` — scopes the **test** step only (build +
  lint always `./...`)
- `rerunFails: N` — re-run failed tests up to N times (flaky-test guard)
- `directory: "plugin/"` — runs the **whole gate** (build+test+lint) inside that
  directory; use for a nested Go module / subdirectory. Prefer this over
  `cd nested && go test ...`.
- `command: "GOWORK=off GOFLAGS=... go test ./..."` — leading `VAR=val` env
  assignments scope the **whole gate** (build+test+lint).

For a nested module and/or env vars, use the gogate tool's `directory` arg + a
leading `VAR=val` prefix on `command` — don't `cd`/pipe/reconstruct the binary;
the report is already compact.

## Don't pipe, redirect, or `cd`

The report is already canonical and compact, so piping it through `tail`/`head`
is unnecessary. Behavior differs by entry point:

- **`gogate` tool (`command` arg):** a trailing sink (`| tail`, `| head`,
  `> file`, `2>&1`) is auto-stripped, and compound commands (`;`, `&&`, command
  substitution) are rejected — pass a single go/golangci command.
- **bash rewrite:** recognized go/golangci commands are wrapped **in place**, so
  pipes/redirects/chains and `cd …` are preserved verbatim; redundant same-dir
  gates collapse to one and a leading `rtk` is stripped.

Prefer the `directory` arg over `cd nested && go test ...`.

## Disable

- `GOGATE_MODE=off` — disable the bash rewrite entirely.
- `GOGATE_DISABLED` — same, when set to any non-empty value other than `0` (e.g.
  `1`, `true`, `yes`). `0`/unset leave it enabled. The explicit `gogate` tool
  still works either way.

## Skip gogate for

`go mod`, `go run`, `go get`, `gofmt`, `go vet` alone — gogate is the full gate,
not every `go` subcommand. Non-Go repos.

## Output

```text
gogate: FAIL (1265ms)

build pass    ok
test  fail    30 passed, 1 failed
  foo_test.go:42  TestThing failed
lint  pass    0 issues

coverage: 73.0%
  pkg/path  73.0%
  uncovered (add tests here):
    Classify  40.0%  p.go:2  uncovered lines: 6-9
```

`FAIL` → read steps → fix → re-run once.
