import { tool, type Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import { resolveBinary } from "./resolve"
import { rewriteGoCommand } from "./rewrite"
import { tokenize } from "./tokenize"

// The gogate custom tool: shells out to the resolved gogate binary and returns a
// compact, structured TEXT report (model-friendly).
const gogateTool = tool({
  description:
    "Go quality gate returning a compact, structured TEXT report (model-friendly). Always " +
    "runs the full gate — go build, go test (with coverage), and golangci-lint, " +
    "short-circuiting test/lint if the build fails — and reports per-step status, parsed " +
    "diagnostics (file/line/col/message), test counts, and coverage.\n" +
    "Use this to verify/check Go code, run tests, or before committing — it replaces " +
    "running go build / go test / golangci-lint yourself. The result covers all three " +
    "steps, so do NOT re-run them; read `ok` and each step's `status`.\n" +
    "Build and lint always cover ./...; pass a `command` (a `go test ...`) to scope just " +
    "the test step, e.g. \"go test -run=TestX ./pkg/...\".",
  args: {
    command: tool.schema
      .string()
      .optional()
      .describe(
        "Optional `go test ...` command whose flags/packages scope the test step (e.g. " +
          "\"go test -run=TestX ./pkg/...\"). Build and lint still cover ./... Omit to " +
          "run the whole gate over ./...",
      ),
    rerunFails: tool.schema
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Re-run failed tests up to this many attempts until they pass (flaky-test guard). " +
          "Tests that only pass on re-run are reported in the step's `flaky` list.",
      ),
  },
  async execute(args, context) {
    const dir = context.directory

    let argv: string[]
    try {
      // First use may download + cache the binary from the GitHub Release.
      argv = await resolveBinary(dir)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return `gogate: could not install binary: ${message}`
    }

    // Request the compact text report — easier for the model to read than JSON.
    const flags = [...argv.slice(1), "-format=text"]
    if (args.rerunFails) flags.push(`-rerun-fails=${args.rerunFails}`)
    if (args.command) flags.push(...tokenize(args.command))

    const proc = await $`${argv[0]} ${flags}`.cwd(dir).quiet().nothrow()
    const stdout = proc.stdout.toString().trim()
    if (stdout) return stdout

    return `gogate produced no output (exit ${proc.exitCode}).\n${proc.stderr.toString()}`
  },
})

// readCommandField safely extracts the bash tool's `command` arg from the
// `output.args` payload opencode passes to `tool.execute.before`. Hooks types
// `args` as `any`; we narrow with runtime checks (no `as` / `!`) so the lint's
// unsafe-member-access rule stays satisfied even though the SDK type is open.
function readCommandField(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ""
  if (!("command" in args)) return ""
  const c = args.command
  return typeof c === "string" ? c : ""
}

// GoGate rewrites recognized Go toolchain commands (go build/test/vet, golangci-lint
// run) into a gogate invocation so the model gets structured output; everything else
// (go mod, go run, go get, ...) passes through untouched. Set GOGATE_MODE=off to disable.
// It also exposes the gogate custom tool directly.
//
// Plain `(input) => Promise.resolve({...})` (not `async`) so the `require-await`
// rule stays clean — the outer entry point does not await; only the inner hooks do.
export const GoGate: Plugin = ({ directory }) =>
  Promise.resolve({
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      if (process.env.GOGATE_MODE?.toLowerCase() === "off") return

      const cmd = readCommandField(output.args)

      let argv: string[]
      try {
        // First use may download + cache the binary from the GitHub Release. If that
        // fails, leave the model's bash command untouched rather than breaking it.
        argv = await resolveBinary(directory)
      } catch {
        return
      }

      // Emit the compact text report (easier for the model to read than JSON).
      const flags = ["-format=text"]
      // GOGATE_RERUN_FAILS=N re-runs failed tests up to N attempts (flaky-test guard).
      const rerun = process.env.GOGATE_RERUN_FAILS
      if (rerun && /^\d+$/.test(rerun)) flags.push(`-rerun-fails=${rerun}`)

      const rewritten = rewriteGoCommand(cmd, argv, flags)
      // Preserve the existing args object (the bash tool may carry other fields
      // like workdir/timeout); only overwrite `command` when we rewrote it.
      // Object.assign avoids an `as` cast while still mutating the live args
      // object the SDK reads back after the hook returns.
      if (rewritten && typeof output.args === "object" && output.args !== null) {
        Object.assign(output.args, { command: rewritten })
      }
    },
    tool: {
      gogate: gogateTool,
    },
  })

export default GoGate
