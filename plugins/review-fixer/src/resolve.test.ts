// resolve.test.ts — table-driven with a fake runCmd + env.
import { test, expect, describe } from "bun:test"
import { resolveToken, resolveRepo, resolvePR } from "./resolve"
import type { Deps, FetchLike, RunResult } from "./deps"

interface RunSpec {
  /** Map from argv joined by space → response. */
  responses: Record<string, { stdout: string; exitCode: number }>
}

function fakeDeps(env: Record<string, string | undefined>, spec: RunSpec): Deps {
  const fetch: FetchLike = () => Promise.reject(new Error("fetch should not be called from resolve"))
  return {
    env,
    fetch,
    runCmd: (args) => {
      const key = args.join(" ")
      const r = spec.responses[key]
      if (!r) return Promise.resolve<RunResult>({ stdout: "", exitCode: 1 })
      return Promise.resolve<RunResult>(r)
    },
  }
}

/** Resolve `await expect(p).rejects.toThrow(re)` without relying on bun's chained type. */
async function expectReject(p: Promise<unknown>, re: RegExp): Promise<void> {
  let err: Error | undefined
  try {
    await p
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e))
  }
  if (!err) throw new Error(`expected promise to reject matching ${re.toString()}, but it resolved`)
  expect(err.message).toMatch(re)
}

type TokenCase =
  | {
      name: string
      env: Record<string, string | undefined>
      flag?: string
      spec: RunSpec
      expected: string
    }
  | {
      name: string
      env: Record<string, string | undefined>
      flag?: string
      spec: RunSpec
      expectThrow: RegExp
    }

describe("resolveToken", () => {
  const cases: TokenCase[] = [
    {
      name: "flag wins",
      env: { GH_TOKEN: "gh", GITHUB_TOKEN: "g" },
      flag: "flagtok",
      spec: { responses: {} },
      expected: "flagtok",
    },
    {
      name: "GH_TOKEN next",
      env: { GH_TOKEN: "ghtok", GITHUB_TOKEN: "gtok" },
      spec: { responses: {} },
      expected: "ghtok",
    },
    {
      name: "GITHUB_TOKEN next",
      env: { GITHUB_TOKEN: "gtok" },
      spec: { responses: {} },
      expected: "gtok",
    },
    {
      name: "gh auth token fallback",
      env: {},
      spec: { responses: { "gh auth token": { stdout: "ghtoken\n", exitCode: 0 } } },
      expected: "ghtoken",
    },
    {
      name: "gh exit fail throws",
      env: {},
      spec: { responses: { "gh auth token": { stdout: "", exitCode: 1 } } },
      expectThrow: /resolve token: gh auth token failed/,
    },
    {
      name: "all empty throws",
      env: {},
      spec: { responses: { "gh auth token": { stdout: "\n", exitCode: 0 } } },
      expectThrow: /no GitHub token available/,
    },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      const deps = fakeDeps(c.env, c.spec)
      if ("expectThrow" in c) {
        await expectReject(resolveToken(deps, c.flag), c.expectThrow)
        return
      }
      expect(await resolveToken(deps, c.flag)).toBe(c.expected)
    })
  }
})

type RepoCase =
  | {
      name: string
      flag?: string
      spec: RunSpec
      expected: { owner: string; name: string }
    }
  | {
      name: string
      flag?: string
      spec: RunSpec
      expectThrow: RegExp
    }

