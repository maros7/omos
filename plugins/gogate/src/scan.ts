// scan.ts — quote-aware scanner over a RAW shell command string, shared by both gogate
// paths (the bash-rewrite hook in index.ts and the custom-tool `command` arg).
//
// Why raw + quote-aware: tokenize() strips quotes, so a `-run 'A|B'` selector becomes
// the token `A|B` — indistinguishable from a real pipe. Sink detection therefore MUST
// run on the raw string BEFORE tokenize, and MUST track quote state. A naive
// split('|')/indexOf('|') would corrupt `-run 'A|B'`.
//
// The scanner walks left-to-right and acts on the FIRST interesting event:
//   - a BAIL construct (compound/substitution/background/here-doc/newline) → { bail }
//   - a SINK boundary (trailing pipe or output redirect) → { head } cut before it
// If neither occurs, head is the whole (trimmed) command.

// ScanResult is either a bail (leave the raw command untouched) or the head: the
// command up to the first output sink (pipe/redirect), trimmed.
export type ScanResult = { bail: true } | { head: string }

// isDigit reports whether ch is an ASCII digit (used to back up over an fd prefix
// like the `2` in `2>&1`).
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}

// scanCommand classifies a raw command string. See the module comment for the contract.
export function scanCommand(cmd: string): ScanResult {
  const n = cmd.length
  let i = 0

  while (i < n) {
    const ch = cmd[i]

    // Backslash outside quotes escapes the next char (so `\|` is not a pipe).
    if (ch === "\\") {
      i += 2
      continue
    }

    // Single quotes: everything literal until the closing quote.
    if (ch === "'") {
      i++
      while (i < n && cmd[i] !== "'") i++
      i++ // skip the closing quote (or land past the end)
      continue
    }

    // Double quotes: `|;&<>()` are literal, but `$(` and backtick are still
    // command substitution → bail.
    if (ch === '"') {
      i++
      while (i < n) {
        const c = cmd[i]
        if (c === "\\") {
          i += 2
          continue
        }
        if (c === '"') {
          i++
          break
        }
        if (c === "`") return { bail: true }
        if (c === "$" && cmd[i + 1] === "(") return { bail: true }
        i++
      }
      continue
    }

    // --- outside quotes: classify ---

    // Bail constructs (anywhere).
    if (ch === "\n" || ch === "`" || ch === "(" || ch === ")" || ch === ";") {
      return { bail: true }
    }
    if (ch === "$" && cmd[i + 1] === "(") return { bail: true }
    if (ch === "<") return { bail: true } // `<`, `<<`, `<<<` (here-doc / here-string)

    if (ch === "&") {
      if (cmd[i + 1] === "&") return { bail: true } // `&&`
      if (cmd[i + 1] === ">") return { head: cmd.slice(0, i).trim() } // `&>` / `&>>`
      return { bail: true } // lone background `&`
    }

    if (ch === "|") {
      if (cmd[i + 1] === "|") return { bail: true } // `||`
      return { head: cmd.slice(0, i).trim() } // `|` or `|&`
    }

    if (ch === ">") {
      // Back up over an immediately-attached fd run (`[0-9]*`, optional `&`) so the
      // head doesn't keep a stray `2`/`&` (e.g. `go test 2>&1` → head `go test`).
      let start = i
      while (start > 0 && isDigit(cmd[start - 1])) start--
      if (start > 0 && cmd[start - 1] === "&") start--
      return { head: cmd.slice(0, start).trim() } // `>`, `>>`, `>&`, `2>`, `1>&2`, …
    }

    i++
  }

  return { head: cmd.trim() }
}
