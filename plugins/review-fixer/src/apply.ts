// apply.ts — orchestrate reply + resolve across a batch of items. Pure
// decision logic; all I/O lives on the injected client (ClientLike — a
// subset of GithubClient, so tests can supply a plain object).
import type { Thread, ClientLike } from "./github"
import { filterThreads, threadMatchesAuthor } from "./report"

/** Scope passed to applyItems. */
export type ApplyScope = {
  owner: string
  repo: string
  pr: number
}

/** One input item: which thread, what to reply. */
export type ApplyItem = {
  threadId: string
  body: string
}

/** Argument bundle for applyItems. */
export type ApplyParams = {
  scope: ApplyScope
  threads: Thread[]
  author: string
  items: ApplyItem[]
}

/** Per-item outcome. `error` is set whenever a sub-call failed or item was unknown. */
export type ApplyItemResult = {
  threadId: string
  reply: "ok" | "fail" | "skip"
  resolve: "ok" | "skip" | "fail"
  error?: string
}

/** Summary of an apply pass. */
export type ApplyReport = {
  results: ApplyItemResult[]
  applied: number
  requested: number
  remaining: number
}

/** Internal mutable state shared between applyOne iterations. */
type ApplyState = {
  client: ClientLike
  scope: ApplyScope
  byID: Map<string, Thread>
}

/** Apply a batch of items against the supplied threads, posting replies + resolving. */
export async function applyItems(client: ClientLike, params: ApplyParams): Promise<ApplyReport> {
  const { scope, threads, author, items } = params
  const byID = new Map<string, Thread>()
  for (const t of threads) byID.set(t.id, t)
  const unresolvedAtStart = filterThreads(threads, author).length
  const state: ApplyState = { client, scope, byID }
  const results: ApplyItemResult[] = []
  let matchedApplied = 0
  let applied = 0

  for (const item of items) {
    const res = await applyOne(state, item)
    results.push(res)
    if (res.resolve === "ok") {
      applied++
      const t = byID.get(item.threadId)
      if (t && threadMatchesAuthor(t, author)) matchedApplied++
    }
  }

  return {
    results,
    applied,
    requested: items.length,
    remaining: Math.max(unresolvedAtStart - matchedApplied, 0),
  }
}

/** Process a single item. */
async function applyOne(state: ApplyState, item: ApplyItem): Promise<ApplyItemResult> {
  const { client, scope, byID } = state
  const t = byID.get(item.threadId)
  if (!t) return { threadId: item.threadId, reply: "skip", resolve: "skip", error: "unknown thread" }
  if (t.isResolved) return { threadId: item.threadId, reply: "skip", resolve: "skip" }

  try {
    await client.replyToComment({
      owner: scope.owner,
      repo: scope.repo,
      pr: scope.pr,
      commentID: t.rootCommentID,
      body: item.body,
    })
  } catch (e) {
    return { threadId: item.threadId, reply: "fail", resolve: "skip", error: e instanceof Error ? e.message : String(e) }
  }
  try {
    await client.resolveThread(t.id)
  } catch (e) {
    return { threadId: item.threadId, reply: "ok", resolve: "fail", error: e instanceof Error ? e.message : String(e) }
  }
  return { threadId: item.threadId, reply: "ok", resolve: "ok" }
}

/** Count items that cleanly no-op'd (skip/skip with no error). */
export function countSkipsOK(rep: ApplyReport): number {
  let n = 0
  for (const r of rep.results) {
    if (r.reply === "skip" && r.resolve === "skip" && !r.error) n++
  }
  return n
}
