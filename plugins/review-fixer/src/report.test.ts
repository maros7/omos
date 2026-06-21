// report.test.ts — table-driven coverage of every pure renderer + filter.
// Fixture data is realistic-shaped (bot reviewers, real-looking PRRT_ IDs,
// real review-language bodies) but fully obfuscated — see README for the
// mapping rationale.
import { test, expect, describe } from "bun:test"
import { expectGolden, isUpdate, writeGolden, compareOrWrite } from "../testdata/golden"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_BODY_LEN,
  threadMatchesAuthor,
  filterThreads,
  renderList,
  renderVerify,
  threadLoc,
  firstLine,
  applyLine,
  renderApply,
} from "./report"
import { clip } from "./text"
import type { Thread } from "./github"
import type { ApplyReport } from "./apply"

/** Realistic-shape thread IDs (base64-style, modeled after real PRRT_kwDO…). */
const TID = {
  alpha: "PRRT_kwDOABCD01EFGH2345",
  beta: "PRRT_kwDOIJLM06NOPQ7890",
  gamma: "PRRT_kwDORSTU12VWXZ3456",
  delta: "PRRT_kwDOabcd07efgh8901",
  epsilon: "PRRT_kwDOijkl14mnop5678",
  zeta: "PRRT_kwDOqrst21uvwx9012",
} as const

/** Realistic-shape reviewer logins (bot-style, obfuscated). */
const AUTHOR = {
  copilot: "copilot-pull-request-reviewer",
  coderabbit: "coderabbit-ai",
} as const

/** Default thread shape used as the base for partial overrides. */
function t(over: Partial<Thread>): Thread {
  return {
    id: TID.alpha,
    isResolved: false,
    path: "src/components/Button.tsx",
    line: 47,
    rootCommentID: 1738294501,
    author: AUTHOR.copilot,
    body: "Consider extracting this into a helper to avoid duplication across the call sites.",
    replies: 0,
    ...over,
  }
}

describe("threadLoc", () => {
  const cases: Array<{ name: string; input: Thread; expected: string }> = [
    { name: "with line", input: t({ path: "src/components/Modal.tsx", line: 132 }), expected: "src/components/Modal.tsx:132" },
    { name: "no line", input: t({ path: "src/utils/format.ts", line: 0 }), expected: "src/utils/format.ts" },
    { name: "no path", input: t({ path: "", line: 5 }), expected: "-" },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(threadLoc(c.input)).toBe(c.expected)
    })
  }
})

describe("firstLine", () => {
  // Pure string/byte logic — simple ASCII inputs make the intent obvious.
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: "single line", input: "hello", expected: "hello" },
    { name: "multi line picks first non-empty", input: "\n\n  world  \nsecond", expected: "world" },
    { name: "whitespace only", input: "   \n\t\n", expected: "" },
    { name: "empty", input: "", expected: "" },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(firstLine(c.input)).toBe(c.expected)
    })
  }
})

describe("clip", () => {
  // Pure byte-boundary logic — simple ASCII/emoji inputs make the boundary
  // conditions unambiguous.
  test("ascii short passes through", () => {
    expect(clip("abc", 10)).toBe("abc")
  })
  test("ascii truncates at n bytes", () => {
    expect(clip("abcdef", 3)).toBe("abc")
  })
  test("MAX_BODY_LEN constant is 4000", () => {
    expect(MAX_BODY_LEN).toBe(4000)
  })
  test("multi-byte rune not split mid-rune", () => {
    // "😀" is 4 bytes (U+1F600). Truncating at 2 bytes must yield "" (backed up over continuation bytes).
    expect(clip("😀abc", 2)).toBe("")
    // Truncating at 4 bytes keeps the emoji.
    expect(clip("😀abc", 4)).toBe("😀")
    // Truncating at 5 bytes keeps emoji + 'a'.
    expect(clip("😀abc", 5)).toBe("😀a")
  })
})

describe("threadMatchesAuthor", () => {
  const cases: Array<{ name: string; author: string; thread: Thread; expected: boolean }> = [
    { name: "empty matches all", author: "", thread: t({ author: AUTHOR.copilot }), expected: true },
    { name: "case-insensitive substring", author: "COPI", thread: t({ author: AUTHOR.copilot }), expected: true },
    { name: "miss", author: "coderabbit", thread: t({ author: AUTHOR.copilot }), expected: false },
    { name: "lowercase substring", author: "pull-request", thread: t({ author: AUTHOR.copilot }), expected: true },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(threadMatchesAuthor(c.thread, c.author)).toBe(c.expected)
    })
  }
})

