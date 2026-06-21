# opencode-tripwire

Enforceable per-session **cost/step budgets** for [OpenCode](https://opencode.ai).

Prose "tripwires" in prompts or `CLAUDE.md` don't bind — a runaway session
ignores them. This plugin makes the limits **mechanical**:

1. **Counts** per session: steps, accumulated cost (USD), edits, total
   tool calls, per-file reads, and compactions.
2. **Injects** a live budget line into the orchestrator's turn every step, e.g.
   `[BUDGET] cost $2.10/$12 · steps 23/120 · edits 7/50 · compactions 1/4`.
3. **Acts** at configurable ceilings: a `warn` tier injects a checkpoint nudge;
   the `hard` tier **aborts the session** (or blocks tools) so it physically
   stops instead of ballooning.

Everything is tuned via config **without editing plugin code**.

## Why

Cache-read cost ≈ _context size × steps_. A single unattended session can run
for hours and cost orders of magnitude more than its peers. A reactive ceiling
that stops the next step once a budget is crossed bounds the blast radius.

## Install

Clone, then register the plugin in `opencode.json` (user `~/.config/opencode/`
or project `.opencode/`):

```jsonc
{
  // path form (local repo) — or publish and use the package name
  "plugin": ["/Users/you/git/opencode-tripwire"]
}
```

With inline options (the tuple form — these are the lowest-priority config
layer, overridden by config files and env vars):

```jsonc
{
  "plugin": [
    ["/Users/you/git/opencode-tripwire", { "budgets": { "cost": { "hard": 8 } } }]
  ]
}
```

Restart OpenCode (or start a new run) for plugin changes to take effect.

## Configure

Copy [`opencode-tripwire.example.jsonc`](./opencode-tripwire.example.jsonc) to:

- **user-global:** `~/.config/opencode/opencode-tripwire.jsonc`
- **project:** `<repo>/.opencode/opencode-tripwire.jsonc` (overrides user-global)

All keys are optional; omit any to keep its default.

**Precedence** (low → high):
`defaults < opencode.json PluginOptions < user file < project file < env vars`

### Defaults

| Metric | warn | hard | Notes |
|---|---|---|---|
| `cost` | $5 | $12 | accumulated USD this session |
| `steps` | 40 | 120 | assistant steps (model turns) |
| `edits` | 10 | 50 | edit/write tool calls |
| `tools` | 80 | 250 | total tool calls |
| `compactions` | 2 | 4 | compress/compaction calls |
| `reads` | 2 | 5 | reads of the **same** file |

Set any tier to `0` to disable just that tier.

### `onHard` behaviour

| Value | Effect |
|---|---|
| `abort` | `client.session.abort()` — stops the next step (default) |
| `block` | throws on the tools in `blockTools`, letting the model react |
| `inject` | injects the hard message only (no stop) |
| `off` | counts only, takes no action |

### Env overrides (one-off runs)

| Var | Effect |
|---|---|
| `OPENCODE_TRIPWIRE_DISABLED=1` | disable entirely |
| `OPENCODE_TRIPWIRE_COST_HARD=8` | set cost hard ceiling |
| `OPENCODE_TRIPWIRE_STEPS_HARD=80` | set steps hard ceiling |
| `OPENCODE_TRIPWIRE_EDITS_HARD=30` | set edits hard ceiling |
| `OPENCODE_TRIPWIRE_TOOLS_HARD=150` | set tools hard ceiling |
| `OPENCODE_TRIPWIRE_COMPACTIONS_HARD=3` | set compactions hard ceiling |
| `OPENCODE_TRIPWIRE_READS_HARD=4` | set per-file reads hard ceiling |
| `OPENCODE_TRIPWIRE_ON_HARD=block` | override the hard action |
| `OPENCODE_TRIPWIRE_LOG=1` | enable JSONL session-summary logging |
| `OPENCODE_TRIPWIRE_LOG_PATH=/path/sessions.jsonl` | override the log file path |
| `OPENCODE_TRIPWIRE_LOG_EVERY=5` | write a log line every N steps |

## Session logging

Opt-in. Set `log.enabled` (or `OPENCODE_TRIPWIRE_LOG=1`) to append per-session
usage to a JSONL file (default
`~/.config/opencode/opencode-tripwire.sessions.jsonl`):

```jsonc
"log": {
  "enabled": false,
  "path": "~/.config/opencode/opencode-tripwire.sessions.jsonl",
  "every": 1   // write one line every N steps
}
```

Each line carries cumulative fields:
`{ ts, sessionID, directory, steps, cost, tokensIn, tokensOut, cacheRead, cacheWrite, edits, tools, compactions }`.
`cacheRead`/`cacheWrite` make the dominant context-cost levers measurable.

> **Each line is CUMULATIVE** — for per-session totals take the **LAST** line per
> `sessionID`. e.g. with `jq`:
> ```sh
> jq -s 'group_by(.sessionID) | map(last)' opencode-tripwire.sessions.jsonl
> ```

Logging failures never interrupt tracking (they degrade silently).

## How it works

| Concern | Hook | Mechanism |
|---|---|---|
| count steps / cost | `event` (`session.next.step.ended`) | accumulate `event.properties.cost` in memory |
| count edits / reads / compactions / tools | `tool.execute.before` | classify `input.tool`; reads keyed by file path |
| live counter + warn nudge | `experimental.chat.system.transform` | `output.system.push(...)` |
| hard stop | `event` / `tool.execute.before` | `client.session.abort()` or `throw` |

### Limitation

Cost is reported **after** a step completes, so a ceiling stops the
**next** step — it can't pre-empt an in-flight one. This is adequate for
runaway-session prevention, which is the goal.

## Development

```sh
bun test                 # unit tests
bun run typecheck        # tsc --noEmit
bun run lint             # eslint
```

## License

MIT
