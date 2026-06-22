// rewrite.ts — turn a raw `go build` / `go test` / `go vet` / `golangci-lint run`
// command into a gogate invocation by prepending gogate. gogate parses the command
// itself (injecting -json -cover etc.), so there is nothing to split here.

// Shell metacharacters that make wrapping unsafe (pipes, chaining, redirects,
// substitution, backgrounding, newlines): leave such commands alone.
const SHELL_META = /[|&;<>`\n()]|\$\(/

// Commands gogate wraps. `go vet` is run as real `go vet` (not golangci-lint), so any
// vet args are fine to forward.
const RECOGNIZED = /^(go (build|test|vet)|golangci-lint run)\b/

// One or more leading POSIX env-var assignments (`NAME=VALUE`, VALUE has no
// unquoted whitespace) plus the whitespace separating them from the command.
// Lets us wrap `GOWORK=off go build ./...` (Go workspaces) and CGO toggles like
// `CGO_ENABLED=0 go test ./...` while leaving a bare `go build` untouched.
const LEADING_ENV = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*)(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s*/

// rewriteGoCommand returns "<binPrefix> <gogateFlags> <cmd>" for a recognized,
// safe-to-wrap command, or null to leave the command unchanged. binPrefix is the
// resolved gogate argv; gogateFlags are gogate's own flags (e.g. -rerun-fails=2) and go
// before the wrapped command.
export function rewriteGoCommand(
  cmd: string,
  binPrefix: string[],
  gogateFlags: string[] = [],
): string | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null
  if (SHELL_META.test(trimmed)) return null

  // Peel any leading POSIX env-var assignments (`VAR=val`, one or more) so
  // workspace/multi-module commands like `GOWORK=off go build ./...` and CGO
  // toggles like `CGO_ENABLED=0 go test ./...` are still captured. The
  // assignments must stay BEFORE the gogate binary so the shell exports them
  // into gogate's environment (and thus the `go` subprocesses it spawns).
  const envMatch = trimmed.match(LEADING_ENV)
  const envPart = envMatch ? envMatch[0] : ""
  const rest = trimmed.slice(envPart.length)
  if (!rest) return null

  // Skip only when the leading program is already gogate (not when "gogate"
  // appears as a path/arg elsewhere, e.g. `go test ./gogate/`).
  const leader = rest.split(/\s+/)[0]
  const base = leader.split(/[\\/]/).pop() ?? leader
  if (base === "gogate" || base === "gogate.exe") return null
  if (!RECOGNIZED.test(rest)) return null

  // Shell-quote each resolved prefix/flag segment (they may contain spaces, e.g.
  // an absolute binPrefix). The trailing user command is left exactly as written.
  const quoted = [...binPrefix, ...gogateFlags].map(shellQuote)
  return `${envPart}${quoted.join(" ")} ${rest}`
}

// shellQuote single-quotes a segment for POSIX shells, escaping embedded single
// quotes via the '\'' idiom.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
