// rewrite.ts — turn `go build` / `go test` / `go vet` / `golangci-lint run`
// commands into gogate invocations by prepending gogate. gogate parses the command
// itself (injecting -json -cover etc.). Commands are first split on top-level shell
// control operators so recognized commands inside pipes/redirects/chains are wrapped
// individually while the surrounding shell structure is reassembled verbatim.

import { splitShell } from "./shell"
import { tokenize } from "./tokenize"

// Commands gogate wraps. `go vet` is run as real `go vet` (not golangci-lint), so any
// vet args are fine to forward.
const RECOGNIZED = /^(go (build|test|vet)|golangci-lint run)\b/

// One or more leading POSIX env-var assignments (`NAME=VALUE`, VALUE is a single
// shell word — no whitespace, even when quoted, so `FOO="a b"` is not recognized
// and passes through unwrapped) plus the whitespace separating them from the
// command. Lets us wrap `GOWORK=off go build ./...` (Go workspaces) and CGO
// toggles like `CGO_ENABLED=0 go test ./...` while leaving a bare `go build`
// untouched.
const LEADING_ENV = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*)(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s*/

// `rtk` is a toolchain wrapper that only minimizes output (same goal as gogate); strip it
// when it directly precedes a recognized command (optionally after env assignments) so
// `[ENV] rtk go build ./...` becomes a gogate-wrapped `go build ./...`.
const LEADING_RTK = /^rtk\s+/

// rewriteGoCommand returns the command with each recognized, safe-to-wrap segment
// wrapped in the gogate prefix, or null to leave the command unchanged. binPrefix is
// the resolved gogate argv; gogateFlags are gogate's own flags (e.g. -rerun-fails=2)
// and go before each wrapped command.
export function rewriteGoCommand(
  cmd: string,
  binPrefix: string[],
  gogateFlags: string[] = [],
): string | null {
  if (!cmd.trim()) return null
  const split = splitShell(cmd)
  if (!split) return null

  const wrapped = split.segments.map((seg) => wrapSegment(seg, binPrefix, gogateFlags))
  if (wrapped.every((w) => w === null)) return null

  const dropped = computeDropped(split.segments, wrapped)

  const removedOps = new Set<number>()
  for (const k of dropped) removedOps.add(k - 1)

  const keptSegs: string[] = []
  for (let i = 0; i < split.segments.length; i += 1) {
    if (dropped.has(i)) continue
    keptSegs.push(wrapped[i] ?? split.segments[i])
  }
  const keptOps: string[] = []
  for (let j = 0; j < split.operators.length; j += 1) {
    if (!removedOps.has(j)) keptOps.push(split.operators[j])
  }

  let result = keptSegs[0]
  for (let j = 0; j < keptOps.length; j += 1) result += keptOps[j] + keptSegs[j + 1]
  return dropped.size > 0 ? result.replace(/\s+$/, "") : result
}

// computeDropped finds recognized segments that redundantly re-gate a directory already
// gated by an earlier kept segment. gogate runs its whole gate over the target package
// regardless of subcommand, so build/test/vet/lint on the same dir collapse to one. The
// operator BEFORE a dropped segment is removed by reassembly, so a trailing pipe (e.g.
// `| tail`) reconnects to the surviving gate; a dropped duplicate's own inline redirect
// (e.g. `2>&1`) is discarded with it (harmless — gogate merges stderr).
function computeDropped(segments: string[], wrapped: (string | null)[]): Set<number> {
  const dropped = new Set<number>()
  const seen = new Set<string>()
  for (let i = 0; i < segments.length; i += 1) {
    if (wrapped[i] === null) continue
    const key = segmentTarget(segments[i])
    if (key === null) continue
    if (seen.has(key)) dropped.add(i)
    else seen.add(key)
  }
  return dropped
}

// segmentTarget builds a dedup key for a recognized segment: its env prefix plus the sorted
// set of package-path operands (after env-peel + rtk-strip). Returns null for a segment that
// is not a recognized go/golangci command. Heuristic + conservative: a token is treated as a
// package path only if it does not start with "-" and looks path-like (starts with "." or "/"
// or contains "/"); flag values that happen to look like paths only make the key MORE specific
// (less collapsing), never less — so two genuinely different targets never share a key.
function segmentTarget(seg: string): string | null {
  const trimmed = seg.trim()
  const envPart = trimmed.match(LEADING_ENV)?.[0] ?? ""
  const rest = trimmed.slice(envPart.length).replace(LEADING_RTK, "")
  if (!RECOGNIZED.test(rest)) return null
  const operands = tokenize(rest).slice(2) // drop the 2 subcommand tokens (go build | golangci-lint run)
  const paths = operands
    .filter((t) => !t.startsWith("-") && (t.startsWith(".") || t.startsWith("/") || t.includes("/")))
    .map((t) => (t.length > 1 && t.endsWith("/") ? t.slice(0, -1) : t))
    .sort()
  const target = paths.length > 0 ? paths : ["."]
  return `${envPart.trim()}\u0000${target.join("\u0001")}`
}

// wrapSegment wraps one pipeline segment when its command (after env-peel + rtk-strip) is a
// recognized go/golangci command; returns null to leave the segment unchanged. Leading and
// trailing whitespace are preserved so reassembly is byte-exact.
function wrapSegment(seg: string, binPrefix: string[], gogateFlags: string[]): string | null {
  const lead = seg.match(/^\s*/)?.[0] ?? ""
  const trail = seg.match(/\s*$/)?.[0] ?? ""
  const core = seg.slice(lead.length, seg.length - trail.length)
  if (!core) return null

  const envPart = core.match(LEADING_ENV)?.[0] ?? ""
  let rest = core.slice(envPart.length)
  rest = rest.replace(LEADING_RTK, "")
  if (!rest) return null

  const leader = rest.split(/\s+/)[0]
  const base = leader.split(/[\\/]/).pop() ?? leader
  if (base === "gogate" || base === "gogate.exe") return null
  if (!RECOGNIZED.test(rest)) return null

  const quoted = [...binPrefix, ...gogateFlags].map(shellQuote)
  return `${lead}${envPart}${quoted.join(" ")} ${rest}${trail}`
}

// shellQuote single-quotes a segment for POSIX shells, escaping embedded single
// quotes via the '\'' idiom.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
