import { describe, expect, test } from "bun:test"
import { buildCommandArgs, stdinPayload } from "./args"

describe("buildCommandArgs", () => {
  test("always prefixes the global -format=text first, then the subcommand", () => {
    expect(buildCommandArgs({ action: "list" })).toEqual(["-format=text", "list"])
  })

  test("list builds pr/repo/author flags (globals first)", () => {
    expect(
      buildCommandArgs({ action: "list", pr: 42, repo: "owner/name", author: "copilot" }),
    ).toEqual(["-format=text", "list", "-pr", "42", "-repo", "owner/name", "-author", "copilot"])
  })

  test("verify builds pr/repo/author flags (globals first)", () => {
    expect(buildCommandArgs({ action: "verify", pr: 7, repo: "owner/name" })).toEqual([
      "-format=text",
      "verify",
      "-pr",
      "7",
      "-repo",
      "owner/name",
    ])
  })

  test("apply builds only pr/repo/author flags — items are NOT in argv", () => {
    const argv = buildCommandArgs({
      action: "apply",
      pr: 7,
      repo: "owner/name",
      author: "copilot",
      items: [{ threadId: "PRRT_abc", body: "done" }],
    })
    expect(argv).toEqual([
      "-format=text",
      "apply",
      "-pr",
      "7",
      "-repo",
      "owner/name",
      "-author",
      "copilot",
    ])
    // The items payload must never leak onto the command line.
    expect(argv.join(" ")).not.toContain("PRRT_abc")
    expect(argv.join(" ")).not.toContain("done")
  })

  test("passes through when fields are missing (binary handles usage error)", () => {
    expect(buildCommandArgs({ action: "apply" })).toEqual(["-format=text", "apply"])
    expect(buildCommandArgs({ action: "verify" })).toEqual(["-format=text", "verify"])
  })

  test("preserves pr=0 (does not treat zero as missing)", () => {
    expect(buildCommandArgs({ action: "verify", pr: 0 })).toEqual([
      "-format=text",
      "verify",
      "-pr",
      "0",
    ])
  })
})

describe("stdinPayload", () => {
  test("apply serializes items to JSON", () => {
    const items = [
      { threadId: "PRRT_abc", body: "fixed" },
      { threadId: "PRRT_def", body: "done" },
    ]
    expect(stdinPayload({ action: "apply", items })).toBe(JSON.stringify(items))
  })

  test("apply with no items serializes an empty array", () => {
    expect(stdinPayload({ action: "apply" })).toBe("[]")
  })

  test("list/verify take no stdin", () => {
    expect(stdinPayload({ action: "list" })).toBeNull()
    expect(stdinPayload({ action: "verify", items: [{ threadId: "x", body: "y" }] })).toBeNull()
  })
})
