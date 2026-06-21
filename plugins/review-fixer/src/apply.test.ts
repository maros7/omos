// apply.test.ts — table-driven orchestration with a fake ClientLike.
import { test, expect, describe } from "bun:test"
import { expectGolden } from "../testdata/golden"
import { applyItems, countSkipsOK, type ApplyItemResult, type ApplyReport, type ApplyParams } from "./apply"
import { applyLine } from "./report"
import type { Thread, ClientLike, ReplyArgs } from "./github"

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

const SCOPE = { owner: "maros7", repo: "omos", pr: 42 }

describe("applyItems", () => {
  const cases: ApplyCase[] = [
    {
      name: "unknown thread skips",
      threads: [],
      items: [{ threadId: "PRRT_x", body: "hi" }],
      author: "",
      expected: {
        results: [{ threadId: "PRRT_x", reply: "skip", resolve: "skip", error: "unknown thread" }],
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
          id: "PRRT_r",
          isResolved: true,
          path: "a.ts",
          line: 1,
          rootCommentID: 5,
          author: "alice",
          body: "x",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_r", body: "thanks" }],
      author: "",
      expected: {
        results: [{ threadId: "PRRT_r", reply: "skip", resolve: "skip" }],
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
          id: "PRRT_f",
          isResolved: false,
          path: "a.ts",
          line: 1,
          rootCommentID: 9,
          author: "alice",
          body: "x",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_f", body: "ok" }],
      author: "",
      // Real GithubClient.replyToComment wraps restPost's `status N: msg` as
      // `reply: status N: msg`; mirror that here so goldens reflect production.
      replyImpl: () => Promise.reject(new Error("reply: status 500: boom")),
      expected: {
        results: [{ threadId: "PRRT_f", reply: "fail", resolve: "skip", error: "reply: status 500: boom" }],
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
          id: "PRRT_g",
          isResolved: false,
          path: "a.ts",
          line: 1,
          rootCommentID: 9,
          author: "alice",
          body: "x",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_g", body: "ok" }],
      author: "",
      // Real GithubClient.resolveThread wraps graphql's `graphql: msg` as
      // `resolve: graphql: msg`; mirror that here so goldens reflect production.
      resolveImpl: () => Promise.reject(new Error("resolve: graphql: bad")),
      expected: {
        results: [{ threadId: "PRRT_g", reply: "ok", resolve: "fail", error: "resolve: graphql: bad" }],
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
          id: "PRRT_h",
          isResolved: false,
          path: "a.ts",
          line: 1,
          rootCommentID: 9,
          author: "alice",
          body: "x",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_h", body: "fixed" }],
      author: "",
      expected: {
        results: [{ threadId: "PRRT_h", reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
    {
      name: "remaining math with author filter",
      threads: [
        {
          id: "PRRT_a",
          isResolved: false,
          path: "a.ts",
          line: 1,
          rootCommentID: 1,
          author: "alice",
          body: "x",
          replies: 0,
        },
        {
          id: "PRRT_b",
          isResolved: false,
          path: "b.ts",
          line: 1,
          rootCommentID: 2,
          author: "bob",
          body: "y",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_a", body: "ok" }],
      author: "alice",
      expected: {
        results: [{ threadId: "PRRT_a", reply: "ok", resolve: "ok" }],
        applied: 1,
        requested: 1,
        remaining: 0,
      },
      replyCalls: 1,
      resolveCalls: 1,
    },
    {
      name: "remaining math bob author leaves alice unresolved",
      threads: [
        {
          id: "PRRT_a",
          isResolved: false,
          path: "a.ts",
          line: 1,
          rootCommentID: 1,
          author: "alice",
          body: "x",
          replies: 0,
        },
        {
          id: "PRRT_b",
          isResolved: false,
          path: "b.ts",
          line: 1,
          rootCommentID: 2,
          author: "bob",
          body: "y",
          replies: 0,
        },
      ],
      items: [{ threadId: "PRRT_b", body: "ok" }],
      author: "bob",
      expected: {
        results: [{ threadId: "PRRT_b", reply: "ok", resolve: "ok" }],
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
      rep: { results: [{ threadId: "a", reply: "ok", resolve: "ok" }], applied: 1, requested: 1, remaining: 0 },
      expected: 0,
    },
    {
      name: "skip-skip-no-error counted",
      rep: {
        results: [
          { threadId: "a", reply: "skip", resolve: "skip" },
          { threadId: "b", reply: "skip", resolve: "skip", error: "unknown thread" },
          { threadId: "c", reply: "ok", resolve: "ok" },
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
    { name: "ok", golden: "apply-line-ok", r: { threadId: "PRRT_a", reply: "ok", resolve: "ok" } },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expectGolden(c.golden, `${applyLine(c.r)}\n`)
    })
  }
})
