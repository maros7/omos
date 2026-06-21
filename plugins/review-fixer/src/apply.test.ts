// apply.test.ts — table-driven orchestration with a fake ClientLike.
// Fixture data is realistic-shaped but fully obfuscated (see report.test.ts
// TID/AUTHOR mapping rationale).
import { test, expect, describe } from "bun:test"
import { expectGolden } from "../testdata/golden"
import { applyItems, countSkipsOK, type ApplyItemResult, type ApplyReport, type ApplyParams } from "./apply"
import { applyLine } from "./report"
import type { Thread, ClientLike, ReplyArgs } from "./github"

/** Realistic-shape thread IDs (base64-style, modeled after real PRRT_kwDO…). */
const TID = {
  alpha: "PRRT_kwDOABCD01EFGH2345",
  beta: "PRRT_kwDOIJLM06NOPQ7890",
  gamma: "PRRT_kwDORSTU12VWXZ3456",
  delta: "PRRT_kwDOabcd07efgh8901",
  epsilon: "PRRT_kwDOijkl14mnop5678",
  unknown: "PRRT_kwDOUNKNOWN0000AAAA",
} as const

/** Realistic-shape reviewer logins (bot-style, obfuscated). */
const AUTHOR = {
  copilot: "copilot-pull-request-reviewer",
  coderabbit: "coderabbit-ai",
} as const

interface FakeCalls {
  replies: ReplyArgs[]
  resolves: string[]
}

interface FakeImpl {
  reply?: (args: ReplyArgs) => Promise<void>
  resolve?: (id: string) => Promise<void>
}

function fakeClient(impl: FakeImpl): { client: ClientLike; calls: FakeCalls } {
  const calls: FakeCalls = { replies: [], resolves: [] }
  const client: ClientLike = {
    replyToComment(args: ReplyArgs): Promise<void> {
      calls.replies.push(args)
      if (impl.reply) return impl.reply(args)
      return Promise.resolve()
    },
    resolveThread(id: string): Promise<void> {
      calls.resolves.push(id)
      if (impl.resolve) return impl.resolve(id)
      return Promise.resolve()
    },
  }
  return { client, calls }
}

interface ApplyCase {
  name: string
  threads: Thread[]
  items: Array<{ threadId: string; body: string }>
  author: string
  replyImpl?: (args: ReplyArgs) => Promise<void>
  resolveImpl?: (id: string) => Promise<void>
  expected: ApplyReport
  replyCalls: number
  resolveCalls: number
}

const SCOPE = { owner: "acme", repo: "widgets", pr: 137 }

