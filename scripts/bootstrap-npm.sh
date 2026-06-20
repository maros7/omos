#!/usr/bin/env bash
#
# bootstrap-npm.sh — ONE-TIME npm package bootstrap (user-run, not CI).
#
# WHY THIS EXISTS:
#   npm Trusted Publishers (OIDC) have no pre-registration: a package must
#   already EXIST on the registry before you can attach a trusted publisher to
#   it. All 8 of our npm packages are currently unpublished, so OIDC publishing
#   from CI can't be configured yet. This script does the unavoidable first
#   publish of each package (at 0.1.0 / current package.json version) using a
#   TEMPORARY npm token, so that afterwards you can wire up Trusted Publishers
#   and CI can publish tokenlessly via OIDC forever after.
#
#   Run this ONCE. After it succeeds and you've configured Trusted Publishers
#   (+ deleted the temporary token), you never need it again.
#
# THE 8 PACKAGES:
#   gogate launcher + six @gogate/<os>-<arch> platform packages  (from publish.mjs)
#   opencode-tripwire                                            (plugins/tripwire)
#
# USAGE:
#   export NODE_AUTH_TOKEN=<temporary npm automation token>
#   ./scripts/bootstrap-npm.sh
#
# Requirements: gh, node, npm; gh authenticated to GitHub; run from repo root.

set -euo pipefail

echo "==> omos npm bootstrap (one-time)"

# ---------------------------------------------------------------------------
# 1. Preconditions
# ---------------------------------------------------------------------------

# Must be run from the repo root — we sanity-check for files we know live there.
if [[ ! -f ".goreleaser.yaml" || ! -f "plugins/gogate/npm/scripts/publish.mjs" ]]; then
  echo "ERROR: run this from the omos repo root (couldn't find .goreleaser.yaml" >&2
  echo "       and plugins/gogate/npm/scripts/publish.mjs)." >&2
  exit 1
fi

# Required tools.
for tool in gh node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not found on PATH." >&2
    exit 1
  fi
done

# npm auth: either NODE_AUTH_TOKEN is exported (the temporary token — this is
# the var actions/setup-node wires and the var publish.mjs's `npm publish`
# expects) OR npm is already logged in (`npm whoami` succeeds).
if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "==> Using NODE_AUTH_TOKEN from environment (temporary token)."
elif npm whoami >/dev/null 2>&1; then
  echo "==> npm already authenticated as: $(npm whoami)"
else
  echo "ERROR: not authenticated to npm." >&2
  echo "       Set a TEMPORARY npm token and re-run, e.g.:" >&2
  echo "         export NODE_AUTH_TOKEN=<npm automation token>" >&2
  echo "       (or run 'npm login' first)." >&2
  exit 1
fi

# gh must be authenticated to download the release assets.
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

echo
echo "NOTE: This script is NOT idempotent. Publishing a version that already"
echo "      exists fails with E409 (Conflict). On a re-run, packages that were"
echo "      already published will error — that is expected and safe; just"
echo "      re-run for whatever remains, or finish the ones that succeeded."
echo

# ---------------------------------------------------------------------------
# 2. gogate packages (launcher + 6 platform packages) at 0.1.0
# ---------------------------------------------------------------------------
#
# publish.mjs consumes GoReleaser archives out of DIST_DIR and derives the
# version from $GITHUB_REF_NAME (leading "v" stripped). We point it at the
# already-published v0.1.0 GitHub release assets:
#   - archive names:  gogate_<os>_<arch>.tar.gz  (darwin, linux)
#                     gogate_<os>_<arch>.zip     (windows)
#     (from .goreleaser.yaml name_template "gogate_{{ .Os }}_{{ .Arch }}")
#   - platforms: darwin/linux/windows x amd64/arm64  -> 6 platform packages
#   - version:   GITHUB_REF_NAME=v0.1.0  ->  0.1.0
#   - DIST_DIR:  where publish.mjs looks for the archives.

echo "==> Downloading v0.1.0 release assets into ./dist ..."
gh release download v0.1.0 --repo maros7/omos --dir dist --clobber

echo "==> Publishing gogate launcher + 6 platform packages at 0.1.0 ..."
GITHUB_REF_NAME=v0.1.0 DIST_DIR="$PWD/dist" node plugins/gogate/npm/scripts/publish.mjs

# ---------------------------------------------------------------------------
# 3. opencode-tripwire
# ---------------------------------------------------------------------------
#
# This publishes whatever version is in plugins/tripwire/package.json (currently
# 0.0.0) PURELY to create the package on the registry so a Trusted Publisher can
# be attached. The real 0.1.0 publish comes later from CI (release-please.yml)
# once the release-please PR is merged. tripwire ships raw src/*.ts — no build
# step — so a plain `npm publish` from its dir is all that's needed.
echo "==> Publishing opencode-tripwire (to create the package) ..."
(
  cd plugins/tripwire
  npm publish --access public
)

# ---------------------------------------------------------------------------
# 4. Follow-up checklist
# ---------------------------------------------------------------------------
cat <<'EOF'

==============================================================================
DONE publishing. NEXT STEPS — configure Trusted Publishers, then delete token.
==============================================================================

For EACH package below, open its access page and add a Trusted Publisher:
  npmjs.com/package/<name>/access  ->  Trusted Publishers  ->  Add

Use these settings:
  Owner:      maros7
  Repository: omos

The 8 packages and their workflow filenames:

  gogate                    -> release.yml
  @gogate/darwin-arm64      -> release.yml
  @gogate/darwin-amd64      -> release.yml
  @gogate/linux-arm64       -> release.yml
  @gogate/linux-amd64       -> release.yml
  @gogate/windows-amd64     -> release.yml
  @gogate/windows-arm64     -> release.yml
  opencode-tripwire         -> release-please.yml

FINALLY: delete the TEMPORARY npm token you used for this bootstrap
  (npmjs.com -> Access Tokens). After this, CI publishes tokenlessly via OIDC.
==============================================================================
EOF
