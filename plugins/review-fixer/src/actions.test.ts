// actions.test.ts — table-driven end-to-end wiring with a fake Deps.
import { test, expect, describe } from "bun:test"
import { expectGolden } from "../testdata/golden"
import { runAction } from "./actions"
import type { Deps, FetchLike, RunResult } from "./deps"

interface FakeDepsSpec {
  env?: Record<string, string | undefined>
  /** GraphQL response data (page 1) for listThreads. */
  listData?: unknown
  /** Reply / resolve outcomes keyed by URL substring. */
  routes?: Array<{ match: string | RegExp; status?: number; body?: unknown }>
}

function makeDeps(spec: FakeDepsSpec): { deps: Deps; fetchCalls: () => number } {
  let fetchCalls = 0
  const fetch: FetchLike = (input, init) => {
    fetchCalls++
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    // GraphQL default
    if (url.endsWith("/graphql")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: spec.listData ?? {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }
    for (const r of spec.routes ?? []) {
      const matched = r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match)
      if (matched) {
        return Promise.resolve(
          new Response(JSON.stringify(r.body ?? {}), {
            status: r.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        )
      }
    }
    void init
    return Promise.resolve(new Response("ok", { status: 200 }))
  }
  const deps: Deps = {
    env: {
      GH_TOKEN: "tok",
      ...(spec.env ?? {}),
    },
    fetch,
    runCmd: (args) => {
      const key = args.join(" ")
      if (key === "gh repo view --json nameWithOwner -q .nameWithOwner") {
        return Promise.resolve<RunResult>({ stdout: "acme/widgets\n", exitCode: 0 })
      }
      if (key === "git branch --show-current") return Promise.resolve<RunResult>({ stdout: "main\n", exitCode: 0 })
      if (key.startsWith("gh pr list")) return Promise.resolve<RunResult>({ stdout: "137\n", exitCode: 0 })
      return Promise.resolve<RunResult>({ stdout: "", exitCode: 1 })
    },
  }
  return { deps, fetchCalls: () => fetchCalls }
}

interface PageThread {
  id: string
  isResolved?: boolean
  path?: string
  line?: number
  databaseId?: number
  body?: string
  author?: string
}

function page(threads: PageThread[]): unknown {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: threads.map((t) => ({
            id: t.id,
            isResolved: t.isResolved ?? false,
            comments: {
              nodes: [
                {
                  databaseId: t.databaseId ?? 1738294501,
                  body: t.body ?? "",
                  author: { login: t.author ?? "copilot-pull-request-reviewer" },
                  path: t.path ?? "src/components/Button.tsx",
                  line: t.line ?? 47,
                },
              ],
            },
          })),
        },
      },
    },
  }
}

describe("runAction list", () => {
  test("happy end-to-end matches golden", async () => {
    const { deps } = makeDeps({
      listData: page([
        {
          id: "PRRT_kwDOABCD01EFGH2345",
          path: "src/components/Button.tsx",
          line: 47,
          author: "copilot-pull-request-reviewer",
          body: "Consider extracting this into a helper to avoid duplication across the call sites.",
        },
        {
          id: "PRRT_kwDOIJLM06NOPQ7890",
          path: "src/utils/format.ts",
          line: 0,
          author: "coderabbit-ai",
          body: "The npm install command in this section is missing the `--prefix` flag.",
          databaseId: 1738294502,
        },
      ]),
    })
    const { output, ok } = await runAction(deps, { action: "list", opts: { author: "" }, cwd: "/repo" })
    expect(ok).toBe(true)
    expectGolden("action-list", output)
  })
})

describe("runAction verify", () => {
  test("zero threads → ok=true", async () => {
    const { deps } = makeDeps({ listData: page([]) })
    const { output, ok } = await runAction(deps, { action: "verify", opts: {}, cwd: "/repo" })
    expect(ok).toBe(true)
    expect(output).toMatch(/0 unresolved thread\(s\)/)
  })
  test("non-zero threads → ok=false", async () => {
    const { deps } = makeDeps({
      listData: page([
        {
          id: "PRRT_kwDOABCD01EFGH2345",
          path: "src/components/Button.tsx",
          line: 47,
          body: "Consider extracting this into a helper.",
        },
      ]),
    })
    const { ok } = await runAction(deps, { action: "verify", opts: {}, cwd: "/repo" })
    expect(ok).toBe(false)
  })
})

describe("runAction apply", () => {
  test("empty items short-circuits, fetch NEVER called", async () => {
    const tracker = makeDeps({})
    const { output, ok } = await runAction(tracker.deps, {
      action: "apply",
      opts: { items: [] },
      cwd: "/repo",
    })
    expect(ok).toBe(true)
    expect(tracker.fetchCalls()).toBe(0)
    expectGolden("action-apply-empty", output)
  })

  test("happy apply matches golden", async () => {
    const { deps } = makeDeps({
      listData: page([
        {
          id: "PRRT_kwDOABCD01EFGH2345",
          path: "src/components/Button.tsx",
          line: 47,
          body: "Consider extracting this into a helper to avoid duplication across the call sites.",
          databaseId: 1738294501,
        },
      ]),
      routes: [
        { match: /\/replies$/, status: 201, body: { id: 1738294601 } },
        {
          match: "/graphql",
          status: 200,
          body: {
            data: {
              resolveReviewThread: { thread: { id: "PRRT_kwDOABCD01EFGH2345", isResolved: true } },
            },
          },
        },
      ],
    })
    const { output, ok } = await runAction(
      deps,
      {
        action: "apply",
        opts: {
          items: [
            {
              threadId: "PRRT_kwDOABCD01EFGH2345",
              body: "Fixed in abc1234 - extracted the helper into src/utils and added a null check.",
            },
          ],
        },
        cwd: "/repo",
      },
    )
    expect(ok).toBe(true)
    expectGolden("action-apply", output)
  })

  test("resolveToken throwing causes runAction to reject", async () => {
    const deps: Deps = {
      env: {}, // no token anywhere
      fetch: () => Promise.reject(new Error("no fetch")),
      runCmd: () => Promise.resolve<RunResult>({ stdout: "", exitCode: 1 }),
    }
    let err: Error | undefined
    try {
      await runAction(deps, { action: "list", opts: {}, cwd: "/repo" })
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err?.message).toMatch(/no GitHub token available|gh auth token failed/)
  })
})
