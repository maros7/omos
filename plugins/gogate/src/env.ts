// env.ts — single source of truth for recognizing a leading POSIX `NAME=` env-var
// assignment, shared by both gogate paths: the bash-rewrite path (rewrite.ts, which
// peels assignments from the raw command string) and the custom-tool path (index.ts,
// which peels them from tokenized argv and applies them to the gate subprocess env).

// ENV_ASSIGN matches the NAME= prefix of a POSIX env-var assignment: an identifier
// (letter/underscore, then letters/digits/underscores) followed by `=`. This is the
// canonical definition of what a leading assignment's NAME looks like; both paths
// derive from it so they can never drift apart.
export const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// peelLeadingEnv walks tokens from the front: while a token is a `NAME=VALUE`
// assignment (per ENV_ASSIGN) it splits on the FIRST `=` into key/value (the value may
// be empty, e.g. `FOO=` → ""), accumulating into `env`. It stops at the first token
// that is not an assignment; the remaining tokens are returned as `rest`.
export function peelLeadingEnv(tokens: string[]): { env: Record<string, string>; rest: string[] } {
  const env: Record<string, string> = {}
  let i = 0
  for (; i < tokens.length; i++) {
    const token = tokens[i]
    if (!ENV_ASSIGN.test(token)) break
    const eq = token.indexOf("=")
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    env[key] = value
  }
  return { env, rest: tokens.slice(i) }
}
