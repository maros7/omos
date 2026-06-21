// github.test.ts — table-driven, mocked fetch. Verifies transport errors,
// pagination, REST reply shape, and GraphQL error wrapping.
import { test, expect, describe } from "bun:test"
import { GithubClient, toThread, type Thread, type ThreadNode } from "./github"
import type { FetchLike } from "./deps"

/** A tiny fetch router: matches on URL substring, returns canned Response. */
type Route = {
  match: string | RegExp
  respond: (url: string, init: RequestInit, body: string) => Promise<Response> | Response
}

interface FetchCall {
  url: string
  init: RequestInit
}

/** Coerce fetch `input` (string | URL | Request) to a URL string without
 *  triggering no-base-to-string (each branch uses a known toStringable). */
function inputToURL(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function fakeFetch(routes: Route[]): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = inputToURL(input)
    const safeInit = init ?? {}
    calls.push({ url, init: safeInit })
    for (const r of routes) {
      const matched = r.match instanceof RegExp ? r.match.test(url) : url.includes(r.match)
      if (matched) {
        const bodyStr = typeof safeInit.body === "string" ? safeInit.body : ""
        return Promise.resolve(r.respond(url, safeInit, bodyStr))
      }
    }
    return Promise.reject(new Error(`no route matched ${url}`))
  }
  return { fetch, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Type guard: x is a non-null, non-array object. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x)
}

/** Safely parse a JSON body string as a record. */
function parseBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body)
  return isRecord(parsed) ? parsed : {}
}

/** Fetch a header value (handles Headers / record / array forms). */
function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  if (!init) return undefined
  const h: unknown = init.headers
  if (h instanceof Headers) return h.get(name) ?? undefined
  if (!isRecord(h)) return undefined
  const v = h[name]
  return typeof v === "string" ? v : undefined
}

