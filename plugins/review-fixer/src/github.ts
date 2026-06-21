// github.ts — thin GitHub client covering the three calls review-fixer needs:
// list review threads (GraphQL, paginated), post a reply (REST), and resolve a
// thread (GraphQL mutation). Errors are wrapped with a short context prefix so
// the caller can surface them verbatim to the model.
import type { FetchLike } from "./deps"
import { IO_TIMEOUT_MS } from "./deps"
import { clip } from "./text"

const GRAPHQL_QUERY =
  "query($owner:String!,$repo:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:50){nodes{databaseId body author{login} path line}}}}}}}"

const RESOLVE_MUTATION = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"

/** A flattened view of a review thread — exactly what the renderer needs. */
export type Thread = {
  id: string
  isResolved: boolean
  path: string
  line: number
  rootCommentID: number
  author: string
  body: string
  /** Number of reply comments after the root (nodes.length - 1). */
  replies: number
}

/** Constructor deps for GithubClient. */
export type GithubClientDeps = {
  token: string
  apiBase: string
  fetch: FetchLike
}

/** Parsed shape of the listThreads GraphQL response. */
type ListThreadsData = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: ThreadNode[]
      }
    }
  }
}

/** Common JSON node shapes the parser pulls fields from. */
type CommentNode = {
  databaseId?: number
  body?: string
  author?: { login?: string } | null
  path?: string
  line?: number
}

export type ThreadNode = {
  id: string
  isResolved?: boolean
  comments?: { nodes?: CommentNode[] }
}

/** Parsed shape of any GraphQL response: data + optional errors array. */
type GraphQLResponse = {
  data?: unknown
  errors?: Array<{ message: string }>
}

/** Argument bundle for replyToComment (5 fields would exceed max-params=3). */
export type ReplyArgs = {
  owner: string
  repo: string
  pr: number
  commentID: number
  body: string
}

/**
 * Minimal client surface apply.ts needs. GithubClient satisfies this
 * structurally. Kept as an `interface` because it describes a behavioural
 * contract implementations must satisfy.
 */
export interface ClientLike {
  /** Post a reply on a PR review comment. */
  replyToComment(args: ReplyArgs): Promise<void>
  /** Resolve a review thread by id. */
  resolveThread(threadID: string): Promise<void>
}

/** Type guard: x is a non-null, non-array object. */
function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** Type guard: x is a GraphQL-shaped response envelope (data null|object, errors array). */
function isGraphQLResponse(x: unknown): x is GraphQLResponse {
  if (!isObject(x)) return false
  if ("data" in x && x.data !== null && x.data !== undefined && !isObject(x.data)) return false
  if ("errors" in x && x.errors !== undefined && !Array.isArray(x.errors)) return false
  return true
}

/** JSON.parse with `unknown` result (so we never smuggle `any` past the parser). */
function parseJSON(text: string): unknown {
  return JSON.parse(text)
}

/**
 * snippet — trim + cap a body to MAX_SNIPPET_BYTES UTF-8 bytes (matches Go
 * client.go:123 byte-for-byte). Uses the shared byte-safe `clip` from text.ts
 * so multi-byte runes aren't split mid-rune.
 */
const MAX_SNIPPET_BYTES = 200
function snippet(s: string): string {
  return clip(s.trim(), MAX_SNIPPET_BYTES)
}

/** GithubClient: minimal GraphQL + REST client for review-fixer. */
export class GithubClient {
  constructor(private d: GithubClientDeps) {}

  /** List ALL unresolved+resolved threads across pages. Caller filters. */
  async listThreads(owner: string, repo: string, pr: number): Promise<Thread[]> {
    const threads: Thread[] = []
    let after: string | null = null
    // Go has no pagination cap (github.go:93) — loop until !hasNextPage.
    for (;;) {
      const data: ListThreadsData = await this.graphql<ListThreadsData>(GRAPHQL_QUERY, {
        owner,
        repo,
        pr,
        after,
      })
      const rt = data.repository?.pullRequest?.reviewThreads
      if (!rt) return threads
      for (const node of rt.nodes) threads.push(toThread(node))
      if (!rt.pageInfo.hasNextPage) return threads
      // hasNextPage without endCursor would infinite-loop; surface it loudly.
      if (!rt.pageInfo.endCursor) {
        throw new Error("graphql: hasNextPage without endCursor")
      }
      after = rt.pageInfo.endCursor
    }
  }

