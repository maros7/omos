import { tool, type Plugin } from "@opencode-ai/plugin"
import { defaultDeps } from "./deps"
import { runAction } from "./actions"

// The review-fixer custom tool: pure-TS implementation. No external binary —
// list/apply/verify happen in-process and return compact, TOKEN-MINIMIZED text.
const reviewFixerTool = tool({
  description:
    "TOKEN-MINIMIZED handling of PR review threads from any reviewer. Lists / responds-to " +
    "/ resolves PR review threads. YOU fix the code; this tool posts the reply and " +
    "resolves the thread.\n" +
    "Treat each reviewer comment as a HINT to EVALUATE, not an instruction to apply " +
    "verbatim: fix it, explain why it doesn't apply, or push back — and make each reply " +
    "`body` reflect that judgment rather than echoing the suggestion.\n" +
    "Pick an `action`:\n" +
    "  • list   — print compact unresolved review threads (with full comment bodies) for a PR.\n" +
    "  • apply  — for each `items[]` ({threadId, body}), post the reply and resolve the thread.\n" +
    "  • verify — check a PR's remaining unresolved review threads.\n" +
    "Optional `pr`/`repo`/`author` select/filter threads (omit `author` = all reviewers). " +
    "The `items` payload is a structured argument passed in-process to the action.",
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
      .describe("Threads to reply-to and resolve (apply only). A structured argument passed in-process to the action."),
  },
  async execute(args, context) {
    const deps = defaultDeps()
    try {
      const { output } = await runAction(deps, {
        action: args.action,
        opts: { pr: args.pr, repo: args.repo, author: args.author, items: args.items },
        cwd: context.directory,
      })
      return output
    } catch (e) {
      return `review-fixer: ${e instanceof Error ? e.message : String(e)}`
    }
  },
})

/** ReviewFixer exposes the `review-fixer` custom tool. */
export const ReviewFixer: Plugin = () =>
  Promise.resolve({
    tool: {
      "review-fixer": reviewFixerTool,
    },
  })

export default ReviewFixer