/** Type-safe body accessor: returns the body string or "". */
function bodyString(init: RequestInit | undefined): string {
  if (!init) return ""
  return typeof init.body === "string" ? init.body : ""
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

describe("listThreads", () => {
  test("single page", async () => {
    const data = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_1",
                isResolved: false,
                comments: {
                  nodes: [
                    { databaseId: 11, body: "fix", author: { login: "alice" }, path: "a.ts", line: 1 },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    const { fetch, calls } = fakeFetch([{ match: "/graphql", respond: () => jsonResponse({ data }) }])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    const threads = await c.listThreads("o", "r", 5)
    expect(threads).toEqual<Thread[]>([
      {
        id: "PRRT_1",
        isResolved: false,
        path: "a.ts",
        line: 1,
        rootCommentID: 11,
        author: "alice",
        body: "fix",
        replies: 0,
      },
    ])
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("https://api.github.com/graphql")
    const firstInit = calls[0]?.init
    expect(firstInit?.method).toBe("POST")
    expect(headerValue(firstInit, "Authorization")).toBe("Bearer tok")
    expect(headerValue(firstInit, "Accept")).toBe("application/vnd.github+json")
    expect(headerValue(firstInit, "X-GitHub-Api-Version")).toBe("2022-11-28")
    expect(headerValue(firstInit, "User-Agent")).toBe("review-fixer")
    expect(headerValue(firstInit, "Content-Type")).toBe("application/json")
    const body = parseBody(bodyString(firstInit))
    const variables = body["variables"]
    expect(variables).toEqual({ owner: "o", repo: "r", pr: 5, after: null })
  })

  test("pagination across two pages", async () => {
    const page1 = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            nodes: [
              {
                id: "PRRT_A",
                isResolved: false,
                comments: { nodes: [{ databaseId: 1, body: "a", author: { login: "x" }, path: "p", line: 1 }] },
              },
            ],
          },
        },
      },
    }
    const page2 = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_B",
                isResolved: false,
                comments: { nodes: [{ databaseId: 2, body: "b", author: { login: "y" }, path: "q", line: 2 }] },
              },
            ],
          },
        },
      },
    }
    let call = 0
    const { fetch } = fakeFetch([
      {
        match: "/graphql",
        respond: () => {
          call++
          return jsonResponse({ data: call === 1 ? page1 : page2 })
        },
      },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    const threads = await c.listThreads("o", "r", 5)
    expect(threads.map((t) => t.id)).toEqual(["PRRT_A", "PRRT_B"])
    expect(call).toBe(2)
  })

  test("non-2xx graphql throws /graphql: status/", async () => {
    const { fetch } = fakeFetch([
      { match: "/graphql", respond: () => new Response("server explosion", { status: 502 }) },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await expectReject(c.listThreads("o", "r", 5), /graphql: status 502/)
  })

  test("graphql errors[] throws message", async () => {
    const { fetch } = fakeFetch([
      {
        match: "/graphql",
        respond: () => jsonResponse({ errors: [{ message: "rate limited" }] }),
      },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await expectReject(c.listThreads("o", "r", 5), /graphql: rate limited/)
  })
})

describe("replyToComment", () => {
  test("happy path posts to REST with body and captures comment id", async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: "/repos/o/r/pulls/5/comments/77/replies",
        respond: () => jsonResponse({ id: 999 }, 201),
      },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await c.replyToComment({ owner: "o", repo: "r", pr: 5, commentID: 77, body: "fixed it" })
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/5/comments/77/replies")
    const firstInit = calls[0]?.init
    expect(firstInit?.method).toBe("POST")
    expect(headerValue(firstInit, "Authorization")).toBe("Bearer tok")
    expect(headerValue(firstInit, "Content-Type")).toBe("application/json")
    expect(parseBody(bodyString(firstInit))).toEqual({ body: "fixed it" })
  })

  test("non-2xx wraps with /reply:/", async () => {
    const { fetch } = fakeFetch([
      { match: "/repos/", respond: () => new Response("nope", { status: 403 }) },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await expectReject(
      c.replyToComment({ owner: "o", repo: "r", pr: 5, commentID: 1, body: "x" }),
      /reply: status 403/,
    )
  })
})

describe("resolveThread", () => {
  test("happy path posts mutation", async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: "/graphql",
        respond: () =>
          jsonResponse({ data: { resolveReviewThread: { thread: { id: "T", isResolved: true } } } }),
      },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await c.resolveThread("T")
    const body = parseBody(bodyString(calls[0]?.init))
    const query = body["query"]
    expect(typeof query === "string" ? query : "").toMatch(/mutation\(\$id:ID!\)/)
    expect(body["variables"]).toEqual({ id: "T" })
  })

  test("graphql error wraps with /resolve:/", async () => {
    const { fetch } = fakeFetch([
      { match: "/graphql", respond: () => jsonResponse({ errors: [{ message: "forbidden" }] }) },
    ])
    const c = new GithubClient({ token: "tok", apiBase: "https://api.github.com", fetch })
    await expectReject(c.resolveThread("T"), /resolve: graphql: forbidden/)
  })
})

describe("toThread flattening", () => {
  const cases: Array<{ name: string; node: ThreadNode; expected: Thread }> = [
    {
      name: "multi-comment counts replies",
      node: {
        id: "PRRT_1",
        isResolved: false,
        comments: {
          nodes: [
            { databaseId: 1, body: "root", author: { login: "alice" }, path: "a.ts", line: 1 },
            { databaseId: 2, body: "reply1", author: { login: "bob" }, path: "a.ts", line: 1 },
            { databaseId: 3, body: "reply2", author: { login: "carol" }, path: "a.ts", line: 1 },
          ],
        },
      },
      expected: {
        id: "PRRT_1",
        isResolved: false,
        path: "a.ts",
        line: 1,
        rootCommentID: 1,
        author: "alice",
        body: "root",
        replies: 2,
      },
    },
    {
      name: "empty nodes defaults",
      node: { id: "PRRT_2", isResolved: true, comments: { nodes: [] } },
      expected: {
        id: "PRRT_2",
        isResolved: true,
        path: "",
        line: 0,
        rootCommentID: 0,
        author: "",
        body: "",
        replies: 0,
      },
    },
    {
      name: "missing comments defaults",
      node: { id: "PRRT_3", isResolved: false },
      expected: {
        id: "PRRT_3",
        isResolved: false,
        path: "",
        line: 0,
        rootCommentID: 0,
        author: "",
        body: "",
        replies: 0,
      },
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(toThread(c.node)).toEqual(c.expected)
    })
  }
})
