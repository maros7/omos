// deps.ts — side-effect injection seam. Every external capability (env vars,
// network, subprocess) flows through `Deps` so tests can drive every branch
// deterministically without touching the real world.
import { spawn } from "node:child_process"

/**
 * Hard cap on any single I/O operation (subprocess OR HTTP request) so a hung
 * gh/git/api.github.com can't stall the tool. Mirrors Go's
 * `http.Client{Timeout: 30s}` (cli.go) + exec timeout.
 */
export const IO_TIMEOUT_MS = 30_000

/**
 * Minimal fetch signature. We don't need preconnect/keepalive/etc — just the
 * call shape — so tests can supply a plain async function.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Run-cmd result. */
export type RunResult = {
  stdout: string
  exitCode: number
}

/**
 * Deps: every side effect (env, network, subprocess) goes through here so tests
 * drive 100% of branches with zero real I/O. Kept as an `interface` because it
 * describes a behavioural contract implementations must satisfy.
 */
export interface Deps {
  /** Process environment (read-only view is enough). */
  env: Record<string, string | undefined>
  /** fetch implementation (GraphQL + REST). */
  fetch: FetchLike
  /** Run an external command (gh/git) capturing stdout. exitCode!==0 = failure; throws only for spawn-time errors. */
  runCmd: (args: string[], opts?: { cwd?: string }) => Promise<RunResult>
}

/** defaultDeps wires the real implementations. */
export function defaultDeps(): Deps {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    runCmd: (args, opts) =>
      new Promise<RunResult>((resolve) => {
        const cmd = args[0]
        if (!cmd) {
          resolve({ stdout: "", exitCode: 1 })
          return
        }
        // Default stdio="pipe"; piped stdin avoids @types/node ChildProcess union conflict.
        const child = spawn(cmd, args.slice(1), {
          cwd: opts?.cwd,
          timeout: IO_TIMEOUT_MS,
        })
        let stdout = ""
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8")
        })
        // Some platforms can emit both `error` and `close` for one process.
        // Guard so the promise settles exactly once; `.once` keeps each terminal
        // handler from firing twice on its own.
        let settled = false
        const settle = (result: RunResult): void => {
          if (settled) return
          settled = true
          resolve(result)
        }
        child.once("error", () => settle({ stdout, exitCode: 1 }))
        child.once("close", (code) => settle({ stdout, exitCode: code ?? 1 }))
      }),
  }
}
