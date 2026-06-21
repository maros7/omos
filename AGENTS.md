# AGENTS.md

omos is a monorepo of OpenCode plugins. Root Go module: `github.com/maros7/omos`.

## Layout

- `plugins/gogate/` — Go quality-gate plugin: Go binary (`cmd/` + `gogate/`), TS plugin (`src/`) published to npm; at runtime it auto-downloads + caches the prebuilt binary from the GitHub Release on first use (binary itself is not shipped via npm).
- `plugins/review-fixer/` — pure-TS PR-review plugin handling threads from ANY reviewer: does all GitHub REST+GraphQL calls via `fetch` and emits compact text to minimise agent tokens; exposes list/apply/verify actions; ships raw `src/*.ts` to npm as `opencode-review-fixer`; installs its `SKILL.md` to `~/.config/opencode/skills/review-fixer/` via a best-effort `postinstall` hook.
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
- gogate typecheck: `bun run typecheck` in `plugins/gogate`
- gogate lint: `bun run lint` in `plugins/gogate`
- review-fixer tests: `bun test` in `plugins/review-fixer`
- review-fixer typecheck: `bun run typecheck` in `plugins/review-fixer`
- review-fixer lint: `bun run lint` in `plugins/review-fixer`
- tripwire tests: `bun test` in `plugins/tripwire`
- tripwire typecheck: `bun run typecheck` in `plugins/tripwire`
- tripwire lint: `bun run lint` in `plugins/tripwire`

## Conventions

- Conventional Commits (drives release-please for review-fixer & tripwire).
- SHA-pin all GitHub Actions.
- harden-runner egress is `block` — when adding tooling that hits a new host, add it to that workflow's allowed-endpoints.
- No secrets in code; npm publishing uses OIDC Trusted Publishing.

### TypeScript

Enforced by ESLint + typescript-eslint (all three TS plugins).

- No `as` — type guards or fix the type at the source.
- No `any` — `unknown` + narrow, or proper generics.
- \>3 params → single options object.
- `type` = data shapes (DTO/payload/config); `interface` = behavioral contracts (svc/repo/strategy).
- `undefined` by default; `null` only at external edges (HTTP/storage) → normalize to `undefined` on the way in.
- No `!` — narrow or throw. Lazy-init singletons (`svc!.foo` after a guaranteed init step) are the only exception.
- `??` for nullish defaults (not `||`, which fires on `0`/`''`/`false`); `?.` for safe access.
- `foo?: T` over `foo: T | undefined` when the key can legitimately be absent.

## PR flow

- No direct pushes to `main`; branch + PR + squash-merge.
- Required checks must pass: `Go gate`, plus per-plugin `<plugin> Typecheck`, `<plugin> Lint`, `<plugin> TS` jobs (one `ci-plugins.yml` matrix auto-discovers `plugins/*/` — adding a plugin dir requires no CI edits).

## Releases

- gogate: on tag `v*`, GoReleaser builds + uploads the binary to the GitHub Release, and the TS plugin is published to npm via OIDC Trusted Publishing; the opencode plugin auto-downloads + caches the matching binary from that Release on first use.
- review-fixer & tripwire: release-please (`opencode-review-fixer-v*` / `opencode-tripwire-v*`); pure-TS, published to npm via OIDC Trusted Publishing.
