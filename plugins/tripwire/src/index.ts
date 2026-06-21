// opencode-tripwire — enforceable per-session cost/step budgets for OpenCode.
//
// Why: prose "tripwires" in prompts/CLAUDE.md don't bind — a runaway session
// ignores them. This plugin makes the limits MECHANICAL:
//   1. counts steps / cost / edits / tool-calls / per-file reads / compactions
//   2. injects a live running-budget line into the orchestrator's turn every step
//   3. at the WARN tier, injects a checkpoint nudge; at the HARD tier, aborts
//      (or blocks tools), so the session physically stops instead of ballooning.
//
// All thresholds/behaviour are config-driven — see config.ts and the example file.
//
// Limitation: cost is reported AFTER a step completes, so a ceiling stops
// the NEXT step; it cannot pre-empt an in-flight one. Adequate for runaway control.

import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { loadConfig, type TripwireConfig, type Budget } from "./config"

export type Metric = "cost" | "steps" | "edits" | "tools" | "compactions" | "reads"

export type SessionState = {
  cost: number
  steps: number
  edits: number
  tools: number
  compactions: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  reads: Map<string, number> // path -> count
  maxReads: number
  warned: Set<Metric>
  aborted: boolean
}

export const newState = (): SessionState => ({
  cost: 0,
  steps: 0,
  edits: 0,
  tools: 0,
  compactions: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reads: new Map(),
  maxReads: 0,
  warned: new Set(),
  aborted: false,
})

/** Current value of a metric for a session (reads = max count across files). */
function value(s: SessionState, m: Metric): number {
  if (m === "reads") return s.maxReads
  return s[m]
}

type Tier = "none" | "warn" | "hard"
function tier(v: number, b: Budget): Tier {
  if (b.hard != null && b.hard > 0 && v >= b.hard) return "hard"
  if (b.warn != null && b.warn > 0 && v >= b.warn) return "warn"
  return "none"
}

/** fmt() arguments bundled — keeps it under the 3-param lint ceiling. */
type FmtArgs = { msg: string; metric: string; value: number; limit: number }

function fmt(args: FmtArgs): string {
  return args.msg
    .replace("{metric}", args.metric)
    .replace("{value}", String(Math.round(args.value * 100) / 100))
    .replace("{limit}", String(args.limit))
}

/**
 * positiveLimit returns n only when it's a real positive ceiling; both `0`
 * (disabled, per the Budget contract) and `undefined` collapse to undefined.
 * Replaces the legacy `b.hard || undefined` shorthand without `||` (the
 * nullish-coalescing rule disallows it).
 */
function positiveLimit(n: number | undefined): number | undefined {
  return n != null && n > 0 ? n : undefined
}

/** Build the running-budget counter line shown to the model each turn. */
function counterLine(s: SessionState, cfg: TripwireConfig): string {
  const parts: string[] = []
  const metrics: Metric[] = ["cost", "steps", "edits", "tools", "compactions", "reads"]
  for (const m of metrics) {
    const b = cfg.budgets[m]
    const limit = positiveLimit(b.hard) ?? positiveLimit(b.warn)
    if (limit == null) continue
    const v = value(s, m)
    const shown = m === "cost" ? `$${v.toFixed(2)}/$${limit}` : `${v}/${limit}`
    const t = tier(v, b)
    const flag = t === "hard" ? "!!" : t === "warn" ? "!" : ""
    parts.push(`${m} ${shown}${flag}`)
  }
  const head =
    cfg.counter.format === "verbose"
      ? `${cfg.counter.label} session usage vs limits — `
      : `${cfg.counter.label} `
  return head + parts.join(" · ")
}

export type HardBreach = { metric: Metric; v: number; limit: number }
export type WarnBreach = { metric: Metric; message: string }

