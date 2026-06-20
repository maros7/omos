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

function fmt(msg: string, metric: string, value: number, limit: number): string {
  return msg
    .replace("{metric}", metric)
    .replace("{value}", String(Math.round(value * 100) / 100))
    .replace("{limit}", String(limit))
}

/** Build the running-budget counter line shown to the model each turn. */
function counterLine(s: SessionState, cfg: TripwireConfig): string {
  const parts: string[] = []
  const metrics: Metric[] = ["cost", "steps", "edits", "tools", "compactions", "reads"]
  for (const m of metrics) {
    const b = cfg.budgets[m]
    const limit = (b?.hard || undefined) ?? (b?.warn || undefined)
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
    if (t === "hard") hard.push({ metric: m, v, limit: b.hard! })
    if (t === "warn") warns.push({ metric: m, message: fmt(cfg.messages.warn, m, v, b.warn!) })
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
    return fmt(cfg.messages.hard, only.metric, only.v, only.limit)
  }
  const fragments = hard.map(formatMetric).join(", ")
  return `TRIPWIRE HARD: ${fragments}. Stop now — split the session or delegate the remaining work.`
}

export const TripwirePlugin: Plugin = async ({ client, directory }, options?: unknown) => {
  const cfg = loadConfig(directory, options)
  if (!cfg.enabled) return {}

  const sessions = new Map<string, SessionState>()
  const get = (id: string) => {
    let s = sessions.get(id)
    if (!s) sessions.set(id, (s = newState()))
    return s
  }

  return {
    // Accumulate cost/steps as each step finishes, then enforce the ceiling.
    event: async ({ event }: any) => {
      // Note: property path per opencode event schema; guarded so a schema
      // drift degrades to "no cost tracking" rather than throwing.
      const type = event?.type
      const p = event.properties ?? event

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
      if (typeof p.cost === "number") s.cost += p.cost
      s.tokensIn += p.tokens?.input ?? 0
      s.tokensOut += p.tokens?.output ?? 0
      s.cacheRead += p.tokens?.cache?.read ?? 0
      s.cacheWrite += p.tokens?.cache?.write ?? 0

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
        } catch (e: any) {
          console.warn(`[opencode-tripwire] abort failed: ${e?.message}`)
        }
      }
    },

    // Block tools once a hard tier is active. Must run BEFORE the tool so the
    // throw actually prevents it; counting happens in tool.execute.after.
    "tool.execute.before": async (input: any, output: any) => {
      const id = input?.sessionID
      if (!id) return
      const s = get(id)
      const tool = input.tool
      if (cfg.onHard === "block") {
        const { hard } = evaluate(cfg, s)
        if (hard.length > 0 && cfg.blockTools.includes(tool)) {
          throw new Error(`[opencode-tripwire] ${hardMessage(cfg, hard)} — '${tool}' blocked.`)
        }
      }
    },

    // Count tool usage AFTER it runs so failed/denied calls don't inflate budgets.
    "tool.execute.after": async (input: any, output: any) => {
      const id = input?.sessionID
      if (!id) return
      const s = get(id)
      const tool = input.tool
      s.tools++
      if (cfg.toolClasses.edit.includes(tool)) s.edits++
      if (cfg.toolClasses.compact.includes(tool)) s.compactions++
      if (cfg.toolClasses.read.includes(tool)) {
        const path = input?.args?.filePath ?? input?.args?.path ?? input?.args?.file ?? "?"
        const n = (s.reads.get(path) ?? 0) + 1
        s.reads.set(path, n)
        if (n > s.maxReads) s.maxReads = n
      }
    },

    // Inject the live counter (+ any new warn nudges) into the model's turn.
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const id = input?.sessionID
      if (!id || !Array.isArray(output?.system)) return
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
  }
}

export default TripwirePlugin
