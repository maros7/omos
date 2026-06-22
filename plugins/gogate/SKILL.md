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
