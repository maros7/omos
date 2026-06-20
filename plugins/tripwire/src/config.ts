// Config loading for opencode-tripwire.
//
// Everything here is tunable WITHOUT editing plugin code. Precedence (low→high):
//   built-in defaults  <  PluginOptions (opencode.json)  <  user file  <  project file  <  env vars
//
// Config files (JSON or JSONC, comments + trailing commas allowed):
//   user:    $XDG_CONFIG_HOME/opencode/opencode-tripwire.json[c]  (or ~/.config/opencode/…)
//   project: <cwd>/.opencode/opencode-tripwire.json[c]
//
// ponytail: zero deps — manual merge + tiny JSONC stripper instead of a schema lib.

import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

/** A single metric's two-tier budget. Set a tier to 0/undefined to disable it. */
export type Budget = { warn?: number; hard?: number }

export type TripwireConfig = {
  enabled: boolean
  /** Per-metric budgets. Any metric omitted = untracked for tripping (still counted). */
  budgets: {
    cost: Budget // accumulated USD for the session
    steps: Budget // assistant steps (model turns)
    edits: Budget // edit/write tool calls
    tools: Budget // total tool calls
    compactions: Budget // compress/compaction calls
    reads: Budget // reads of the SAME file (per-path count)
  }
  /** What counts as an edit / read / compaction tool (tool names from opencode). */
  toolClasses: { edit: string[]; read: string[]; compact: string[] }
  counter: {
    inject: boolean // show a running budget line in the system prompt each turn
    format: "compact" | "verbose"
    label: string // prefix for the injected line
  }
  /** Action when a metric crosses its WARN tier. */
  onWarn: "inject" | "off"
  /** Action when a metric crosses its HARD tier. */
  onHard: "abort" | "block" | "inject" | "off"
  /** Tools to block (throw) when onHard === "block" and a hard tier is active. */
  blockTools: string[]
  /** Fully customizable injected text. {metric} {value} {limit} are interpolated. */
  messages: { warn: string; hard: string }
  /** Opt-in JSONL session-summary logging (one cumulative line per N steps). */
  log: { enabled: boolean; path: string; every: number }
}

export const DEFAULTS: TripwireConfig = {
  enabled: true,
  budgets: {
    cost: { warn: 5, hard: 12 },
    steps: { warn: 40, hard: 120 },
    edits: { warn: 10, hard: 50 },
    tools: { warn: 80, hard: 250 },
    compactions: { warn: 2, hard: 4 },
    reads: { warn: 2, hard: 5 },
  },
  toolClasses: {
    edit: ["edit", "write", "patch", "apply_patch", "multiedit"],
    read: ["read"],
    compact: ["compress", "compact"],
  },
  counter: {
    inject: true,
    format: "compact",
    label: "[BUDGET]",
  },
  onWarn: "inject",
  onHard: "abort",
  blockTools: ["bash", "write", "edit", "patch", "apply_patch"],
  messages: {
    warn: "TRIPWIRE WARN: {metric} at {value} (warn {limit}). Wrap up the current step, checkpoint, and consider splitting or delegating before continuing.",
    hard: "TRIPWIRE HARD: {metric} hit {value} (limit {limit}). Stop now — split the session or delegate the remaining work.",
  },
  log: {
    enabled: false,
    path: join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "opencode",
      "opencode-tripwire.sessions.jsonl",
    ),
    every: 1,
  },
}

/** Strip // and /* *​/ comments and trailing commas so JSONC parses as JSON. */
function parseJsonc(text: string): unknown {
  let out = ""
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === "\n") { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i++ }
      continue
    }
    if (inStr) {
      out += c
      if (c === "\\") { out += n; i++; continue } // copy escaped char verbatim
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === "/" && n === "/") { inLine = true; i++; continue }
    if (c === "/" && n === "*") { inBlock = true; i++; continue }
    if (c === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue // drop trailing comma
    }
    out += c
  }
  return JSON.parse(out)
}

function readConfigFile(path: string): Partial<TripwireConfig> | null {
  for (const ext of [".jsonc", ".json"]) {
    try {
      return parseJsonc(readFileSync(path + ext, "utf8")) as Partial<TripwireConfig>
    } catch (e: any) {
      if (e?.code === "ENOENT") continue
      console.warn(`[opencode-tripwire] ignoring invalid config ${path}${ext}: ${e?.message}`)
    }
  }
  return null
}

/** Deep-merge that only overrides keys present in `over` (objects merged, scalars/arrays replaced). */
function merge<T>(base: T, over: any): T {
  if (over == null) return base
  if (Array.isArray(over) || typeof over !== "object") return over as T
  const out: any = { ...base }
  for (const k of Object.keys(over)) {
    const b = (base as any)?.[k]
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, over[k]) : over[k]
  }
  return out
}

function envOverrides(): Partial<TripwireConfig> {
  const e = process.env
  const num = (v?: string) => (v != null && v !== "" && !isNaN(+v) ? +v : undefined)
  const o: any = { budgets: {} }
  if (e.OPENCODE_TRIPWIRE_DISABLED === "1" || e.OPENCODE_TRIPWIRE === "off") o.enabled = false
  if (e.OPENCODE_TRIPWIRE_LOG && e.OPENCODE_TRIPWIRE_LOG !== "0" && e.OPENCODE_TRIPWIRE_LOG !== "off") {
    o.log = { ...(o.log ?? {}), enabled: true }
  }
  if (e.OPENCODE_TRIPWIRE_LOG_PATH) o.log = { ...(o.log ?? {}), path: e.OPENCODE_TRIPWIRE_LOG_PATH }
  if (e.OPENCODE_TRIPWIRE_LOG_EVERY) {
    const n = parseInt(e.OPENCODE_TRIPWIRE_LOG_EVERY, 10)
    if (!isNaN(n)) o.log = { ...(o.log ?? {}), every: n }
  }
  const map: Record<string, string> = {
    OPENCODE_TRIPWIRE_COST_HARD: "cost",
    OPENCODE_TRIPWIRE_STEPS_HARD: "steps",
    OPENCODE_TRIPWIRE_EDITS_HARD: "edits",
    OPENCODE_TRIPWIRE_TOOLS_HARD: "tools",
    OPENCODE_TRIPWIRE_COMPACTIONS_HARD: "compactions",
    OPENCODE_TRIPWIRE_READS_HARD: "reads",
  }
  for (const [k, metric] of Object.entries(map)) {
    const n = num(e[k])
    if (n != null) o.budgets[metric] = { hard: n }
  }
  if (e.OPENCODE_TRIPWIRE_ON_HARD) {
    const v = e.OPENCODE_TRIPWIRE_ON_HARD
    if (["abort", "block", "inject", "off"].includes(v)) o.onHard = v
    else console.warn(`[opencode-tripwire] ignoring invalid OPENCODE_TRIPWIRE_ON_HARD: ${v}`)
  }
  return o
}

/** Resolve the effective config from all layers. `directory` is the project cwd. */
export function loadConfig(directory: string, pluginOptions?: unknown): TripwireConfig {
  const cfgDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")

  const userFile = readConfigFile(join(cfgDir, "opencode-tripwire"))
  const projectFile = readConfigFile(join(directory, ".opencode", "opencode-tripwire"))

  let cfg: TripwireConfig = DEFAULTS
  cfg = merge(cfg, pluginOptions)
  cfg = merge(cfg, userFile)
  cfg = merge(cfg, projectFile)
  cfg = merge(cfg, envOverrides())
  return cfg
}
