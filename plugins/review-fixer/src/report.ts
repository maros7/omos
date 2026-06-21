// report.ts — pure rendering + filtering. No I/O, no async, no deps: every
// function here is trivially table-testable and produces the byte-exact text
// the model sees.
import type { Thread } from "./github"
import type { ApplyReport, ApplyItemResult } from "./apply"
import { clip, MAX_BODY_LEN } from "./text"

// Re-export so existing call sites (`import { MAX_BODY_LEN } from "./report"`)
// keep working without churning the test imports.
export { MAX_BODY_LEN }

/** Argument bundle for renderList / renderVerify (4 fields would exceed max-params=3). */
export type RenderArgs = {
  pr: number
  owner: string
  repo: string
  threads: Thread[]
}

/** True if the thread author contains `author` (case-insensitive). "" → true. */
export function threadMatchesAuthor(t: Thread, author: string): boolean {
  if (author === "") return true
  return t.author.toLowerCase().includes(author.toLowerCase())
}

/** True if the thread should be reported: unresolved AND author matches. */
export function filterThreads(threads: Thread[], author: string): Thread[] {
  return threads.filter((t) => !t.isResolved && threadMatchesAuthor(t, author))
}

/** Render the file:line label for a thread: "-" if no path, `path:line` if line>0, else path. */
export function threadLoc(t: Thread): string {
  if (t.path === "") return "-"
  if (t.line > 0) return `${t.path}:${t.line}`
  return t.path
}

/** First non-empty trimmed line of `s`, capped at MAX_BODY_LEN bytes (matches Go report.go:30). */
export function firstLine(s: string): string {
  for (const raw of s.split("\n")) {
    const t = raw.trim()
    if (t !== "") return clip(t, MAX_BODY_LEN)
  }
  return ""
}

/** Render the indented body block. */
function renderBody(body: string): string {
  if (firstLine(body) === "") return "    (no comment body)\n"
  const capped = clip(body, MAX_BODY_LEN)
  let out = ""
  for (const raw of capped.replace(/\n+$/, "").split("\n")) {
    const line = raw.replace(/[ \t\r]+$/, "")
    out += line === "" ? "\n" : `    ${line}\n`
  }
  return out
}

/**
 * renderList — byte-exact compact list of unresolved threads. Format:
 * ```
 * PR #{pr} {owner}/{repo}: {n} unresolved thread(s)\n
 * [{i+1}] {id}  {loc}  ({author}){replyMarker}\n
 * <renderBody>
 * ```
 */
export function renderList(args: RenderArgs): string {
  const { pr, owner, repo, threads } = args
  const lines: string[] = [`PR #${pr} ${owner}/${repo}: ${threads.length} unresolved thread(s)\n`]
  threads.forEach((t, i) => {
    const replyMarker = t.replies > 0 ? `  +${t.replies}` : ""
    lines.push(`[${i + 1}] ${t.id}  ${threadLoc(t)}  (${t.author})${replyMarker}\n`)
    lines.push(renderBody(t.body))
  })
  return lines.join("")
}

/**
 * renderVerify — byte-exact count + bare-id view (matches Go report.go:177).
 * Format:
 * ```
 * PR #{pr} {owner}/{repo}: {n} unresolved thread(s)\n
 * {per thread}: {id}\n
 * ```
 */
export function renderVerify(args: RenderArgs): string {
  const { pr, owner, repo, threads } = args
  const lines: string[] = [`PR #${pr} ${owner}/${repo}: ${threads.length} unresolved thread(s)\n`]
  for (const t of threads) lines.push(`${t.id}\n`)
  return lines.join("")
}

/** Render a single apply result line (used by renderApply). */
export function applyLine(r: ApplyItemResult): string {
  if (r.reply === "fail") return `reply-fail ${r.threadId}: ${r.error}`
  if (r.resolve === "fail") return `resolve-fail ${r.threadId}: ${r.error}`
  if (r.reply === "skip") return `skip ${r.threadId} (${r.error ?? "already resolved"})`
  return `ok ${r.threadId}`
}

/** Render an ApplyReport. */
export function renderApply(rep: ApplyReport): string {
  const lines: string[] = []
  for (const r of rep.results) lines.push(`${applyLine(r)}\n`)
  lines.push(`applied ${rep.applied}/${rep.requested}; remaining unresolved: ${rep.remaining}\n`)
  return lines.join("")
}
