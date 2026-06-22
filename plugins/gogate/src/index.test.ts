import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { gogateTool, rewriteDisabled } from "./index"

// A minimal ToolContext for the custom tool: only `directory` is read by execute.
function ctx(directory: string): ToolContext {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: () => Promise.resolve(),
  }
}

function asString(result: Awaited<ReturnType<typeof gogateTool.execute>>): string {
  return typeof result === "string" ? result : result.output
}

describe("gogateTool directory arg", () => {
  test("valid nested dir produces an absolute -dir flag", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    const sub = mkdtempSync(path.join(root, "sub-"))
    const rel = path.basename(sub)

    // /bin/echo as the binary just prints the flags it receives, so we can assert
    // the -dir flag is passed with the resolved absolute path.
    process.env.GOGATE_BIN = "/bin/echo"
    try {
      const out = asString(await gogateTool.execute({ directory: rel }, ctx(root)))
      expect(out).toContain("-format=text")
      expect(out).toContain(`-dir ${sub}`)
    } finally {
      delete process.env.GOGATE_BIN
    }
  })

  test("rejects a directory that escapes the project root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    const out = asString(await gogateTool.execute({ directory: "../foo" }, ctx(root)))
    expect(out).toBe("gogate: directory escapes project root: ../foo")
  })

  test("rejects a non-existent directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    const out = asString(await gogateTool.execute({ directory: "nope-does-not-exist" }, ctx(root)))
    expect(out).toBe("gogate: directory not found: nope-does-not-exist")
  })
})

// envProbe writes a tiny executable that prints the env vars of interest plus the args
// it received, so the tool path's env/flag handling is observable end-to-end.
function envProbe(root: string): string {
  const probe = path.join(root, "probe.sh")
  writeFileSync(
    probe,
    '#!/bin/sh\necho "GOWORK=$GOWORK"\necho "PATH_PRESENT=${PATH:+yes}"\necho "ARGS=$*"\n',
  )
  chmodSync(probe, 0o755)
  return probe
}

describe("gogateTool command env assignments", () => {
  test("applies a leading GOWORK=off to the gate env and strips it from the command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    process.env.GOGATE_BIN = envProbe(root)
    try {
      const out = asString(
        await gogateTool.execute({ command: "GOWORK=off go test ./..." }, ctx(root)),
      )
      // The env assignment reaches the gate subprocess...
      expect(out).toContain("GOWORK=off")
      // ...PATH survives (env is an overlay of process.env, not a replacement)...
      expect(out).toContain("PATH_PRESENT=yes")
      // ...and the binary receives the command WITHOUT the GOWORK=off token.
      expect(out).toContain("ARGS=")
      const argsLine = out.split("\n").find((l) => l.startsWith("ARGS=")) ?? ""
      expect(argsLine).toContain("go test ./...")
      expect(argsLine).not.toContain("GOWORK=off")
    } finally {
      delete process.env.GOGATE_BIN
    }
  })
})

describe("gogateTool command sink stripping / bail", () => {
  test("strips a trailing pipe from the command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    process.env.GOGATE_BIN = "/bin/echo"
    try {
      const out = asString(await gogateTool.execute({ command: "go test ./... | tail" }, ctx(root)))
      const line = out.trim()
      expect(line).toContain("go test ./...")
      expect(line).not.toContain("| tail")
      expect(line).not.toContain("tail")
    } finally {
      delete process.env.GOGATE_BIN
    }
  })

  test("rejects a compound command with the bail error", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gogate-root-"))
    const out = asString(await gogateTool.execute({ command: "cd x && go test" }, ctx(root)))
    expect(out).toBe(
      "gogate: command must be a single go/golangci-lint command without shell " +
        "operators (;, &&, ||, pipes-with-substitution, redirects)",
    )
  })
})

describe("rewriteDisabled — bash-rewrite disable levers", () => {
  test.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["off", true],
    ["0", false],
    ["", false],
  ])("GOGATE_DISABLED=%j -> disabled=%s", (val, want) => {
    expect(rewriteDisabled({ GOGATE_DISABLED: val })).toBe(want)
  })

  test("unset GOGATE_DISABLED leaves the rewrite enabled", () => {
    expect(rewriteDisabled({})).toBe(false)
  })

  test("GOGATE_MODE=off still disables the rewrite", () => {
    expect(rewriteDisabled({ GOGATE_MODE: "off" })).toBe(true)
    expect(rewriteDisabled({ GOGATE_MODE: "OFF" })).toBe(true)
  })

  test("levers are independent: MODE off wins even with DISABLED=0", () => {
    expect(rewriteDisabled({ GOGATE_MODE: "off", GOGATE_DISABLED: "0" })).toBe(true)
  })
})
