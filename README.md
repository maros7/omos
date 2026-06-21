# omos

A monorepo for [OpenCode](https://opencode.ai) extensions — plugins, and room
for other OpenCode tooling over time.

## Plugins

| Plugin | Path | What it does |
| --- | --- | --- |
| **gogate** | [`plugins/gogate`](plugins/gogate) | Runs a Go quality gate (build + test + lint) in one pass and returns a structured report. Ships a Go binary plus an OpenCode plugin that exposes a `gogate` tool and rewrites raw `go`/`golangci-lint` commands through the gate. The plugin auto-downloads its prebuilt binary from the GitHub Release on first use and caches it (no npm). |
| **tripwire** | [`plugins/tripwire`](plugins/tripwire) | Enforceable per-session cost/step budgets — counts steps/cost/edits/reads/compactions, injects a live budget line into the turn, and warns or hard-aborts at configurable ceilings. |
| **review-fixer** | [`plugins/review-fixer`](plugins/review-fixer) | Pure-TypeScript plugin that lists, replies to, and resolves PR review threads from any reviewer — does all GitHub REST+GraphQL work via `fetch` and emits compact text, so the agent spends minimal tokens and never ingests raw `gh` JSON. Exposes an OpenCode tool with `list`/`apply`/`verify` actions; ships raw `src/*.ts` to npm as `opencode-review-fixer` and installs its `SKILL.md` via a best-effort postinstall hook. |

Each plugin is self-contained under `plugins/<name>/` with its own README,
package metadata, and release track.

## Enabling a plugin

Reference a plugin from your `opencode.json` by path (point at the plugin
directory; OpenCode resolves its package entry point):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/path/to/omos/plugins/gogate",
    ["/path/to/omos/plugins/tripwire", { "budgets": { "cost": { "hard": 8 } } }]
  ]
}
```

See each plugin's README for installation, configuration, and the published
package / binary distribution details.

## Development

This is a [Bun](https://bun.sh) workspace (`plugins/*`). The Go module is rooted
here (`module github.com/maros7/omos`) with the Go sources under
`plugins/gogate/`.

```sh
bun install                 # install all workspace deps

# gogate (Go + TS)
go build ./... && go test ./... && golangci-lint run ./...
bun test --cwd plugins/gogate

# tripwire (TS)
bun run --cwd plugins/tripwire typecheck

# review-fixer (TS)
bun test --cwd plugins/review-fixer
bun run --cwd plugins/review-fixer typecheck
bun run --cwd plugins/review-fixer lint
```

The repo root carries an `opencode.json` that loads the plugins so the repo
dogfoods them while you develop.

## License

[MIT](LICENSE) © Marcus Rosén
