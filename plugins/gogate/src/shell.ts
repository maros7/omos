// shell.ts — split a command line into top-level segments separated by shell control
// operators (&&, ||, ;, |, |&), respecting single/double quotes and backslash escapes.
// Returns null for any construct we will not rewrite (command substitution, subshells,
// process substitution, backgrounding, newlines, unterminated quotes) so the caller can
// pass the command through unchanged. Deliberately NOT a real shell parser.

export type ShellSplit = { segments: string[]; operators: string[] } // operators.length === segments.length - 1

export function splitShell(input: string): ShellSplit | null {
  const segments: string[] = []
  const operators: string[] = []
  let buf = ""
  let quote: "'" | '"' | null = null

  const lastNonSpace = (): string => {
    for (let k = buf.length - 1; k >= 0; k -= 1) {
      if (!/\s/.test(buf[k])) return buf[k]
    }
    return ""
  }

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    const next = i + 1 < input.length ? input[i + 1] : ""

    if (quote === "'") {
      buf += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === "\\" && next) {
        buf += ch + next
        i += 1
        continue
      }
      if (ch === "$" && next === "(") return null
      if (ch === "`") return null
      buf += ch
      if (ch === '"') quote = null
      continue
    }

    if (ch === "`") return null
    if (ch === "$" && next === "(") return null
    if (ch === "(" || ch === ")") return null
    if (ch === "\n") return null
    if (ch === "\\" && next) {
      buf += ch + next
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }

    if (ch === "&") {
      if (next === "&") {
        segments.push(buf)
        operators.push("&&")
        buf = ""
        i += 1
        continue
      }
      if (next === ">") {
        buf += ch
        continue
      }
      if (lastNonSpace() === ">") {
        buf += ch
        continue
      }
      return null
    }
    if (ch === "|") {
      if (next === "|") {
        segments.push(buf)
        operators.push("||")
        buf = ""
        i += 1
        continue
      }
      if (next === "&") {
        segments.push(buf)
        operators.push("|&")
        buf = ""
        i += 1
        continue
      }
      if (lastNonSpace() === ">") {
        buf += ch
        continue
      }
      segments.push(buf)
      operators.push("|")
      buf = ""
      continue
    }
    if (ch === ";") {
      if (next === ";") return null
      segments.push(buf)
      operators.push(";")
      buf = ""
      continue
    }

    buf += ch
  }

  if (quote !== null) return null
  segments.push(buf)
  return { segments, operators }
}
