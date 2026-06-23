import { describe, expect, test } from "bun:test"
import { scanCommand } from "./scan"

// head extracts the head from a non-bail scan, failing the test on an unexpected bail.
function head(cmd: string): string {
  const r = scanCommand(cmd)
  if ("bail" in r) throw new Error(`unexpected bail for: ${cmd}`)
  return r.head
}

function bailed(cmd: string): boolean {
  return "bail" in scanCommand(cmd)
}

describe("scanCommand — quote-aware selectors are never mangled", () => {
  test("single-quoted pipe in -run is kept", () => {
    expect(head("go test -run 'TestA|TestB' ./...")).toBe("go test -run 'TestA|TestB' ./...")
  })
  test("double-quoted pipe in -run is kept", () => {
    expect(head('go test -run "A|B" ./...')).toBe('go test -run "A|B" ./...')
  })
  test("double-quoted redirect/semicolon chars are literal", () => {
    expect(head('go test -run "A>B;C" ./...')).toBe('go test -run "A>B;C" ./...')
  })
})

describe("scanCommand — strips trailing output sinks", () => {
  test.each([
    ["go test ./... 2>&1 | tail -20", "go test ./..."],
    ["go build ./... > /dev/null 2>&1", "go build ./..."],
    ["go test ./... | grep -v ok | head", "go test ./..."],
    ["go test ./... > file", "go test ./..."],
    ["go test ./... >> file", "go test ./..."],
    ["go test ./... &> file", "go test ./..."],
    ["go test ./... | tee f", "go test ./..."],
    ["go test ./... | pbcopy", "go test ./..."],
    ["go test ./... |& tail", "go test ./..."],
    ["go test 2>&1", "go test"],
    ["go test 1>&2", "go test"],
    ["go test ./...>out", "go test ./..."],
  ])("%s -> %s", (cmd, want) => {
    expect(head(cmd)).toBe(want)
  })

  test("no sink leaves the whole command", () => {
    expect(head("go test -race ./...")).toBe("go test -race ./...")
  })

  test("escaped pipe is not a sink", () => {
    expect(head("go test ./... \\| x")).toBe("go test ./... \\| x")
  })

  test("backslash escape inside double quotes is consumed (not a sink/substitution)", () => {
    // The `\"` keeps the quote literal so the double-quoted run value spans `A"|B`;
    // the inner `|` must stay literal (exercises the in-quote backslash branch).
    expect(head('go test -run "A\\"|B" ./...')).toBe('go test -run "A\\"|B" ./...')
  })

  test("backslash before backtick inside double quotes is literal (no bail)", () => {
    expect(head('go test -run "a\\`b" ./...')).toBe('go test -run "a\\`b" ./...')
  })
})

describe("scanCommand — bails on unsafe constructs", () => {
  test.each([
    ["semicolon", "go test ./...; ls"],
    ["and-and", "go test ./... && echo done"],
    ["or-or", "go test ./... || echo fail"],
    ["substitution", "go test $(cmd)"],
    ["backtick", "go test `cmd`"],
    ["background", "go test ./... &"],
    ["here-string", "go test ./... < input"],
    ["subshell open", "(go test ./...)"],
    ["newline", "go test ./...\nls"],
    ["substitution in double quotes", 'go test -run "$(cmd)" ./...'],
  ])("bails on %s", (_name, cmd) => {
    expect(bailed(cmd)).toBe(true)
  })
})