describe("resolveRepo", () => {
  const cwd = "/repo"
  const cases: RepoCase[] = [
    {
      name: "flag spec split",
      flag: "maros7/omos",
      spec: { responses: {} },
      expected: { owner: "maros7", name: "omos" },
    },
    {
      name: "gh repo view fallback",
      spec: {
        responses: { "gh repo view --json nameWithOwner -q .nameWithOwner": { stdout: "octo/cat\n", exitCode: 0 } },
      },
      expected: { owner: "octo", name: "cat" },
    },
    {
      name: "gh repo view fail throws",
      spec: {
        responses: { "gh repo view --json nameWithOwner -q .nameWithOwner": { stdout: "", exitCode: 1 } },
      },
      expectThrow: /resolve repo: gh repo view failed/,
    },
    {
      name: "invalid spec no slash throws",
      flag: "nope",
      spec: { responses: {} },
      expectThrow: /invalid repo "nope"/,
    },
    {
      name: "empty owner throws",
      flag: "/repo",
      spec: { responses: {} },
      expectThrow: /invalid repo "\/repo"/,
    },
    {
      name: "empty name throws",
      flag: "owner/",
      spec: { responses: {} },
      expectThrow: /invalid repo "owner\/"/,
    },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      // Verifies runCmd carries cwd for the gh repo view call.
      const seenCwd: Array<string | undefined> = []
      const deps: Deps = {
        env: {},
        fetch: () => Promise.reject(new Error("no fetch")),
        runCmd: (args, opts) => {
          seenCwd.push(opts?.cwd)
          const key = args.join(" ")
          const r = c.spec.responses[key]
          if (!r) return Promise.resolve<RunResult>({ stdout: "", exitCode: 1 })
          return Promise.resolve<RunResult>(r)
        },
      }
      if ("expectThrow" in c) {
        await expectReject(resolveRepo(deps, cwd, c.flag), c.expectThrow)
        return
      }
      expect(await resolveRepo(deps, cwd, c.flag)).toEqual(c.expected)
      // gh repo view call (if any) carried cwd.
      for (const x of seenCwd) expect(x).toBe(cwd)
    })
  }
})

type PRCase =
  | {
      name: string
      flag: number
      spec: RunSpec
      expected: number
    }
  | {
      name: string
      flag: number
      spec: RunSpec
      expectThrow: RegExp
    }

describe("resolvePR", () => {
  const cwd = "/repo"
  const cases: PRCase[] = [
    {
      name: "flag (!==0) returned directly",
      flag: 99,
      spec: { responses: {} },
      expected: 99,
    },
    {
      name: "branch → gh pr list happy",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "feature\n", exitCode: 0 },
          "gh pr list --head feature --json number -q .[0].number": { stdout: "7\n", exitCode: 0 },
        },
      },
      expected: 7,
    },
    {
      name: "git branch empty (detached) throws",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "", exitCode: 1 },
        },
      },
      expectThrow: /resolve pr: not on a branch/,
    },
    {
      name: "git branch success but empty stdout throws detached",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "  \n", exitCode: 0 },
        },
      },
      expectThrow: /resolve pr: not on a branch/,
    },
    {
      name: "gh pr list empty throws no-open-PR",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "feature\n", exitCode: 0 },
          "gh pr list --head feature --json number -q .[0].number": { stdout: "", exitCode: 0 },
        },
      },
      expectThrow: /no open PR found for branch "feature"/,
    },
    {
      name: "gh pr list non-numeric throws parse",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "feature\n", exitCode: 0 },
          "gh pr list --head feature --json number -q .[0].number": { stdout: "not-a-num\n", exitCode: 0 },
        },
      },
      expectThrow: /parse "not-a-num" failed/,
    },
    {
      name: "gh pr list exit fail throws no-open-PR",
      flag: 0,
      spec: {
        responses: {
          "git branch --show-current": { stdout: "feature\n", exitCode: 0 },
          "gh pr list --head feature --json number -q .[0].number": { stdout: "", exitCode: 1 },
        },
      },
      expectThrow: /no open PR found for branch "feature"/,
    },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      // Verifies runCmd carries cwd for git/gh calls.
      const seenCwd: Array<string | undefined> = []
      const deps: Deps = {
        env: {},
        fetch: () => Promise.reject(new Error("no fetch")),
        runCmd: (args, opts) => {
          seenCwd.push(opts?.cwd)
          const key = args.join(" ")
          const r = c.spec.responses[key]
          if (!r) return Promise.resolve<RunResult>({ stdout: "", exitCode: 1 })
          return Promise.resolve<RunResult>(r)
        },
      }
      if ("expectThrow" in c) {
        await expectReject(resolvePR(deps, cwd, c.flag), c.expectThrow)
        expect(seenCwd[0]).toBe(cwd)
        return
      }
      expect(await resolvePR(deps, cwd, c.flag)).toBe(c.expected)
      if (c.flag === 0) {
        for (const x of seenCwd) expect(x).toBe(cwd)
      }
    })
  }
})
