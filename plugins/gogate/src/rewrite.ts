// rewrite.ts — turn `go build` / `go test` / `go vet` / `golangci-lint run`
// commands into gogate invocations by prepending gogate. gogate parses the command
// itself (injecting -json -cover etc.). Commands are first split on top-level shell
// control operators so recognized commands inside pipes/redirects/chains are wrapped
// individually while the surrounding shell structure is reassembled verbatim.

import { splitShell } from "./shell"

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
  if (!split) return null // dangerous construct → leave the whole command unchanged

  const out = split.segments.map((seg) => wrapSegment(seg, binPrefix, gogateFlags) ?? seg)
  const wrappedAny = out.some((seg, i) => seg !== split.segments[i])
  if (!wrappedAny) return null

  let result = out[0]
  for (let i = 0; i < split.operators.length; i += 1) result += split.operators[i] + out[i + 1]
  return result
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
