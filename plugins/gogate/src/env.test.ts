import { describe, expect, test } from "bun:test"
import { ENV_ASSIGN, peelLeadingEnv } from "./env"
import { tokenize } from "./tokenize"

describe("peelLeadingEnv", () => {
  test("peels a single leading assignment and returns the rest", () => {
    expect(peelLeadingEnv(tokenize("GOWORK=off go test ./..."))).toEqual({
      env: { GOWORK: "off" },
      rest: ["go", "test", "./..."],
    })
  })

  test("peels multiple leading assignments", () => {
    expect(peelLeadingEnv(tokenize("CGO_ENABLED=0 GOOS=linux go build ./..."))).toEqual({
      env: { CGO_ENABLED: "0", GOOS: "linux" },
      rest: ["go", "build", "./..."],
    })
  })

  test("empty value parses to an empty string", () => {
    expect(peelLeadingEnv(tokenize("FOO= go build ./..."))).toEqual({
      env: { FOO: "" },
      rest: ["go", "build", "./..."],
    })
  })

  test("splits on the first = so the value may contain =", () => {
    expect(peelLeadingEnv(tokenize("GOFLAGS=-mod=vendor go test ./..."))).toEqual({
      env: { GOFLAGS: "-mod=vendor" },
      rest: ["go", "test", "./..."],
    })
  })

  test("quoted/space value round-trips (tokenizer strips quotes)", () => {
    // GOFLAGS="-mod=vendor" → single token GOFLAGS=-mod=vendor; value after first =.
    expect(peelLeadingEnv(tokenize('GOFLAGS="-mod=vendor" go test ./...'))).toEqual({
      env: { GOFLAGS: "-mod=vendor" },
      rest: ["go", "test", "./..."],
    })
    // A quoted space value stays one token; the value keeps the (unquoted) space.
    expect(peelLeadingEnv(tokenize('FOO="a b" go build ./...'))).toEqual({
      env: { FOO: "a b" },
      rest: ["go", "build", "./..."],
    })
  })

  test.each([
    ["=foo", "leading ="],
    ["1FOO=bar", "name starts with a digit"],
  ])("does not peel malformed token %s (%s)", (bad) => {
    const { env, rest } = peelLeadingEnv(tokenize(`${bad} go test ./...`))
    expect(env).toEqual({})
    expect(rest).toEqual([bad, "go", "test", "./..."])
  })

  test("stops at the first non-assignment token", () => {
    expect(peelLeadingEnv(tokenize("GOWORK=off go test FOO=bar ./..."))).toEqual({
      env: { GOWORK: "off" },
      rest: ["go", "test", "FOO=bar", "./..."],
    })
  })

  test("no leading env returns empty env and the whole command", () => {
    expect(peelLeadingEnv(tokenize("go test ./..."))).toEqual({
      env: {},
      rest: ["go", "test", "./..."],
    })
  })

  test("empty input", () => {
    expect(peelLeadingEnv([])).toEqual({ env: {}, rest: [] })
  })
})

describe("ENV_ASSIGN / LEADING_ENV agree on the NAME set (anti-drift)", () => {
  // Derive the same NAME-portion rewrite.ts builds its whole-line LEADING_ENV from,
  // and assert both recognize exactly the same identifiers as a valid assignment NAME.
  const envName = ENV_ASSIGN.source.replace(/^\^/, "").replace(/=$/, "")
  const leadingEnv = new RegExp(`^(?:${envName}=\\S*)(?:\\s+${envName}=\\S*)*\\s*`)

  test.each([
    ["GOWORK=off", true],
    ["_X=1", true],
    ["A1_B=val", true],
    ["FOO=", true],
    ["=foo", false],
    ["1FOO=bar", false],
    ["FO-O=bar", false],
  ])("%s recognized as a leading assignment NAME = %s", (token, want) => {
    expect(ENV_ASSIGN.test(token)).toBe(want)
    // The whole-line form (used by the bash path) must agree on the NAME boundary.
    expect(leadingEnv.test(token)).toBe(want)
  })
})
