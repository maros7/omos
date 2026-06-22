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

  // Recognized commands inside shell pipes/redirects/chains are wrapped per-segment
  // while the surrounding shell structure is reassembled byte-exact. A leading `rtk`
  // toolchain-wrapper prefix is stripped (gogate replaces rtk).
  test.each([
    [
      "cd /abs/path/plugin && GOWORK=off rtk go build ./... && GOWORK=off rtk go test -run TestBigQuery_generateMaterializedView ./protoc-gen-bigquery/ 2>&1 | tail -20",
      "cd /abs/path/plugin && GOWORK=off 'gogate' go build ./... && GOWORK=off 'gogate' go test -run TestBigQuery_generateMaterializedView ./protoc-gen-bigquery/ 2>&1 | tail -20",
    ],
    [
      'GOWORK=off rtk go build ./... 2>&1 | head -30; echo "EXIT=$?"',
      "GOWORK=off 'gogate' go build ./... 2>&1 | head -30; echo \"EXIT=$?\"",
    ],
    ["rtk go test ./...", "'gogate' go test ./..."],
    ["rtk golangci-lint run ./...", "'gogate' golangci-lint run ./..."],
    ["GOWORK=off rtk go build ./...", "GOWORK=off 'gogate' go build ./..."],
    ["go test ./... | tail -20", "'gogate' go test ./... | tail -20"],
    ["go test ./... 2>&1", "'gogate' go test ./... 2>&1"],
    ["cd pkg && go test ./...", "cd pkg && 'gogate' go test ./..."],
    ["go build ./... ; echo done", "'gogate' go build ./... ; echo done"],
    [
      "go test -run '^(TestA|TestB)$' ./...",
      "'gogate' go test -run '^(TestA|TestB)$' ./...",
    ],
    ['go test -run "A|B" ./...', "'gogate' go test -run \"A|B\" ./..."],
    // Same-dir build+test collapse to ONE gogate gate (gogate gates the whole package).
    ["go test ./... && go build ./...", "'gogate' go test ./..."],
    ["cd x && rtk go test -run Y ./... 2>&1 | head", "cd x && 'gogate' go test -run Y ./... 2>&1 | head"],
    ["go test ./... > out.txt", "'gogate' go test ./... > out.txt"],
    ["go test ./... | tee out.txt", "'gogate' go test ./... | tee out.txt"],
    // Mixed chain: a `go build` AND a `golangci-lint run` segment, both rtk- and
    // env-prefixed, with a trailing redirect+pipe — each recognized segment is
    // independently rtk-stripped and gogate-wrapped.
    [
      "cd /abs/path/plugin && GOWORK=off rtk go build ./... && GOWORK=off rtk golangci-lint run ./protoc-gen-bigquery/ 2>&1 | tail -15",
      "cd /abs/path/plugin && GOWORK=off 'gogate' go build ./... && GOWORK=off 'gogate' golangci-lint run ./protoc-gen-bigquery/ 2>&1 | tail -15",
    ],
  ])("wraps: %s", (cmd, want) => {
    expect(rewriteGoCommand(cmd, BIN)).toBe(want)
  })

  test("collapses a same-dir chain to one gate, carrying gogate flags", () => {
    expect(rewriteGoCommand("go build ./... && go test ./...", BIN, ["-rerun-fails=2"])).toBe(
      "'gogate' '-rerun-fails=2' go build ./...",
    )
  })

  // DEDUP: multiple recognized segments targeting the SAME directory collapse to ONE
  // gogate invocation (it gates the whole package regardless of subcommand). Collapse is
  // conservative — a duplicate is only dropped if its segment has no redirect and does not
  // feed a pipe; non-recognized segments (echo) are never dropped.
  test.each([
    ["go build ./... && golangci-lint run ./...", "'gogate' go build ./..."],
    [
      'go build ./... && echo "hello world" && golangci-lint run ./...',
      "'gogate' go build ./... && echo \"hello world\"",
    ],
    ["go build ./... && go test ./... && go vet ./...", "'gogate' go build ./..."],
    [
      "go build ./... && echo hi && go test ./... && echo bye && golangci-lint run ./...",
      "'gogate' go build ./... && echo hi && echo bye",
    ],
    [
      "go build ./x/... && go build ./y/...",
      "'gogate' go build ./x/... && 'gogate' go build ./y/...",
    ],
    [
      "GOWORK=off go build ./... && GOWORK=on go test ./...",
      "GOWORK=off 'gogate' go build ./... && GOWORK=on 'gogate' go test ./...",
    ],
    // Trailing pipe survives: the operator before the dropped dup is removed, so `| tail`
    // reconnects to the surviving gate.
    ["go build ./... && go test ./... | tail", "'gogate' go build ./... | tail"],
    ["go build ./... && go test ./... 2>&1 | tail -20", "'gogate' go build ./... | tail -20"],
  ])("dedups: %s", (cmd, want) => {
    expect(rewriteGoCommand(cmd, BIN)).toBe(want)
  })

  test("a dropped duplicate's own redirect is discarded with it", () => {
    expect(rewriteGoCommand("go build ./... && go test ./... > out.txt", BIN)).toBe(
      "'gogate' go build ./...",
    )
  })

  test.each([
    ["subshell", "go test $(ls)"],
    ["command substitution in quoted flag", 'go test -run "$(echo X)" ./...'],
    ["backtick substitution", "go test -run `date` ./..."],
    ["paren subshell", "(go test ./...)"],
    ["process substitution", "go test ./... > >(tee log)"],
    ["background", "go test ./... &"],
    ["background then command", "go test ./... & echo done"],
    ["newline", "go build\ngo test"],
    ["unterminated quote", 'go test -run "A ./...'],
    ["chain with no recognized segment", "cd x && ls && echo y"],
    ["rtk non-go command", "rtk deploy prod"],
    ["double semicolon", "foo ;; bar"],
    ["env value with quoted space", 'FOO="a b" go build ./...'],
    ["env prefix to a non-go command", "FOO=bar ls -la"],
    ["bare env assignment", "FOO=bar"],
    // Env peel must not defeat the already-gogate double-wrap guard.
    ["env prefix to already gogate", "GOWORK=off gogate go test ./..."],
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
