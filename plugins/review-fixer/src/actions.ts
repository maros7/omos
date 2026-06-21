// actions.ts — top-level wiring. Resolves token/repo/PR, builds the client,
// dispatches to list/verify/apply, and returns the rendered text + ok flag.
import type { Deps } from "./deps"
import { GithubClient } from "./github"
import { resolveToken, resolveRepo, resolvePR } from "./resolve"
import { renderList, renderVerify, renderApply, filterThreads } from "./report"
import { applyItems, countSkipsOK, type ApplyItem } from "./apply"

/** Options forwarded from the tool args. */
export type ActionOptions = {
  pr?: number
  repo?: string
  author?: string
  items?: ApplyItem[]
}

/** Argument bundle for runAction (4 fields would exceed max-params=3). */
export type RunParams = {
  action: "list" | "apply" | "verify"
  opts: ActionOptions
  cwd: string
}

/** runAction: run one of list/apply/verify end-to-end. Throws on env/CLI/API errors. */
export async function runAction(
  deps: Deps,
  params: RunParams,
): Promise<{ output: string; ok: boolean }> {
  const { action, opts, cwd } = params
  // Empty apply is a pure no-op — no auth, no git/gh, no fetch (matches Go CLI).
  if (action === "apply" && (opts.items ?? []).length === 0) {
    return { output: renderApply({ results: [], applied: 0, requested: 0, remaining: 0 }), ok: true }
  }
  const token = await resolveToken(deps)
  // :ponytail: plugin-only adaptation — Go's CLI exposes this via `-api-base`,
  // but the opencode tool surface has no flags, so we fall back to env. Set
  // GITHUB_API_BASE to point at GitHub Enterprise (e.g. https://github.example/api/v3).
  const apiBase = deps.env.GITHUB_API_BASE ?? "https://api.github.com"
  const client = new GithubClient({ token, apiBase, fetch: deps.fetch })
  const { owner, name } = await resolveRepo(deps, opts.repo)
  const pr = await resolvePR(deps, cwd, opts.pr)
  const author = opts.author ?? ""

  if (action === "list") {
    const threads = await client.listThreads(owner, name, pr)
    const matched = filterThreads(threads, author)
    return { output: renderList({ pr, owner, repo: name, threads: matched }), ok: true }
  }

  if (action === "verify") {
    const threads = await client.listThreads(owner, name, pr)
    const matched = filterThreads(threads, author)
    return { output: renderVerify({ pr, owner, repo: name, threads: matched }), ok: matched.length === 0 }
  }

  // action === "apply" (empty case handled above before auth)
  const items = opts.items ?? []
  const threads = await client.listThreads(owner, name, pr)
  const rep = await applyItems(client, { scope: { owner, repo: name, pr }, threads, author, items })
  const output = renderApply(rep)
  const ok = rep.applied + countSkipsOK(rep) >= rep.requested
  return { output, ok }
}
