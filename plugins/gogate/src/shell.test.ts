import { describe, expect, test } from "bun:test"
import { splitShell } from "./shell"

describe("splitShell", () => {
  test("splits on && at top level", () => {
    expect(splitShell("go build ./... && go test ./...")).toEqual({
      segments: ["go build ./... ", " go test ./..."],
      operators: ["&&"],
    })
  })

  test("splits on || at top level", () => {
    expect(splitShell("a || b")).toEqual({ segments: ["a ", " b"], operators: ["||"] })
  })

  test("splits on ; at top level", () => {
    expect(splitShell("a ; b")).toEqual({ segments: ["a ", " b"], operators: [";"] })
  })

  test("splits on | at top level", () => {
    expect(splitShell("a | b")).toEqual({ segments: ["a ", " b"], operators: ["|"] })
  })

  test("splits on |& at top level", () => {
    expect(splitShell("a |& b")).toEqual({ segments: ["a ", " b"], operators: ["|&"] })
  })

  test("does not split inside single quotes", () => {
    const r = splitShell("echo 'a && b | c'")
    expect(r?.segments).toEqual(["echo 'a && b | c'"])
    expect(r?.operators).toEqual([])
  })

  test("does not split inside double quotes", () => {
    const r = splitShell('echo "a | b"')
    expect(r?.segments).toEqual(['echo "a | b"'])
  })

  test("treats 2>&1 as a single segment", () => {
    expect(splitShell("go test ./... 2>&1")?.segments).toEqual(["go test ./... 2>&1"])
  })

  test("treats &>f as a single segment", () => {
    expect(splitShell("cmd &>f")?.segments).toEqual(["cmd &>f"])
  })

  test("treats >&2 as a single segment", () => {
    expect(splitShell("cmd >&2")?.segments).toEqual(["cmd >&2"])
  })

  test("treats >|f as a single segment", () => {
    expect(splitShell("cmd >|f")?.segments).toEqual(["cmd >|f"])
  })

  test("distinguishes || from |", () => {
    expect(splitShell("a || b | c")).toEqual({
      segments: ["a ", " b ", " c"],
      operators: ["||", "|"],
    })
  })

  test("distinguishes && from a lone & (lone & is null)", () => {
    expect(splitShell("a && b")?.operators).toEqual(["&&"])
    expect(splitShell("a & b")).toBeNull()
  })

  test("keeps a backslash-escaped operator char as part of the segment (no split)", () => {
    // The escaped space/pipe are consumed via the top-level backslash branch, so no
    // split occurs and lastNonSpace sees a real non-space char before the redirect.
    expect(splitShell("go test\\ ./x 2>&1")).toEqual({
      segments: ["go test\\ ./x 2>&1"],
      operators: [],
    })
  })

  test("escaped pipe at top level does not split", () => {
    expect(splitShell("a \\| b")).toEqual({ segments: ["a \\| b"], operators: [] })
  })

  test("honors backslash escapes inside double quotes (no split, no early return)", () => {
    const r = splitShell('echo "a\\"b | c"')
    expect(r?.segments).toEqual(['echo "a\\"b | c"'])
    expect(r?.operators).toEqual([])
  })

  test("lastNonSpace returns empty when only whitespace precedes a fd-dup attempt", () => {
    // Leading `|` with an empty buffer exercises lastNonSpace's loop-exhaustion path.
    expect(splitShell("  | b")).toEqual({ segments: ["  ", " b"], operators: ["|"] })
  })

  test.each([
    ["lone background &", "go test &"],
    ["double semicolon", "foo ;; bar"],
    ["backtick", "go test -run `date` ./..."],
    ["command substitution at top level", "go test $(ls)"],
    ["command substitution inside double quotes", 'go test "$(echo X)"'],
    ["open paren", "(go test ./...)"],
    ["close paren", "go test ./...)"],
    ["newline", "go build\ngo test"],
    ["unterminated single quote", "go test 'A"],
    ["unterminated double quote", 'go test "A'],
  ])("returns null for %s", (_name, input) => {
    expect(splitShell(input)).toBeNull()
  })

  test.each([
    ["exit status $?", 'echo "EXIT=$?"'],
    ["variable $VAR", "echo $VAR"],
    ["braced variable ${X}", "echo ${X}"],
  ])("does not return null for %s", (_name, input) => {
    expect(splitShell(input)).not.toBeNull()
  })
})
