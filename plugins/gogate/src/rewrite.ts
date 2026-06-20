// rewrite.ts — turn a raw `go build` / `go test` / `go vet` / `golangci-lint run`
// command into a gogate invocation by prepending gogate. gogate parses the command
// itself (injecting -json -cover etc.), so there is nothing to split here.

// Shell metacharacters that make wrapping unsafe (pipes, chaining, redirects,
// substitution, backgrounding, newlines): leave such commands alone.
const SHELL_META = /[|&;<>`\n()]|\$\(/

// Commands gogate wraps. `go vet` is run as real `go vet` (not golangci-lint), so any
// vet args are fine to forward.
const RECOGNIZED = /^(go (build|test|vet)|golangci-lint run)\b/

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
  // Skip only when the leading program is already gogate (not when "gogate"
  // appears as a path/arg elsewhere, e.g. `go test ./gogate/`).
  const leader = trimmed.split(/\s+/)[0]
  const base = leader.split(/[\\/]/).pop() ?? leader
  if (base === "gogate" || base === "gogate.exe") return null
  if (!RECOGNIZED.test(trimmed)) return null

  // Shell-quote each resolved prefix/flag segment (they may contain spaces, e.g.
  // an absolute binPrefix). The trailing user command is left exactly as written.
  const quoted = [...binPrefix, ...gogateFlags].map(shellQuote)
  return [...quoted, trimmed].join(" ")
}

// shellQuote single-quotes a segment for POSIX shells, escaping embedded single
// quotes via the '\'' idiom.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