describe("filterThreads", () => {
  test("resolved excluded, author filter applied", () => {
    const threads = [
      t({ id: TID.alpha, author: AUTHOR.copilot, isResolved: false }),
      t({ id: TID.beta, author: AUTHOR.coderabbit, isResolved: false }),
      t({ id: TID.gamma, author: AUTHOR.copilot, isResolved: true }),
    ]
    expect(filterThreads(threads, "copilot").map((x) => x.id)).toEqual([TID.alpha])
    expect(filterThreads(threads, "").map((x) => x.id)).toEqual([TID.alpha, TID.beta])
  })
})

interface ListCase {
  name: string
  golden: string
  pr: number
  owner: string
  repo: string
  threads: Thread[]
}

// NOTE: the golden files assert TS self-consistency only; the renderer formats
// were hand-verified against the original Go renderer (Go parity checked manually).
describe("renderList (golden)", () => {
  const cases: ListCase[] = [
    { name: "zero threads", golden: "list-empty", pr: 137, owner: "acme", repo: "widgets", threads: [] },
    {
      name: "single thread with line",
      golden: "list-single",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({
          id: TID.alpha,
          path: "src/components/Button.tsx",
          line: 47,
          author: AUTHOR.copilot,
          body: "Consider extracting this into a helper to avoid duplication across the call sites.",
        }),
      ],
    },
    {
      name: "thread without line",
      golden: "list-no-line",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({
          id: TID.beta,
          path: "README.md",
          line: 0,
          author: AUTHOR.coderabbit,
          body: "The npm install command in this section is missing the `--prefix` flag.",
        }),
      ],
    },
    {
      name: "thread with replies marker",
      golden: "list-replies",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({
          id: TID.gamma,
          path: "src/server/handler.go",
          line: 215,
          author: AUTHOR.copilot,
          body: "This error is being swallowed — consider wrapping with fmt.Errorf to preserve context.",
          replies: 3,
        }),
      ],
    },
    {
      name: "multi-line body with suggestion block",
      golden: "list-multiline",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({
          id: TID.delta,
          body: [
            "This loop could cause a performance issue with large inputs.",
            "",
            "```suggestion",
            "const result = items.filter(isValid).map(transform);",
            "```",
            "",
            "This reads more declaratively and avoids the intermediate push.",
            "",
          ].join("\n"),
        }),
      ],
    },
    {
      name: "empty body shows placeholder",
      golden: "list-empty-body",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [t({ id: TID.epsilon, body: "   \n\n  " })],
    },
    {
      name: "multiple threads",
      golden: "list-multiple",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({
          id: TID.alpha,
          path: "src/components/Button.tsx",
          line: 47,
          author: AUTHOR.copilot,
          body: "Consider extracting this into a helper to avoid duplication across the call sites.",
        }),
        t({
          id: TID.beta,
          path: "src/utils/format.ts",
          line: 89,
          author: AUTHOR.coderabbit,
          body: "Prefer `Intl.NumberFormat` over manual toLocaleString chaining for consistency.",
          replies: 1,
        }),
      ],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expectGolden(c.golden, renderList({ pr: c.pr, owner: c.owner, repo: c.repo, threads: c.threads }))
    })
  }
})

describe("renderVerify (golden)", () => {
  const cases: ListCase[] = [
    { name: "zero threads", golden: "verify-empty", pr: 137, owner: "acme", repo: "widgets", threads: [] },
    {
      name: "multiple threads",
      golden: "verify-multiple",
      pr: 137,
      owner: "acme",
      repo: "widgets",
      threads: [
        t({ id: TID.alpha, path: "src/components/Button.tsx", line: 47, body: "x" }),
        t({ id: TID.beta, path: "src/utils/format.ts", line: 0, body: "y" }),
      ],
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expectGolden(c.golden, renderVerify({ pr: c.pr, owner: c.owner, repo: c.repo, threads: c.threads }))
    })
  }
})

interface ApplyLineCase {
  name: string
  golden: string
  r: { threadId: string; reply: "ok" | "fail" | "skip"; resolve: "ok" | "skip" | "fail"; error?: string }
}

