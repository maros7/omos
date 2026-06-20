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
import { dirname } from "node:path"
import { loadConfig, type TripwireConfig, type Budget } from "./config"

type Metric = "cost" | "steps" | "edits" | "tools" | "compactions" | "reads"

type SessionState = {
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

const newState = (): SessionState => ({
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

export const TripwirePlugin: Plugin = async ({ client, directory }, options?: unknown) => {
  const cfg = loadConfig(directory, options)
  if (!cfg.enabled) return {}

  const sessions = new Map<string, SessionState>()
  const get = (id: string) => {
    let s = sessions.get(id)
    if (!s) sessions.set(id, (s = newState()))
    return s
  }

  /** Returns the highest active tier across all metrics + per-metric warn messages. */
  function evaluate(s: SessionState): {
    hard: { metric: Metric; v: number; limit: number } | null
    warns: { metric: Metric; message: string }[]
  } {
    let hard: { metric: Metric; v: number; limit: number } | null = null
    const warns: { metric: Metric; message: string }[] = []
    const metrics: Metric[] = ["cost", "steps", "edits", "tools", "compactions", "reads"]
    for (const m of metrics) {
      const b = cfg.budgets[m]
      const v = value(s, m)
      const t = tier(v, b)
      if (t === "hard" && !hard) hard = { metric: m, v, limit: b.hard! }
      if (t === "warn") warns.push({ metric: m, message: fmt(cfg.messages.warn, m, v, b.warn!) })
    }
    return { hard, warns }
  }

  return {
    // Accumulate cost/steps as each step finishes, then enforce the ceiling.
    event: async ({ event }: any) => {
      // ponytail: property path per opencode event schema; guarded so a schema
      // drift degrades to "no cost tracking" rather than throwing.
      const type = event?.type
      if (type !== "session.next.step.ended") return
      const p = event.properties ?? event
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
      if (cfg.log.enabled && s.steps % Math.max(1, cfg.log.every) === 0) {
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
          fs.mkdirSync(dirname(cfg.log.path), { recursive: true })
          fs.appendFileSync(cfg.log.path, line + "\n")
        } catch (e: any) {
          // ponytail: logging must never throw into the hook — silently degrade.
          console.warn(`[opencode-tripwire] session log append failed: ${e?.message}`)
        }
      }

      const { hard } = evaluate(s)
      if (hard && cfg.onHard === "abort" && !s.aborted) {
        s.aborted = true
        console.warn(`[opencode-tripwire] ${fmt(cfg.messages.hard, hard.metric, hard.v, hard.limit)} — aborting session ${id}`)
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
        const { hard } = evaluate(s)
        if (hard && cfg.blockTools.includes(tool)) {
          throw new Error(`[opencode-tripwire] ${fmt(cfg.messages.hard, hard.metric, hard.v, hard.limit)} — '${tool}' blocked.`)
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
        const { warns } = evaluate(s)
        for (const w of warns) {
          if (s.warned.has(w.metric)) continue
          s.warned.add(w.metric)
          output.system.push(w.message)
        }
      }
      if (cfg.onHard === "inject") {
        const { hard } = evaluate(s)
        if (hard) output.system.push(fmt(cfg.messages.hard, hard.metric, hard.v, hard.limit))
      }
    },
  }
}

export default TripwirePlugin