describe("applyItems", () => {
  const cases: ApplyCase[] = [
    {
      name: "unknown thread skips",
      threads: [],
      items: [{ threadId: TID.unknown, body: "Addressed in commit abc1234." }],
      author: "",
      expected: {
        results: [{ threadId: TID.unknown, reply: "skip", resolve: "skip", error: "unknown thread" }],
        applied: 0,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 0,
      resolveCalls: 0,
    },
    {
      name: "already resolved skips without client calls",
      threads: [
        {
          id: TID.alpha,
          isResolved: true,
          path: "src/components/Button.tsx",
          line: 47,
          rootCommentID: 1738294501,
          author: AUTHOR.copilot,
          body: "Consider extracting this into a helper to avoid duplication across the call sites.",
          replies: 0,
        },
      ],
      items: [{ threadId: TID.alpha, body: "Thanks — already addressed in a follow-up." }],
      author: "",
      expected: {
        results: [{ threadId: TID.alpha, reply: "skip", resolve: "skip" }],
        applied: 0,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 0,
      resolveCalls: 0,
    },
    {
      name: "reply fail marks reply-fail and skips resolve",
      threads: [
        {
          id: TID.beta,
          isResolved: false,
          path: "src/utils/format.ts",
          line: 89,
          rootCommentID: 1738294502,
          author: AUTHOR.coderabbit,
          body: "Prefer `Intl.NumberFormat` over manual toLocaleString chaining for consistency.",
          replies: 0,
        },
      ],
      items: [
        {
          threadId: TID.beta,
          body: "Fixed in abc1234 - switched to Intl.NumberFormat and added a unit test.",
        },
      ],
      author: "",
      // Real GithubClient.replyToComment wraps restPost's `status N: msg` as
      // `reply: status N: msg`; mirror that here so goldens reflect production.
      replyImpl: () => Promise.reject(new Error('reply: status 500: {"message":"Server Error"}')),
      expected: {
        results: [
          {
            threadId: TID.beta,
            reply: "fail",
            resolve: "skip",
            error: 'reply: status 500: {"message":"Server Error"}',
          },
        ],
        applied: 0,
        requested: 1,
        remaining: 1,
      },
      replyCalls: 1,
      resolveCalls: 0,
    },
    {
      name: "resolve fail marks resolve-fail",
      threads: [
        {
          id: TID.gamma,
          isResolved: false,
          path: "src/server/handler.go",
          line: 215,
          rootCommentID: 1738294503,
          author: AUTHOR.copilot,
          body: "This error is being swallowed — consider wrapping with fmt.Errorf to preserve context.",
          replies: 0,
        },
      ],
      items: [
        {
          threadId: TID.gamma,
          body: "Fixed in abc1234 - the error is now wrapped with fmt.Errorf and logged.",
        },
      ],
      author: "",
      // Real GithubClient.resolveThread wraps graphql's `graphql: msg` as
      // `resolve: graphql: msg`; mirror that here so goldens reflect production.
      resolveImpl: () => Promise.reject(new Error("resolve: graphql: Resource not accessible by integration")),
      expected: {
        results: [
          {
            threadId: TID.gamma,
            reply: "ok",
            resolve: "fail",
            error: "resolve: graphql: Resource not accessible by integration",
          },
        ],
        applied: 0,
        requested: 1,
        remaining: 1,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
    {
      name: "happy ok applies once",
      threads: [
        {
          id: TID.delta,
          isResolved: false,
          path: "internal/auth/middleware.go",
          line: 8,
          rootCommentID: 1738294504,
          author: AUTHOR.copilot,
          body: "Missing context cancellation check — the request will leak if the client disconnects.",
          replies: 0,
        },
      ],
      items: [
        {
          threadId: TID.delta,
          body: "Fixed in abc1234 - extracted the helper and added a null check.",
        },
      ],
      author: "",
      expected: {
        results: [{ threadId: TID.delta, reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
    {
      name: "remaining math with author filter",
      // Two unresolved threads from copilot + coderabbit. Apply copilot's.
      // Author filter "copilot" → unresolvedAtStart=1, matchedApplied=1 → remaining=0.
      threads: [
        {
          id: TID.alpha,
          isResolved: false,
          path: "src/components/Button.tsx",
          line: 47,
          rootCommentID: 1738294501,
          author: AUTHOR.copilot,
          body: "Consider extracting this into a helper.",
          replies: 0,
        },
        {
          id: TID.beta,
          isResolved: false,
          path: "src/utils/format.ts",
          line: 89,
          rootCommentID: 1738294502,
          author: AUTHOR.coderabbit,
          body: "Prefer Intl.NumberFormat.",
          replies: 0,
        },
      ],
      items: [{ threadId: TID.alpha, body: "Fixed - extracted into utils." }],
      author: "copilot",
      expected: {
        results: [{ threadId: TID.alpha, reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
    {
      name: "remaining math coderabbit author leaves copilot unresolved",
      threads: [
        {
          id: TID.alpha,
          isResolved: false,
          path: "src/components/Button.tsx",
          line: 47,
          rootCommentID: 1738294501,
          author: AUTHOR.copilot,
          body: "Consider extracting this into a helper.",
          replies: 0,
        },
        {
          id: TID.beta,
          isResolved: false,
          path: "src/utils/format.ts",
          line: 89,
          rootCommentID: 1738294502,
          author: AUTHOR.coderabbit,
          body: "Prefer Intl.NumberFormat.",
          replies: 0,
        },
      ],
      items: [{ threadId: TID.beta, body: "Fixed - switched to Intl.NumberFormat." }],
      author: "coderabbit",
      expected: {
        results: [{ threadId: TID.beta, reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
  ]

  for (const c of cases) {
    test(c.name, async () => {
      const { client, calls } = fakeClient({
        reply: c.replyImpl,
        resolve: c.resolveImpl,
      })
      const params: ApplyParams = {
        scope: SCOPE,
        threads: c.threads,
        author: c.author,
        items: [...c.items],
      }
      const rep = await applyItems(client, params)
      expect(rep).toEqual(c.expected)
      expect(calls.replies.length).toBe(c.replyCalls)
      expect(calls.resolves.length).toBe(c.resolveCalls)
    })
  }
})

describe("countSkipsOK", () => {
  const cases: Array<{ name: string; rep: ApplyReport; expected: number }> = [
    {
      name: "no skips",
      rep: {
        results: [{ threadId: TID.alpha, reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      expected: 0,
    },
    {
      name: "skip-skip-no-error counted",
      rep: {
        results: [
          { threadId: TID.alpha, reply: "skip", resolve: "skip" },
          { threadId: TID.beta, reply: "skip", resolve: "skip", error: "unknown thread" },
          { threadId: TID.gamma, reply: "ok", resolve: "ok" },
        ],
        applied: 1,
        requested: 3,
        remaining: 0,
      },
      expected: 1,
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(countSkipsOK(c.rep)).toBe(c.expected)
    })
  }
})

describe("applyLine (golden)", () => {
  // Re-asserted here to keep apply.test.ts self-contained for orchestration outputs.
  const cases: Array<{ name: string; golden: string; r: ApplyItemResult }> = [
    { name: "ok", golden: "apply-line-ok", r: { threadId: TID.alpha, reply: "ok", resolve: "ok" } },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expectGolden(c.golden, `${applyLine(c.r)}\n`)
    })
  }
})
