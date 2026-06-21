// deps.test.ts — table-driven coverage of the real defaultDeps. The runCmd
// cases shell out to real, harmless commands (printf / sh) so we exercise the
// spawn/stdout/exitCode wiring without mocks.
import { test, expect, describe } from "bun:test"
import { defaultDeps } from "./deps"

describe("defaultDeps", () => {
  test("env is process.env", () => {
    const d = defaultDeps()
    expect(d.env).toBe(process.env)
  })
  test("fetch is globalThis.fetch", () => {
    const d = defaultDeps()
    expect(d.fetch).toBe(globalThis.fetch)
  })
})

describe("defaultDeps().runCmd", () => {
  type Case =
    | { name: string; args: string[]; expectedStdoutContains: string; expectedExit: number }
    | { name: string; args: string[]; expectedStdoutContains: string; expectedExitNotZero: true }

  const cases: Case[] = [
    {
      name: "captures stdout via printf",
      args: ["printf", "hello"],
      expectedStdoutContains: "hello",
      expectedExit: 0,
    },
    {
      name: "captures multi-arg output via sh",
      args: ["sh", "-c", "echo via-sh"],
      expectedStdoutContains: "via-sh",
      expectedExit: 0,
    },
    {
      name: "captures non-zero exit code",
      args: ["sh", "-c", "exit 3"],
      expectedStdoutContains: "",
      expectedExit: 3,
    },
    {
      name: "missing binary returns non-zero without throwing",
      args: ["this-binary-does-not-exist-xyz"],
      expectedStdoutContains: "",
      expectedExitNotZero: true,
    },
  ]

  for (const c of cases) {
    test(c.name, async () => {
      const d = defaultDeps()
      const res = await d.runCmd([...c.args])
      expect(res.stdout).toContain(c.expectedStdoutContains)
      if ("expectedExit" in c) {
        expect(res.exitCode).toBe(c.expectedExit)
      } else {
        expect(res.exitCode).not.toBe(0)
      }
    })
  }

  test("empty args returns exitCode 1 without spawning (narrowing branch)", async () => {
    const d = defaultDeps()
    const res = await d.runCmd([])
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toBe("")
  })
})
