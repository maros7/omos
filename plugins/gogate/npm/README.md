# gogate

A **Go quality gate** that runs `go build`, `go test` (with coverage), and
`golangci-lint` in one pass and returns a single **structured, model-friendly
result** — per-step status, parsed diagnostics (file/line/col/message), test
counts, and coverage. It short-circuits the test and lint steps if the build
fails.

This npm package is the **cross-platform launcher**: it resolves and runs the
prebuilt `gogate` Go binary, so you can use it via `bunx`/`npx` without a Go
toolchain installed.

## Usage

```sh
bunx gogate              # build ./... + test ./... + lint ./...  (compact text report)
npx gogate

bunx gogate go test -run=TestFoo ./...   # a `go test` command scopes the test step
bunx gogate -format json                 # machine-readable report (-pretty to indent)
```

The full gate always runs. A recognized Go command just *triggers* it; a
`go test …` command additionally **scopes the test step** (build and lint always
cover `./...`). Output defaults to a compact text summary; pass `-format json`
for the structured version.

## Installation

`bunx`/`npx` fetch this package on demand — no manual install needed. The actual
platform binary ships as an `optionalDependency`, and the launcher
(`bin/gogate.cjs`) installs/resolves only the one matching your `os`/`arch`:

- `@gogate/darwin-amd64`
- `@gogate/darwin-arm64`
- `@gogate/linux-amd64`
- `@gogate/linux-arm64`
- `@gogate/windows-amd64`
- `@gogate/windows-arm64`

Resolution order: `$GOGATE_BIN` (explicit override) → the `@gogate/<os>-<arch>`
platform package → a local `bin/gogate` dev build.

### Go users

If you have a Go toolchain, you can install the binary directly instead:

```sh
go install github.com/maros7/omos/plugins/gogate/cmd/gogate@latest
```

## OpenCode plugin

`gogate` is the tool used by the **gogate OpenCode plugin**, which rewrites
recognized Go commands the model runs (`go build` / `go test` / `golangci-lint`)
into a single `gogate` invocation that returns the full build+test+lint result.
See the full plugin docs for details.

## Links

- Plugin docs: <https://github.com/maros7/omos/tree/main/plugins/gogate>
- Repository (omos monorepo): <https://github.com/maros7/omos>

`gogate` is part of the **omos** monorepo.

## License

MIT
