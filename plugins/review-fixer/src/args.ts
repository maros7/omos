// buildCommandArgs translates the tool's structured args into the review-fixer
// binary's argv (after the binary path): the global `-format=text` (FIRST — the binary
// parses globals before the subcommand), the chosen subcommand, and only the flags
// relevant to that action.
//
// For `apply`, the `items` array is NOT passed as argv — it is streamed to the child's
// STDIN as JSON (see index.ts). Only -pr/-repo/-author appear on the command line.
//
// Missing flags are intentionally NOT validated here — they are passed through so the
// binary can return its own usage error (exit 2), which the tool surfaces verbatim.
export type ReviewFixerAction = "list" | "apply" | "verify"

export interface ReviewFixerItem {
  threadId: string
  body: string
}

export interface ReviewFixerArgs {
  action: ReviewFixerAction
  pr?: number
  repo?: string
  author?: string
  items?: ReviewFixerItem[]
}

export function buildCommandArgs(args: ReviewFixerArgs): string[] {
  // Globals first: the binary parses global flags before the subcommand.
  const argv: string[] = ["-format=text", args.action]

  // list, apply, and verify all accept the same selector flags. (apply's `items`
  // payload travels over STDIN, never argv.)
  if (args.pr !== undefined) argv.push("-pr", String(args.pr))
  if (args.repo !== undefined) argv.push("-repo", args.repo)
  if (args.author !== undefined) argv.push("-author", args.author)

  return argv
}

// stdinPayload returns the JSON the binary expects on STDIN for `apply` (the items to
// reply-to + resolve), or null when the action takes no stdin.
export function stdinPayload(args: ReviewFixerArgs): string | null {
  if (args.action !== "apply") return null
  return JSON.stringify(args.items ?? [])
}