  /** Post a reply on a PR review comment, then return. */
  async replyToComment(args: ReplyArgs): Promise<void> {
    const { owner, repo, pr, commentID, body } = args
    try {
      await this.restPost(`/repos/${owner}/${repo}/pulls/${pr}/comments/${commentID}/replies`, { body })
    } catch (e) {
      throw new Error(`reply: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Resolve a review thread by id. */
  async resolveThread(threadID: string): Promise<void> {
    try {
      await this.graphql(RESOLVE_MUTATION, { id: threadID })
    } catch (e) {
      throw new Error(`resolve: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** POST JSON to a REST path under apiBase; throw on non-2xx. */
  private async restPost(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.d.apiBase}${path}`
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    })
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      throw new Error(`status ${res.status}: ${snippet(text)}`)
    }
  }

  /** POST a GraphQL request; throw on transport / GraphQL / decode errors. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = `${this.d.apiBase}/graphql`
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ query, variables }),
    })
    const text = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`graphql: status ${res.status}: ${snippet(text)}`)
    let parsed: unknown
    try {
      parsed = parseJSON(text)
    } catch (e) {
      // Mirrors Go client.go:82 — envelope JSON was malformed.
      throw new Error(`graphql: decode: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!isGraphQLResponse(parsed)) {
      // Mirrors Go client.go:82 — envelope was JSON but not the expected shape.
      throw new Error(`graphql: decode: ${snippet(text)}`)
    }
    const firstError = parsed.errors?.[0]
    if (firstError) {
      throw new Error(`graphql: ${firstError.message}`)
    }
    if (parsed.data == null) {
      // Mirrors Go client.go:91 — `data` was null/undefined where an object was expected.
      // `{"data":null}` from GitHub lands here rather than crashing the caller.
      throw new Error(`graphql: decode data: ${snippet(text)}`)
    }
    return parsed.data as T // eslint-disable-line @typescript-eslint/consistent-type-assertions -- T is the caller's expected shape; we cannot validate generic JSON against an arbitrary T at runtime without a schema lib. The envelope (`parsed`) is already type-guarded above, and `parsed.data == null` is explicitly rejected, so the only remaining escape hatch is shape-mismatch on T's own fields — caller-side optional chaining handles that.
  }

  /**
   * fetchWithTimeout wraps deps.fetch with an AbortController bound to
   * IO_TIMEOUT_MS — mirrors Go's `http.Client{Timeout: 30s}` (cli.go:47). On
   * timeout it throws `<errorPrefix>: timeout after <N>s` so the surrounding
   * wrapper preserves its prefix style.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IO_TIMEOUT_MS)
    try {
      return await this.d.fetch(url, { ...init, signal: controller.signal })
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`timeout after ${IO_TIMEOUT_MS / 1000}s`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** Headers attached to every request. */
  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.d.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "review-fixer",
    }
    if (withBody) h["Content-Type"] = "application/json"
    return h
  }
}

/** Flatten a raw GraphQL thread node into our Thread shape. */
export function toThread(node: ThreadNode): Thread {
  const comments = node.comments?.nodes ?? []
  const first = comments[0]
  if (!first) {
    // Blank-thread passthrough matches Go contract (empty comments → ghost row,
    // not skipped). Lets downstream renderers decide what to do with it.
    return {
      id: node.id,
      isResolved: node.isResolved ?? false,
      path: "",
      line: 0,
      rootCommentID: 0,
      author: "",
      body: "",
      replies: 0,
    }
  }
  return {
    id: node.id,
    isResolved: node.isResolved ?? false,
    path: first.path ?? "",
    line: first.line ?? 0,
    rootCommentID: first.databaseId ?? 0,
    author: first.author?.login ?? "",
    body: first.body ?? "",
    replies: Math.max(comments.length - 1, 0),
  }
}
