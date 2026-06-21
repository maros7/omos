// resolve.ts — discover token / repo / PR from flags first, then environment,
// then the gh/git CLIs. Each resolver takes the Deps seam so tests can stub the
// world.
import type { Deps } from "./deps"

/** Resolve a GitHub token: flag → GH_TOKEN → GITHUB_TOKEN → `gh auth token`. */
export async function resolveToken(deps: Deps, flagToken?: string): Promise<string> {
  if (flagToken && flagToken.trim() !== "") return flagToken
  if (deps.env.GH_TOKEN && deps.env.GH_TOKEN.trim() !== "") return deps.env.GH_TOKEN
  if (deps.env.GITHUB_TOKEN && deps.env.GITHUB_TOKEN.trim() !== "") return deps.env.GITHUB_TOKEN
  const { stdout, exitCode } = await deps.runCmd(["gh", "auth", "token"])
  if (exitCode !== 0) throw new Error("resolve token: gh auth token failed")
  const tok = stdout.trim()
  if (tok === "") throw new Error("no GitHub token available (set GH_TOKEN, GITHUB_TOKEN, or run `gh auth login`)")
  return tok
}

/** Resolve the repo as owner/name: flag → `gh repo view`. */
export async function resolveRepo(
  deps: Deps,
  flagRepo?: string,
): Promise<{ owner: string; name: string }> {
  let spec: string
  if (flagRepo && flagRepo.trim() !== "") {
    spec = flagRepo.trim()
  } else {
    const { stdout, exitCode } = await deps.runCmd(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    if (exitCode !== 0) throw new Error("resolve repo: gh repo view failed")
    spec = stdout.trim()
  }
  const slash = spec.indexOf("/")
  // Both empty-owner ("/name") and empty-name ("owner/") collapse into the
  // same check: slash must be strictly between the ends.
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`invalid repo "${spec}": want owner/name`)
  }
  return { owner: spec.slice(0, slash), name: spec.slice(slash + 1) }
}

/** Resolve a PR number: flag → branch → `gh pr list --head <branch>`. */
export async function resolvePR(deps: Deps, cwd: string, flagPR?: number): Promise<number> {
  if (flagPR !== undefined && flagPR !== 0) return flagPR
  const { stdout: branchOut, exitCode: branchExit } = await deps.runCmd(["git", "branch", "--show-current"], { cwd })
  if (branchExit !== 0) throw new Error("resolve pr: not on a branch (detached HEAD?); pass pr")
  const branch = branchOut.trim()
  if (branch === "") throw new Error("resolve pr: not on a branch (detached HEAD?); pass pr")
  const { stdout: prOut, exitCode: prExit } = await deps.runCmd(
    ["gh", "pr", "list", "--head", branch, "--json", "number", "-q", ".[0].number"],
    { cwd },
  )
  if (prExit !== 0) throw new Error(`resolve pr: no open PR found for branch "${branch}"`)
  const s = prOut.trim()
  if (s === "") throw new Error(`resolve pr: no open PR found for branch "${branch}"`)
  const n = Number.parseInt(s, 10)
  if (Number.isNaN(n)) throw new Error(`resolve pr: parse "${s}" failed`)
  return n
}
