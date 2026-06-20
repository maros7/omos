# AGENTS.md

omos is a monorepo of OpenCode plugins. Root Go module: `github.com/maros7/omos`.

## Layout

- `plugins/gogate/` — Go quality-gate plugin: Go binary (`cmd/` + `gogate/`), TS plugin (`src/`) published to npm; at runtime it auto-downloads + caches the prebuilt binary from the GitHub Release on first use (binary itself is not shipped via npm).
- `plugins/review-fixer/` — Go-backed PR-review plugin handling threads from ANY reviewer: Go binary (`cmd/` + `reviewfixer/`) does all GitHub REST+GraphQL calls and emits compact text to minimise agent tokens; exposes list/apply/verify actions; TS plugin (`src/`) published to npm; at runtime it auto-downloads + caches the prebuilt binary from the GitHub Release on first use (binary itself is not shipped via npm).
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
- review-fixer tests: `bun test` in `plugins/review-fixer`
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

- gogate & review-fixer: on tag `v*`, GoReleaser builds + uploads binaries to the GitHub Release, and each TS plugin is published to npm via OIDC Trusted Publishing; the opencode plugin auto-downloads + caches the matching binary from that Release on first use.
- tripwire: release-please (`opencode-tripwire-v*`).