/**
 * Returns ALL hard-limit breaches plus per-metric warn messages for a session.
 *
 * Multiple metrics can cross their hard tier on the same step; each is reported
 * so callers can name every breach in the abort/block/inject message. Order
 * follows the `metrics` array (cost, steps, edits, tools, compactions, reads).
 */
export function evaluate(cfg: TripwireConfig, s: SessionState): {
  hard: HardBreach[]
  warns: WarnBreach[]
} {
  const hard: HardBreach[] = []
  const warns: WarnBreach[] = []
  const metrics: Metric[] = ["cost", "steps", "edits", "tools", "compactions", "reads"]
  for (const m of metrics) {
    const b = cfg.budgets[m]
    const v = value(s, m)
    const t = tier(v, b)
    // After tier() returned "hard"/"warn", the corresponding limit is
    // guaranteed > 0 (per the tier() guards above) — narrow with an explicit
    // `!= null` rather than `!` so the rule stays happy and TS still proves it.
    if (t === "hard" && b.hard != null) hard.push({ metric: m, v, limit: b.hard })
    if (t === "warn" && b.warn != null) {
      warns.push({ metric: m, message: fmt({ msg: cfg.messages.warn, metric: m, value: v, limit: b.warn }) })
    }
  }
  return { hard, warns }
}

/**
 * Format one breach's OWN value/limit for the multi-breach message. Cost gets a
 * `$` prefix (matches the counter line's unit convention); other metrics are
 * bare. Value rounding matches `fmt()` so single- and multi-breach messages agree.
 */
function formatMetric(h: HardBreach): string {
  const v = Math.round(h.v * 100) / 100
  return h.metric === "cost" ? `cost at $${v}/$${h.limit}` : `${h.metric} at ${v}/${h.limit}`
}

/**
 * Render the hard-tier message.
 *
 * Single breach: the configured `cfg.messages.hard` template is used VERBATIM
 * (fully user-customizable), interpolating that one metric's value/limit.
 *
 * Multiple breaches: the template has a single {value}/{limit} slot, so reusing
 * it would attribute the FIRST breach's numbers to every named metric (e.g.
 * "cost, steps hit 15 (limit 10)" made steps look 15/10 too). Instead each
 * metric is rendered with its OWN value/limit (see formatMetric) and the
 * per-metric fragments are joined, keeping the "TRIPWIRE HARD: … Stop now …"
 * framing. Tradeoff: the multi-breach wording is not template-driven (the
 * single-breach path — the common case — stays fully customizable).
 */
export function hardMessage(cfg: TripwireConfig, hard: HardBreach[]): string {
  if (hard.length === 0) return ""
  if (hard.length === 1) {
    const only = hard[0]
    return fmt({ msg: cfg.messages.hard, metric: only.metric, value: only.v, limit: only.limit })
  }
  const fragments = hard.map(formatMetric).join(", ")
  return `TRIPWIRE HARD: ${fragments}. Stop now — split the session or delegate the remaining work.`
}

/**
 * Wider-than-SDK view of an opencode event's `properties` payload. The SDK's
 * `Event` union is closed (specific `type` literals per variant), but tripwire
 * also consumes the custom `session.next.step.ended` event the orchestrator
 * emits at runtime without (yet) a typed variant. We widen each field so the
 * `event` hook can read its real payload without `any` smuggling. Production
 * events from the SDK satisfy this structurally.
 */
type EventProps = {
  sessionID?: string
  info?: { id?: string }
  cost?: unknown
  tokens?: {
    input?: unknown
    output?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
}

/**
 * Wider-than-SDK Event envelope: an optional `type` discriminator plus an
 * optional `properties` block (the only field every SDK variant carries).
 */
type TripwireEvent = {
  type?: string
  properties?: EventProps
}

/** Read a numeric `properties.cost` off an event payload (narrow without `as`). */
function readEventCost(p: EventProps | undefined): number | undefined {
  if (!p) return undefined
  return typeof p.cost === "number" ? p.cost : undefined
}

/** Read an event's token block as a numeric struct (or undefined). */
function readEventTokens(p: EventProps | undefined): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} | undefined {
  const t = p?.tokens
  if (!t) return undefined
  const input = typeof t.input === "number" ? t.input : 0
  const output = typeof t.output === "number" ? t.output : 0
  const cr = typeof t.cache?.read === "number" ? t.cache.read : 0
  const cw = typeof t.cache?.write === "number" ? t.cache.write : 0
  return { input, output, cacheRead: cr, cacheWrite: cw }
}

