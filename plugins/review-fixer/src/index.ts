import { tool, type Plugin } from "@opencode-ai/plugin"
import { resolveBinary } from "./resolve"
import { buildCommandArgs, stdinPayload, type ReviewFixerArgs } from "./args"

// The review-fixer custom tool: shells out to the resolved review-fixer binary and
// returns its compact, TOKEN-MINIMIZED text output (model-friendly).
const reviewFixerTool = tool({
  description:
    "TOKEN-MINIMIZED handling of PR review threads from any reviewer. Lists / responds-to " +
    "/ resolves PR review threads. YOU fix the code; this tool posts the reply and " +
    "resolves the thread.\n" +
    "Pick an `action`:\n" +
    "  • list   — print compact unresolved review threads for a PR.\n" +
    "  • apply  — for each `items[]` ({threadId, body}), post the reply and resolve the thread.\n" +
    "  • verify — check a PR's remaining unresolved review threads.\n" +
    "Optional `pr`/`repo`/`author` select/filter threads (omit `author` = all reviewers). " +
    "The `items` payload is sent to the binary over stdin, never the command line.",
  args: {
    action: tool.schema
      .enum(["list", "apply", "verify"])
      .describe("Which review-fixer action to run."),
    pr: tool.schema
      .number()
      .int()
      .optional()
      .describe("Pull request number (list/apply/verify)."),
    repo: tool.schema
      .string()
      .optional()
      .describe("Repository as owner/name (list/apply/verify)."),
    author: tool.schema
      .string()
      .optional()
      .describe(
        "Substring filter on the thread originator's login (list/apply/verify); omit for all reviewers.",
      ),
    items: tool.schema
      .array(
        tool.schema.object({
          threadId: tool.schema.string().describe("Review thread id (PRRT_...) to resolve."),
          body: tool.schema.string().describe("Reply body to post before resolving."),
        }),
      )
      .optional()
      .describe("Threads to reply-to and resolve (apply only). Sent to the binary over stdin."),
  },
  async execute(args, context) {
    const dir = context.directory
    const a = args as ReviewFixerArgs

    let argv: string[]
    try {
      // First use may download + cache the binary from the GitHub Release.
      argv = await resolveBinary(dir)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return `review-fixer: could not install binary: ${message}`
    }

    const flags = [...argv.slice(1), ...buildCommandArgs(a)]
    const payload = stdinPayload(a)

    const proc = Bun.spawn([argv[0], ...flags], {
      cwd: dir,
      stdin: payload !== null ? new TextEncoder().encode(payload) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    const out = stdout.trim()
    if (out) return out

    const err = stderr.trim()
    if (err) return err
    return `review-fixer produced no output (exit ${exitCode}).`
  },
})

// ReviewFixer exposes the review-fixer custom tool. Unlike gogate it does not rewrite
// bash commands — only the tool registration + binary resolution are needed.
export const ReviewFixer: Plugin = async () => {
  return {
    tool: {
      "review-fixer": reviewFixerTool,
    },
  }
}

export default ReviewFixer
