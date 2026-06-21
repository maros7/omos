// integration.test.ts — wires the REAL GithubClient against a fake fetch and
// runs the full applyOne → applyItems → renderApply chain so the goldens
// capture the byte-exact wrapped error prefixes production emits (reply:
// status N: msg, resolve: graphql: msg) instead of synthetic stand-ins.
import { test, expect, describe } from "bun:test"
import { expectGolden } from "../testdata/golden"
import { GithubClient } from "./github"
import { applyItems } from "./apply"
import { renderApply } from "./report"
import type { FetchLike } from "./deps"
import type { Thread } from "./github"

/** A tiny fetch router: matches on URL substring, returns canned Response. */
type Route = {
  match: string | RegExp
  respond: () => Response
}

function fakeFetch(routes: Route[]): FetchLike {
  return (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    for (const r of routes) {
      const matched = r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match)
      if (matched) return Promise.resolve(r.respond())
    }
    return Promise.reject(new Error(`no route matched ${url}`))
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Single-thread GraphQL page response. Realistic-shape but obfuscated. */
function pageWithThread(t: {
  id: string
  databaseId: number
  path?: string
  line?: number
  body?: string
}): unknown {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: t.id,
              isResolved: false,
              comments: {
                nodes: [
                  {
                    databaseId: t.databaseId,
                    body: t.body ?? "Consider extracting this into a helper to avoid duplication across the call sites.",
                    author: { login: "copilot-pull-request-reviewer" },
                    path: t.path ?? "src/components/Button.tsx",
                    line: t.line ?? 47,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  }
}

const SCOPE = { owner: "acme", repo: "widgets", pr: 137 }

/** Realistic-shape thread IDs (base64-style, modeled after real PRRT_kwDO…). */
const TID_REPLY = "PRRT_kwDOreply0fail0001"
const TID_RESOLVE = "PRRT_kwDOreslv0fail0002"

describe("integration: real GithubClient → applyItems → renderApply", () => {
  test("reply-fail (HTTP 401) surfaces `reply: status 401: …` in the golden", async () => {
    const fetch = fakeFetch([
      // First call is listThreads (GraphQL) — succeeds.
      { match: "/graphql", respond: () => json({ data: pageWithThread({ id: TID_REPLY, databaseId: 1738294501 }) }) },
      // Reply REST call returns 401 with a realistic GitHub error envelope.
      {
        match: "/replies",
        respond: () =>
          new Response(
            JSON.stringify({
              message: "Bad credentials",
              documentation_url: "https://docs.github.com/rest",
              status: "401",
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      },
    ])
    const client = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    const threads: Thread[] = await client.listThreads("acme", "widgets", 137)
    const rep = await applyItems(client, {
      scope: SCOPE,
      threads,
      author: "",
      items: [
        {
          threadId: TID_REPLY,
          body: "Fixed in abc1234 - extracted the helper and added a null check.",
        },
      ],
    })
    expect(rep.results[0]?.reply).toBe("fail")
    expect(rep.results[0]?.error).toMatch(/^reply: status 401:/)
    expectGolden("integration-reply-fail", renderApply(rep))
  })

  test("resolve-fail (graphql errors[]) surfaces `resolve: graphql: …` in the golden", async () => {
    let listCallCount = 0
    const fetch = fakeFetch([
      {
        match: "/graphql",
        respond: () => {
          listCallCount++
          // First graphql call is listThreads → success.
          if (listCallCount === 1) {
            return json({ data: pageWithThread({ id: TID_RESOLVE, databaseId: 1738294502 }) })
          }
          // Second graphql call is resolveThread → errors[] with a realistic
          // GitHub GraphQL "Resource not accessible" message.
          return json({ errors: [{ message: "Resource not accessible by integration" }] })
        },
      },
      // Reply REST call succeeds.
      { match: "/replies", respond: () => json({ id: 1738294602 }, 201) },
    ])
    const client = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    const threads: Thread[] = await client.listThreads("acme", "widgets", 137)
    const rep = await applyItems(client, {
      scope: SCOPE,
      threads,
      author: "",
      items: [
        {
          threadId: TID_RESOLVE,
          body: "Fixed in abc1234 - the error is now wrapped with fmt.Errorf and logged.",
        },
      ],
    })
    expect(rep.results[0]?.resolve).toBe("fail")
    expect(rep.results[0]?.error).toMatch(/^resolve: graphql: Resource not accessible by integration$/)
    expectGolden("integration-resolve-fail", renderApply(rep))
  })
})

describe("integration: GraphQL envelope edge cases", () => {
  test("listThreads against {\"data\":null} throws /graphql: decode data:/", async () => {
    const fetch = fakeFetch([{ match: "/graphql", respond: () => json({ data: null }) }])
    const client = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    let err: Error | undefined
    try {
      await client.listThreads("acme", "widgets", 137)
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err?.message).toMatch(/^graphql: decode data:/)
  })

  test("hasNextPage:true without endCursor throws /hasNextPage without endCursor/", async () => {
    const fetch = fakeFetch([
      {
        match: "/graphql",
        respond: () =>
          json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: true, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          }),
      },
    ])
    const client = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    let err: Error | undefined
    try {
      await client.listThreads("acme", "widgets", 137)
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err?.message).toMatch(/hasNextPage without endCursor/)
  })
})