/**
 * Structural input shape for the tool.execute.* hooks as tripwire uses them.
 * The SDK's Hooks interface declares `args: any`; we narrow with explicit
 * runtime checks (readToolArgs) so the lint's no-unsafe-* rules stay happy.
 */
type ToolInputLike = {
  tool?: string
  sessionID?: string
  args?: unknown
}

/** Read a `filePath | path | file` path argument off a tool input safely. */
function readToolPath(input: ToolInputLike): string {
  const a = input.args
  if (typeof a !== "object" || a === null || Array.isArray(a)) return "?"
  // Object.entries lets us read keys off the `object`-typed value without an
  // `as` cast (the `typeof === "object"` narrow yields `object`, which has no
  // index signature).
  for (const [k, v] of Object.entries(a)) {
    if ((k === "filePath" || k === "path" || k === "file") && typeof v === "string") {
      return v
    }
  }
  return "?"
}

/** Render an unknown caught value as a message string (Error → message; else String). */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * TripwirePlugin entry point. Plain (non-async) arrow returning Promise.resolve
 * so the require-await rule stays clean — the outer entry point does not await;
 * only the inner hooks (which DO await client.session.abort) do.
 */
export const TripwirePlugin: Plugin = ({ client, directory }, options?: unknown) => {
  const cfg = loadConfig(directory, options)
  if (!cfg.enabled) return Promise.resolve({})

  const sessions = new Map<string, SessionState>()
  const get = (id: string) => {
    let s = sessions.get(id)
    if (!s) sessions.set(id, (s = newState()))
    return s
  }

  return Promise.resolve({
    // Accumulate cost/steps as each step finishes, then enforce the ceiling.
    event: async ({ event }: { event: TripwireEvent }) => {
      // Guard against SDK schema drift: if event is missing/malformed, degrade
      // to a no-op rather than throwing (which would reject the hook promise).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense; TS types say event is always defined but the SDK could violate that
      if (!event || typeof event.type !== "string") return
      const type = event.type
      const p: EventProps | undefined = event.properties

      // Evict per-session state when the session is deleted so the `sessions`
      // Map (and each session's `reads` Map) can't grow unbounded over the
      // lifetime of a long-running orchestrator process. The opencode SDK
      // emits `session.deleted` on explicit delete and end-of-life cleanup;
      // v1 carries info.id, v2 carries both sessionID and info.
      if (type === "session.deleted") {
        const id = p?.sessionID ?? p?.info?.id
        if (id) sessions.delete(id)
        return
      }

      if (type !== "session.next.step.ended") return
      const id = p?.sessionID
      if (!id) return
      const s = get(id)
      s.steps++
      const cost = readEventCost(p)
      if (cost !== undefined) s.cost += cost
      const tokens = readEventTokens(p)
      if (tokens) {
        s.tokensIn += tokens.input
        s.tokensOut += tokens.output
        s.cacheRead += tokens.cacheRead
        s.cacheWrite += tokens.cacheWrite
      }

      // Optional JSONL session-summary logging (cumulative; one line per N steps).
      // every may arrive non-numeric via untyped JSONC/plugin-option merge — clamp.
      const everyN = Math.floor(Number(cfg.log.every))
      const every = Number.isFinite(everyN) && everyN >= 1 ? everyN : 1
      if (cfg.log.enabled && s.steps % every === 0) {
        try {
          const line = JSON.stringify({
            ts: new Date().toISOString(),
            sessionID: id,
            directory,
            steps: s.steps,
            cost: s.cost,
            tokensIn: s.tokensIn,
            tokensOut: s.tokensOut,
            cacheRead: s.cacheRead,
            cacheWrite: s.cacheWrite,
            edits: s.edits,
            tools: s.tools,
            compactions: s.compactions,
          })
          // node:fs does not expand ~ — resolve a leading ~/ to the home dir.
          const logPath = cfg.log.path.startsWith("~/") ? join(homedir(), cfg.log.path.slice(2)) : cfg.log.path
          fs.mkdirSync(dirname(logPath), { recursive: true })
          fs.appendFileSync(logPath, line + "\n")
        } catch {
          // Note: logging must never throw into the hook; silent-degrade by contract
        }
      }

      const { hard } = evaluate(cfg, s)
      if (hard.length > 0 && cfg.onHard === "abort" && !s.aborted) {
        s.aborted = true
        console.warn(`[opencode-tripwire] ${hardMessage(cfg, hard)} — aborting session ${id}`)
        try {
          await client.session.abort({ path: { id } })
        } catch (e) {
          console.warn(`[opencode-tripwire] abort failed: ${errorMessage(e)}`)
        }
      }
    },

    // Block tools once a hard tier is active. Must run BEFORE the tool so the
    // throw actually prevents it; counting happens in tool.execute.after. Body
    // is synchronous, but the SDK's hook contract is `Promise<void>` (a throw
    // must become a rejected promise); declared `async` for that contract even
    // though no `await` happens inside.
    // eslint-disable-next-line @typescript-eslint/require-await -- hook must be async to satisfy the SDK's Promise<void> hook contract so a thrown Error rejects the promise; the body happens to be synchronous.
    "tool.execute.before": async (input: ToolInputLike) => {
      const id = input.sessionID
      if (!id) return
      const s = get(id)
      const tool = input.tool
      if (!tool) return
      if (cfg.onHard === "block") {
        const { hard } = evaluate(cfg, s)
        if (hard.length > 0 && cfg.blockTools.includes(tool)) {
          throw new Error(`[opencode-tripwire] ${hardMessage(cfg, hard)} — '${tool}' blocked.`)
        }
      }
    },

    // Count tool usage AFTER it runs so failed/denied calls don't inflate budgets.
    // eslint-disable-next-line @typescript-eslint/require-await -- hook must be async to satisfy the SDK's Promise<void> hook contract; body is synchronous.
    "tool.execute.after": async (input: ToolInputLike) => {
      const id = input.sessionID
      if (!id) return
      const s = get(id)
      const tool = input.tool
      if (!tool) return
      s.tools++
      if (cfg.toolClasses.edit.includes(tool)) s.edits++
      if (cfg.toolClasses.compact.includes(tool)) s.compactions++
      if (cfg.toolClasses.read.includes(tool)) {
        const path = readToolPath(input)
        const n = (s.reads.get(path) ?? 0) + 1
        s.reads.set(path, n)
        if (n > s.maxReads) s.maxReads = n
      }
    },

    // Inject the live counter (+ any new warn nudges) into the model's turn.
    // eslint-disable-next-line @typescript-eslint/require-await -- hook must be async to satisfy the SDK's Promise<void> hook contract; body is synchronous.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const id = input.sessionID
      if (!id) return
      const s = get(id)
      if (cfg.counter.inject) output.system.push(counterLine(s, cfg))
      if (cfg.onWarn === "inject") {
        const { warns } = evaluate(cfg, s)
        for (const w of warns) {
          if (s.warned.has(w.metric)) continue
          s.warned.add(w.metric)
          output.system.push(w.message)
        }
      }
      if (cfg.onHard === "inject") {
        const { hard } = evaluate(cfg, s)
        if (hard.length > 0) output.system.push(hardMessage(cfg, hard))
      }
    },
  })
}

export default TripwirePlugin
