# AGENTS.md

omos is a monorepo of OpenCode plugins. Root Go module: `github.com/maros7/omos`.

## Layout

- `plugins/gogate/` — Go quality-gate plugin: Go binary (`cmd/` + `gogate/`), TS plugin (`src/`) auto-downloads + caches the prebuilt binary from the GitHub Release on first use (no npm).
- `plugins/tripwire/` — TS cost/budget guardrail plugin; ships raw `src/*.ts`.
- Bun workspace at root (`workspaces: plugins/*`).

## Commands

Go (from root):

- `go build ./...`
- `go test ./...`
- `golangci-lint run ./...`

TS:

- `bun install` (root)
- gogate tests: `bun test` in `plugins/gogate`
- tripwire typecheck: `bun run typecheck` in `plugins/tripwire`

## Conventions

- Conventional Commits (drives release-please for tripwire).
- SHA-pin all GitHub Actions.
- harden-runner egress is `block` — when adding tooling that hits a new host, add it to that workflow's allowed-endpoints.
- No secrets in code; npm publishing uses OIDC Trusted Publishing.

## PR flow

- No direct pushes to `main`; branch + PR + squash-merge.
- 3 required checks must pass: Go gate, TS plugin, Typecheck.

## Releases

- gogate: GoReleaser builds + uploads binaries to the GitHub Release on tag `v*`; the opencode plugin auto-downloads + caches the matching binary on first use (no npm).
- tripwire: release-please (`opencode-tripwire-v*`).
