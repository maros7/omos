// Config loading for opencode-tripwire.
//
// Everything here is tunable WITHOUT editing plugin code. Precedence (low→high):
//   built-in defaults  <  PluginOptions (opencode.json)  <  user file  <  project file  <  env vars
//
// Config files (JSON or JSONC, comments + trailing commas allowed):
//   user:    $XDG_CONFIG_HOME/opencode/opencode-tripwire.json[c]  (or ~/.config/opencode/…)
//   project: <cwd>/.opencode/opencode-tripwire.json[c]
//
// Note: zero deps — manual merge + tiny JSONC stripper instead of a schema lib.

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

/** Advance past whitespace and line/block comments starting at `start`. Used by the trailing-comma stripper. */
function skipTrivia(text: string, start: number): number {
  let j = start
  while (j < text.length) {
    if (text[j] === "/" && text[j + 1] === "/") {
      j += 2
      while (j < text.length && text[j] !== "\n") j++
    } else if (text[j] === "/" && text[j + 1] === "*") {
      j += 2
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++
      j += 2 // skip the closing */
    } else if (/\s/.test(text[j])) {
      j++
    } else {
      break
    }
  }
  return j
}

/** Strip // and /* *​/ comments and trailing commas so JSONC parses as JSON. */
export function parseJsonc(text: string): unknown {
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
      // Drop the comma if only trivia (whitespace + comments) separates it
      // from the enclosing `}` or `]`.
      const j = skipTrivia(text, i + 1)
      if (text[j] === "}" || text[j] === "]") continue // drop trailing comma
    }
    out += c
  }
  return JSON.parse(out)
}

/** Type guard: x is a non-null, non-array object (a JSON object). */
function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x)
}

/**
 * Narrow a parsed JSONC value to a Partial<TripwireConfig>. We don't ship a
 * schema validator, so the structural check is "did JSON.parse produce an
 * object?"; the typed merge downstream tolerates unknown keys and missing
 * fields (treats them as "don't override"). Anything that *is* present flows
 * through merge() and gets type-checked at the consumer.
 */
function toPartialConfig(x: unknown): Partial<TripwireConfig> {
  return isRecord(x) ? { ...x } : {}
}

function readConfigFile(path: string): Partial<TripwireConfig> | null {
  for (const ext of [".jsonc", ".json"]) {
    try {
      return toPartialConfig(parseJsonc(readFileSync(path + ext, "utf8")))
    } catch (e: unknown) {
      // ENOENT → try the next extension; anything else → warn and skip.
      if (readErrorCode(e) === "ENOENT") continue
      console.warn(`[opencode-tripwire] ignoring invalid config ${path}${ext}: ${errorMessage(e)}`)
    }
  }
  return null
}

/** Read `.code` off an unknown caught value (Node sets it on fs errors). No `as`. */
function readErrorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    return typeof e.code === "string" ? e.code : undefined
  }
  return undefined
}

/** Render an unknown caught value as a message string (Error → message; else String). */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Deep-merge that only overrides keys present in `over` (objects merged, scalars/arrays replaced).
 *
 * Note: explicit `null` is treated as "keep base" — there is NO delete sentinel.
 * `merge(base, null)` early-returns `base` (see the `over == null` guard below),
 * so a user cannot null-out a nested config block by passing `{ budgets: null }`,
 * `{ messages: null }`, etc. This is intentional: config blocks carry required
 * keys with sensible defaults, and a partial override must not be able to wipe
 * a whole required subtree. Omitting a metric (or passing `{}`) keeps its
 * defaults — it does NOT disable the budget. To disable a metric's budget,
 * explicitly set its tiers to 0 (or, for programmatic PluginOptions,
 * `undefined`) — do not rely on `null` or omission to clear it.
 */
export function merge<T>(base: T, over: unknown): T {
  if (over == null) return base
  // Primitives and arrays replace wholesale; reconciling an arbitrary JSON
  // value with a static generic T needs runtime validation we deliberately
  // don't ship (zero-dep plugin), so we trust the caller's T at this branch —
  // same envelope-trust pattern review-fixer uses for `parsed.data as T`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- over is JSON-derived data we trust to be T at this branch (callers pass Partial<T> shapes); narrowing arbitrary unknown to a generic T requires runtime validation this zero-dep plugin does not ship.
  if (!isRecord(over) || !isRecord(base)) return over as T
  const out: Record<string, unknown> = { ...base }
  for (const k of Object.keys(over)) {
    const overVal: unknown = over[k]
    const baseVal: unknown = base[k]
    out[k] = isRecord(baseVal) ? merge(baseVal, overVal) : overVal
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- out started as {...base} and only had existing keys overwritten with JSON values from `over`; structurally compatible with T per merge's documented contract.
  return out as T
}

/** Keys of the budgets block — used to type env-var → metric mapping safely. */
type BudgetKey = keyof TripwireConfig["budgets"]

/**
 * Build the env-var override layer. Returned shape is a plain record (not
 * Partial<TripwireConfig>) because Partial<TripwireConfig>.budgets requires
 * every metric key — but env vars only ever set a subset. merge() takes
 * `over: unknown` so the record flows straight through.
 */
function envOverrides(): Record<string, unknown> {
  const e = process.env
  const num = (v?: string) => (v != null && v !== "" && !isNaN(+v) ? +v : undefined)
  const o: {
    enabled?: boolean
    onHard?: "abort" | "block" | "inject" | "off"
    log?: Partial<{ enabled: boolean; path: string; every: number }>
    budgets: Partial<Record<BudgetKey, Budget>>
  } = { budgets: {} }

  if (e.OPENCODE_TRIPWIRE_DISABLED === "1" || e.OPENCODE_TRIPWIRE === "off") o.enabled = false

  const logPatch: { enabled?: boolean; path?: string; every?: number } = {}
  if (e.OPENCODE_TRIPWIRE_LOG != null) {
    const falsy = new Set(["0", "false", "off", "no", ""])
    logPatch.enabled = !falsy.has(e.OPENCODE_TRIPWIRE_LOG.toLowerCase())
  }
  if (e.OPENCODE_TRIPWIRE_LOG_PATH) logPatch.path = e.OPENCODE_TRIPWIRE_LOG_PATH
  if (e.OPENCODE_TRIPWIRE_LOG_EVERY) {
    const n = parseInt(e.OPENCODE_TRIPWIRE_LOG_EVERY, 10)
    if (!isNaN(n)) logPatch.every = n
  }
  if (Object.keys(logPatch).length > 0) o.log = logPatch

  const map: Record<string, BudgetKey> = {
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
    if (v === "abort" || v === "block" || v === "inject" || v === "off") o.onHard = v
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
