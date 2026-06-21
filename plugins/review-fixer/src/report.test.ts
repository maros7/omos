// report.test.ts — table-driven coverage of every pure renderer + filter.
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
  clip,
  applyLine,
  renderApply,
} from "./report"
import type { Thread } from "./github"
import type { ApplyReport } from "./apply"

function t(over: Partial<Thread>): Thread {
  return {
    id: "PRRT_x",
    isResolved: false,
    path: "src/a.ts",
    line: 10,
    rootCommentID: 1,
    author: "alice",
    body: "fix this",
    replies: 0,
    ...over,
  }
}

describe("threadLoc", () => {
  const cases: Array<{ name: string; input: Thread; expected: string }> = [
    { name: "with line", input: t({ path: "src/x.ts", line: 42 }), expected: "src/x.ts:42" },
    { name: "no line", input: t({ path: "src/x.ts", line: 0 }), expected: "src/x.ts" },
    { name: "no path", input: t({ path: "", line: 5 }), expected: "-" },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(threadLoc(c.input)).toBe(c.expected)
    })
  }
})

describe("firstLine", () => {
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
    { name: "empty matches all", author: "", thread: t({ author: "alice" }), expected: true },
    { name: "case-insensitive substring", author: "ALI", thread: t({ author: "alice" }), expected: true },
    { name: "miss", author: "bob", thread: t({ author: "alice" }), expected: false },
    { name: "lowercase substring", author: "lic", thread: t({ author: "alice" }), expected: true },
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
      t({ id: "1", author: "alice", isResolved: false }),
      t({ id: "2", author: "bob", isResolved: false }),
      t({ id: "3", author: "alice", isResolved: true }),
    ]
    expect(filterThreads(threads, "ali").map((x) => x.id)).toEqual(["1"])
    expect(filterThreads(threads, "").map((x) => x.id)).toEqual(["1", "2"])
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

describe("renderList (golden)", () => {
  const cases: ListCase[] = [
    { name: "zero threads", golden: "list-empty", pr: 1, owner: "o", repo: "r", threads: [] },
    {
      name: "single thread with line",
      golden: "list-single",
      pr: 42,
      owner: "maros7",
      repo: "omos",
      threads: [t({ id: "PRRT_a", path: "src/x.ts", line: 10, author: "alice", body: "fix this" })],
    },
    {
      name: "thread without line",
      golden: "list-no-line",
      pr: 7,
      owner: "o",
      repo: "r",
      threads: [t({ id: "PRRT_b", path: "README.md", line: 0, author: "bob", body: "typo" })],
    },
    {
      name: "thread with replies marker",
      golden: "list-replies",
      pr: 7,
      owner: "o",
      repo: "r",
      threads: [t({ id: "PRRT_c", path: "a.ts", line: 1, author: "x", body: "hmm", replies: 3 })],
    },
    {
      name: "multi-line body",
      golden: "list-multiline",
      pr: 7,
      owner: "o",
      repo: "r",
      threads: [t({ id: "PRRT_d", body: "line1\nline2\n\nline4   \n" })],
    },
    {
      name: "empty body shows placeholder",
      golden: "list-empty-body",
      pr: 7,
      owner: "o",
      repo: "r",
      threads: [t({ id: "PRRT_e", body: "   \n\n  " })],
    },
    {
      name: "multiple threads",
      golden: "list-multiple",
      pr: 99,
      owner: "octo",
      repo: "cat",
      threads: [
        t({ id: "PRRT_1", path: "a.ts", line: 1, author: "alice", body: "one" }),
        t({ id: "PRRT_2", path: "b.ts", line: 2, author: "bob", body: "two", replies: 1 }),
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
    { name: "zero threads", golden: "verify-empty", pr: 1, owner: "o", repo: "r", threads: [] },
    {
      name: "multiple threads",
      golden: "verify-multiple",
      pr: 99,
      owner: "octo",
      repo: "cat",
      threads: [
        t({ id: "PRRT_1", path: "a.ts", line: 1, body: "x" }),
        t({ id: "PRRT_2", path: "b.ts", line: 0, body: "y" }),
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
    { name: "ok", golden: "apply-line-ok", r: { threadId: "PRRT_a", reply: "ok", resolve: "ok" } },
    {
      name: "reply-fail",
      golden: "apply-line-reply-fail",
      // Real production shape: replyToComment wraps as `reply: status N: msg`.
      r: { threadId: "PRRT_a", reply: "fail", resolve: "skip", error: "reply: status 401: nope" },
    },
    {
      name: "resolve-fail",
      golden: "apply-line-resolve-fail",
      // Real production shape: resolveThread wraps as `resolve: graphql: msg`.
      r: { threadId: "PRRT_a", reply: "ok", resolve: "fail", error: "resolve: graphql: bad" },
    },
    {
      name: "skip-unknown",
      golden: "apply-line-skip-unknown",
      r: { threadId: "PRRT_a", reply: "skip", resolve: "skip", error: "unknown thread" },
    },
    {
      name: "skip-resolved",
      golden: "apply-line-skip-resolved",
      r: { threadId: "PRRT_a", reply: "skip", resolve: "skip" },
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
        { threadId: "PRRT_1", reply: "ok", resolve: "ok" },
        { threadId: "PRRT_2", reply: "skip", resolve: "skip", error: "unknown thread" },
        // Production-wrapped error prefixes (applyOne catches GithubClient's wraps):
        { threadId: "PRRT_3", reply: "fail", resolve: "skip", error: "reply: status 500: boom" },
        { threadId: "PRRT_4", reply: "ok", resolve: "fail", error: "resolve: graphql: bad" },
        { threadId: "PRRT_5", reply: "skip", resolve: "skip" },
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
