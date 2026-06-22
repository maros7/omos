import { describe, expect, test } from "bun:test"
import { rewriteGoCommand } from "./rewrite"

const BIN = ["gogate"]

describe("rewriteGoCommand", () => {
  test.each([
    ["go build ./...", "'gogate' go build ./..."],
    ["go test -run TestX ./...", "'gogate' go test -run TestX ./..."],
    ["go test ./... -update", "'gogate' go test ./... -update"],
    ["go vet -vettool=x ./...", "'gogate' go vet -vettool=x ./..."],
    [
      "golangci-lint run --config=.golangci.yml",
      "'gogate' golangci-lint run --config=.golangci.yml",
    ],
    // Go-workspace / multi-module commands are always GOWORK=off-prefixed; the
    // env assignment must stay in front of the gogate binary so it is exported
    // into the `go` subprocesses gogate spawns.
    ["GOWORK=off go build ./...", "GOWORK=off 'gogate' go build ./..."],
    ["GOWORK=off go test -race -count=1 ./...", "GOWORK=off 'gogate' go test -race -count=1 ./..."],
    ["CGO_ENABLED=0 go test ./...", "CGO_ENABLED=0 'gogate' go test ./..."],
    [
      "CGO_ENABLED=0 GOOS=linux go build ./...",
      "CGO_ENABLED=0 GOOS=linux 'gogate' go build ./...",
    ],
    ["GOWORK=off golangci-lint run ./...", "GOWORK=off 'gogate' golangci-lint run ./..."],
    // Value containing `=` must not be swallowed: the env peel stops at the first
    // whitespace, leaving `go build` as the recognized command.
    ["GOFLAGS=-mod=mod go build ./...", "GOFLAGS=-mod=mod 'gogate' go build ./..."],
    // Empty value is a valid POSIX assignment.
    ["FOO= go build ./...", "FOO= 'gogate' go build ./..."],
  ])("%s -> %s", (cmd, want) => {
    expect(rewriteGoCommand(cmd, BIN)).toBe(want)
  })

  test("quotes the resolved binary prefix segments", () => {
    expect(rewriteGoCommand("go test ./...", ["go", "run", "./cmd/gogate"])).toBe(
      "'go' 'run' './cmd/gogate' go test ./...",
    )
  })

  test("shell-quotes a binPrefix containing spaces into a usable string", () => {
    const out = rewriteGoCommand("go test ./...", ["/Users/me/My Project/bin/gogate"])
    expect(out).toBe("'/Users/me/My Project/bin/gogate' go test ./...")
  })

  test("escapes embedded single quotes in the prefix", () => {
    expect(rewriteGoCommand("go test ./...", ["/a'b/gogate"])).toBe(
      "'/a'\\''b/gogate' go test ./...",
    )
  })

  test("inserts gogate flags before the wrapped command", () => {
    expect(rewriteGoCommand("go test ./...", BIN, ["-rerun-fails=2"])).toBe(
      "'gogate' '-rerun-fails=2' go test ./...",
    )
  })

  test("leaves the user command exactly as written (no re-quoting)", () => {
    expect(rewriteGoCommand('go test -run "Test A" ./...', BIN)).toBe(
      "'gogate' go test -run \"Test A\" ./...",
    )
  })

  test("does not skip commands that merely contain 'gogate' as a path", () => {
    expect(rewriteGoCommand("go test ./gogate/", BIN)).toBe("'gogate' go test ./gogate/")
  })

  test.each([
    ["pipe", "go test ./... | tee out.txt"],
    ["chain", "go build ./... && go test ./..."],
    ["redirect", "go test ./... > out.txt"],
    ["subshell", "go test $(ls)"],
    ["env prefix to a non-go command", "FOO=bar ls -la"],
    ["bare env assignment", "FOO=bar"],
    // Env peel must not defeat the already-gogate double-wrap guard.
    ["env prefix to already gogate", "GOWORK=off gogate go test ./..."],
    // Quoted-space value is deliberately not supported: the peel stops at the
    // space, leaving a leftover quote so RECOGNIZED fails -> passthrough.
    ["env value with quoted space", 'FOO="a b" go build ./...'],
    ["already gogate", "gogate go test ./..."],
    ["already gogate path", "/usr/local/bin/gogate go test ./..."],
    ["already gogate.exe", "gogate.exe go test ./..."],
    ["go mod tidy", "go mod tidy"],
    ["go run", "go run ./cmd/foo"],
    ["golangci-lint version", "golangci-lint version"],
    ["not a go command", "ls -la"],
    ["empty", "   "],
  ])("returns null for %s", (_name, cmd) => {
    expect(rewriteGoCommand(cmd, BIN)).toBeNull()
  })
})
