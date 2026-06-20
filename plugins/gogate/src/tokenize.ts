// tokenize splits a command string into argv tokens, respecting single and double
// quotes (whitespace inside quotes does not split). Surrounding quotes are stripped
// from each token. Minimal and dependency-free — enough for `go test -run "Test A"`.
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let cur = ""
  let started = false
  let quote: '"' | "'" | null = null

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur)
        cur = ""
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started) tokens.push(cur)
  return tokens
}
