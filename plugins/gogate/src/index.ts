import { tool, type Plugin } from "@opencode-ai/plugin"
import { $ } from "bun"
import { statSync } from "node:fs"
import path from "node:path"
import { peelLeadingEnv } from "./env"
import { resolveBinary } from "./resolve"
import { rewriteGoCommand } from "./rewrite"
import { scanCommand } from "./scan"
import { tokenize } from "./tokenize"

// The gogate custom tool: shells out to the resolved gogate binary and returns a
// compact, structured TEXT report (model-friendly).
export const gogateTool = tool({
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
          "run the whole gate over ./... You may prefix the command with one or more " +
          "`VAR=val` env assignments (e.g. `GOWORK=off`, `GOFLAGS=...`, `GOPRIVATE=...`); " +
          "they scope the WHOLE gate (build+test+lint), e.g. " +
          "\"GOWORK=off go test ./pkg/...\". Don't pipe or redirect — a trailing " +
          "`| tail`/`> file`/`2>&1` is auto-stripped (the report is already compact); " +
          "compound commands (`;`, `&&`, substitution) are rejected.",
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
    directory: tool.schema
      .string()
      .optional()
      .describe(
        "Run the whole gate (build+test+lint) inside this directory — use for a nested " +
          "Go module / subdirectory, e.g. `plugin/`. Relative to the project root.",
      ),
  },
  async execute(args, context) {
    const dir = context.directory

    // Scan the raw command BEFORE tokenize (which strips quotes, hiding a real `|` vs a
    // `-run 'A|B'` selector). A trailing output sink (`| tail`, `> file`, `2>&1`) is
    // stripped — gogate's report is already canonical/compact — and a compound command
    // (`;`, `&&`, substitution, redirects-with-extra) is rejected.
    let commandHead = ""
    if (args.command) {
      const scanned = scanCommand(args.command)
      if ("bail" in scanned) {
        return (
          "gogate: command must be a single go/golangci-lint command without shell " +
          "operators (;, &&, ||, pipes-with-substitution, redirects)"
        )
      }
      commandHead = scanned.head
    }

    // Resolve the run dir to an absolute path. An empty/whitespace `directory` must
    // normalize to "." (the project root) — `?? "."` is not enough (it keeps ""), so a
    // trimmed empty string falls back to ".".
    const requested = args.directory?.trim() ?? ""
    const runDir = path.resolve(dir, requested.length > 0 ? requested : ".")

    // The run dir must stay within the project root; a `..`-escaping or absolute
    // relative path is rejected before the binary is ever invoked.
    const rel = path.relative(dir, runDir)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `gogate: directory escapes project root: ${args.directory}`
    }

    // The run dir must exist and be a directory.
    let isDir = false
    try {
      isDir = statSync(runDir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      return `gogate: directory not found: ${args.directory}`
    }

    let argv: string[]
    try {
      // First use may download + cache the binary from the GitHub Release. Binary
      // resolution stays anchored at the project root, not the run dir.
      argv = await resolveBinary(dir)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return `gogate: could not install binary: ${message}`
    }

    // Request the compact text report — easier for the model to read than JSON.
    // `-dir` runs the whole gate inside runDir (always passed; default "." → root).
    const flags = [...argv.slice(1), "-format=text", "-dir", runDir]
    if (args.rerunFails) flags.push(`-rerun-fails=${args.rerunFails}`)

    // Peel any leading `VAR=val` env assignments from the command (parity with the
    // bash-rewrite path) and apply them to the gate subprocess; only the remaining
    // tokens (`rest`) scope the test step. Env must NOT influence binary resolution,
    // hence this runs after resolveBinary above.
    const { env: parsedEnv, rest } = peelLeadingEnv(commandHead ? tokenize(commandHead) : [])
    if (rest.length > 0) flags.push(...rest)

    // Bun's `.env()` REPLACES the whole environment, so spread process.env first (else
    // PATH/HOME vanish and `go` can't be found); parsedEnv wins on conflict.
    const childEnv = { ...process.env, ...parsedEnv }

    const proc = await $`${argv[0]} ${flags}`.cwd(dir).env(childEnv).quiet().nothrow()
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

// rewriteDisabled reports whether the bash REWRITE hook should be skipped, via either
// lever (the explicit `gogate` tool is unaffected):
//   - GOGATE_MODE=off
//   - GOGATE_DISABLED set to a non-empty value other than "0" (e.g. 1, true, yes); "0"
//     and unset/empty leave the rewrite enabled.
export function rewriteDisabled(env: Record<string, string | undefined>): boolean {
  if (env.GOGATE_MODE?.toLowerCase() === "off") return true
  const disabled = env.GOGATE_DISABLED
  return disabled !== undefined && disabled !== "" && disabled !== "0"
}

// GoGate rewrites recognized Go toolchain commands (go build/test/vet, golangci-lint
// run) into a gogate invocation so the model gets structured output; everything else
// (go mod, go run, go get, ...) passes through untouched. Recognized commands are
// wrapped IN PLACE (see rewrite.ts): the surrounding shell structure — pipes,
// redirects, chains, `cd …` — is preserved verbatim, redundant same-dir gates collapse
// to one, and a leading `rtk` is stripped. (Trailing-sink stripping is the custom
// TOOL's behavior, via scanCommand in execute() — not the bash rewrite.)
//
// Two levers disable the bash REWRITE (the explicit `gogate` tool still works):
//   - GOGATE_MODE=off
//   - GOGATE_DISABLED set to any non-empty value other than "0" (e.g. 1, true, yes)
// It also exposes the gogate custom tool directly.
//
// Plain `(input) => Promise.resolve({...})` (not `async`) so the `require-await`
// rule stays clean — the outer entry point does not await; only the inner hooks do.
export const GoGate: Plugin = ({ directory }) =>
  Promise.resolve({
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      if (rewriteDisabled(process.env)) return

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
