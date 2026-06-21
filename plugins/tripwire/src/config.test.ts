import { describe, expect, test } from "bun:test"
import { merge, parseJsonc } from "./config"

describe("parseJsonc", () => {
  test("parses plain JSON", () => {
    expect(parseJsonc('{"a":1,"b":[1,2,3]}')).toEqual({ a: 1, b: [1, 2, 3] })
  })

  test("strips line comments", () => {
    expect(parseJsonc('{\n"a": 1, // trailing\n"b": 2\n}')).toEqual({ a: 1, b: 2 })
  })

  test("strips block comments", () => {
    expect(parseJsonc('{\n"a": /* inline */ 1\n}')).toEqual({ a: 1 })
  })

  test("does not treat // or /* inside strings as comments", () => {
    expect(parseJsonc('{"url":"https://example.com","re":"a/*b"}')).toEqual({
      url: "https://example.com",
      re: "a/*b",
    })
  })

  test("preserves escaped quotes in strings", () => {
    expect(parseJsonc('{"msg":"she said \\"hi\\""}')).toEqual({ msg: 'she said "hi"' })
  })

  // Trailing-comma stripping — the regression this guards against is that the
  // stripper only skipped whitespace, not comments, between the comma and the
  // closing bracket. Table-driven so each combination is explicit.
  const cases: Array<[name: string, input: string, expected: unknown]> = [
    ["plain trailing comma (object)", `{"a":1,}`, { a: 1 }],
    ["plain trailing comma (array)", `[1,2,3,]`, [1, 2, 3]],
    ["trailing comma + line comment", `{"a":1, // trailing\n}`, { a: 1 }],
    ["trailing comma + block comment", `{"a":1, /* trailing */ }`, { a: 1 }],
    ["trailing comma + block comment, no inner space", `{"a":1,/*x*/}`, { a: 1 }],
    ["trailing comma + mixed trivia (ws, line, ws)", `{"a":1,\n  // hi\n }`, { a: 1 }],
    ["trailing comma + block comment spanning lines", `{"a":1,\n  /* a\n   * b\n   */\n}`, { a: 1 }],
    ["nested object trailing comma", `{"outer":{"inner":1,}}`, { outer: { inner: 1 } }],
    ["nested array trailing comma", `{"arr":[1,2,[3,],]}`, { arr: [1, 2, [3]] }],
    ["nested array trailing comma + block comment", `{"arr":[1,2,/* c */]}`, { arr: [1, 2] }],
    ["deeply nested with multiple trailing commas", `{"a":[1,{"b":[2,],},]}`, { a: [1, { b: [2] }] }],
    ["keeps non-trailing comma after line comment", `{"a":1,\n"b":2}`, { a: 1, b: 2 }],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(parseJsonc(input)).toEqual(expected)
    })
  }
})

describe("merge", () => {
  test("overrides scalar values", () => {
    expect(merge({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 })
  })

  test("deep-merges nested objects", () => {
    expect(merge({ n: { x: 1, y: 2 } }, { n: { y: 9 } })).toEqual({ n: { x: 1, y: 9 } })
  })

  test("replaces arrays wholesale (no index merge)", () => {
    expect(merge({ arr: [1, 2, 3] }, { arr: [9] })).toEqual({ arr: [9] })
  })

  test("returns base when override is null/undefined (no delete sentinel)", () => {
    // This is the documented behavior: explicit null means "keep base".
    const base = { n: { x: 1 } }
    expect(merge(base, null)).toBe(base)
    expect(merge(base, undefined)).toBe(base)
  })

  test("explicit null on a nested key keeps the base subtree", () => {
    // Locking in the documented contract: a user CANNOT null-out a nested
    // config block. merge recurses with over[k]=null, which early-returns base.
    const base = { budgets: { cost: { warn: 5, hard: 12 } }, onHard: "abort" as const }
    const merged = merge(base, { budgets: null })
    expect(merged).toEqual(base) // budgets subtree is untouched, NOT deleted
    expect(merged.budgets).toEqual({ cost: { warn: 5, hard: 12 } })
  })

  test("scalar 0 / empty string / false ARE applied (not treated as null)", () => {
    expect(merge({ a: 1 }, { a: 0 })).toEqual({ a: 0 })
    expect(merge({ a: "x" }, { a: "" })).toEqual({ a: "" })
    expect(merge({ a: true }, { a: false })).toEqual({ a: false })
  })

  test("adds new keys from override", () => {
    expect(merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 })
  })
})
