import { describe, expect, test } from "bun:test"
import { tokenize } from "./tokenize"

describe("tokenize", () => {
  test("splits on whitespace outside quotes", () => {
    expect(tokenize("go test -run TestX ./...")).toEqual(["go", "test", "-run", "TestX", "./..."])
  })

  test("keeps double-quoted args together and strips quotes", () => {
    expect(tokenize('go test -run "Test A" ./...')).toEqual([
      "go",
      "test",
      "-run",
      "Test A",
      "./...",
    ])
  })

  test("keeps single-quoted args together and strips quotes", () => {
    expect(tokenize("go test -run 'Test A|Test B' ./...")).toEqual([
      "go",
      "test",
      "-run",
      "Test A|Test B",
      "./...",
    ])
  })

  test("collapses repeated whitespace", () => {
    expect(tokenize("  go   test  ")).toEqual(["go", "test"])
  })

  test("returns empty array for blank input", () => {
    expect(tokenize("   ")).toEqual([])
  })

  test("preserves an empty quoted token", () => {
    expect(tokenize('go test -run ""')).toEqual(["go", "test", "-run", ""])
  })
})