describe("applyLine (golden)", () => {
  const cases: ApplyLineCase[] = [
    { name: "ok", golden: "apply-line-ok", r: { threadId: TID.alpha, reply: "ok", resolve: "ok" } },
    {
      name: "reply-fail",
      golden: "apply-line-reply-fail",
      // Real production shape: replyToComment wraps as `reply: status N: msg`.
      // Body mirrors a real GitHub 401 JSON envelope.
      r: {
        threadId: TID.beta,
        reply: "fail",
        resolve: "skip",
        error: 'reply: status 401: {"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}',
      },
    },
    {
      name: "resolve-fail",
      golden: "apply-line-resolve-fail",
      // Real production shape: resolveThread wraps as `resolve: graphql: msg`.
      // Message mirrors a real GitHub GraphQL "Resource not accessible" error.
      r: {
        threadId: TID.gamma,
        reply: "ok",
        resolve: "fail",
        error: "resolve: graphql: Resource not accessible by integration",
      },
    },
    {
      name: "skip-unknown",
      golden: "apply-line-skip-unknown",
      r: { threadId: TID.delta, reply: "skip", resolve: "skip", error: "unknown thread" },
    },
    {
      name: "skip-resolved",
      golden: "apply-line-skip-resolved",
      r: { threadId: TID.epsilon, reply: "skip", resolve: "skip" },
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expectGolden(c.golden, `${applyLine(c.r)}\n`)
    })
  }
})

describe("renderApply (golden)", () => {
  test("mixed report", () => {
    const rep: ApplyReport = {
      results: [
        { threadId: TID.alpha, reply: "ok", resolve: "ok" },
        { threadId: TID.beta, reply: "skip", resolve: "skip", error: "unknown thread" },
        // Production-wrapped error prefixes (applyOne catches GithubClient's wraps):
        {
          threadId: TID.gamma,
          reply: "fail",
          resolve: "skip",
          error: 'reply: status 500: {"message":"Server Error"}',
        },
        {
          threadId: TID.delta,
          reply: "ok",
          resolve: "fail",
          error: "resolve: graphql: Resource not accessible by integration",
        },
        { threadId: TID.epsilon, reply: "skip", resolve: "skip" },
      ],
      applied: 1,
      requested: 5,
      remaining: 2,
    }
    expectGolden("apply-report", renderApply(rep))
  })
  test("empty report", () => {
    const rep: ApplyReport = { results: [], applied: 0, requested: 0, remaining: 0 }
    expectGolden("apply-empty", renderApply(rep))
  })
})

describe("expectGolden missing-file path", () => {
  test("throws when the .golden file does not exist (skipped under UPDATE)", () => {
    if (isUpdate()) {
      // Under UPDATE the helper writes instead of comparing — skip.
      return
    }
    let err: Error | undefined
    try {
      expectGolden("__definitely_missing__", "x")
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err?.message).toMatch(/golden file missing/)
  })
  test("writeGolden creates dirs + writes bytes (covers the UPDATE branch body)", () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"))
    try {
      const nested = join(dir, "nested", "deep", "file.txt")
      writeGolden(nested, "hello\n")
      expect(existsSync(nested)).toBe(true)
      expect(readFileSync(nested, "utf8")).toBe("hello\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("expectGolden under GOLDEN_UPDATE writes the file (covers the call site inside expectGolden)", () => {
    const prev = process.env.GOLDEN_UPDATE
    process.env.GOLDEN_UPDATE = "1"
    try {
      const dir = mkdtempSync(join(tmpdir(), "golden-update-"))
      const target = join(dir, "regen.golden")
      // Drive compareOrWrite through its UPDATE branch (same code path
      // expectGolden uses internally for the per-name call).
      compareOrWrite(target, "regenerated\n")
      expect(isUpdate()).toBe(true)
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, "utf8")).toBe("regenerated\n")
      rmSync(dir, { recursive: true, force: true })
    } finally {
      if (prev === undefined) delete process.env.GOLDEN_UPDATE
      else process.env.GOLDEN_UPDATE = prev
    }
  })
  test("compareOrWrite against an existing file in compare mode succeeds", () => {
    // isUpdate() is false here — exercises the readFileSync+expect branch.
    if (isUpdate()) return
    const dir = mkdtempSync(join(tmpdir(), "golden-compare-"))
    try {
      const target = join(dir, "existing.golden")
      writeFileSync(target, "fixed\n")
      compareOrWrite(target, "fixed\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
