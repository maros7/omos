#!/usr/bin/env bash
#
# bootstrap-npm.sh — ONE-TIME npm package bootstrap (user-run, not CI).
#
# WHY THIS EXISTS:
#   npm Trusted Publishers (OIDC) have no pre-registration: a package must
#   already EXIST on the registry before you can attach a trusted publisher to
#   it. This script does the unavoidable first publish (at the current
#   package.json version) using a TEMPORARY npm token, so that afterwards you
#   can wire up Trusted Publishers and CI can publish tokenlessly via OIDC
#   forever after.
#
#   Run this ONCE. After it succeeds and you've configured Trusted Publishers
#   (+ deleted the temporary token), you never need it again.
#
# THE PACKAGES:
#   opencode-tripwire       (plugins/tripwire)      — release-please
#   opencode-review-fixer   (plugins/review-fixer)  — release-please
#
#   NOTE: gogate no longer ships an npm package — its OpenCode plugin
#   auto-downloads + caches the prebuilt binary from the GitHub Release on first
#   use, so there is nothing to bootstrap for gogate.
#
# USAGE:
#   export NODE_AUTH_TOKEN=<temporary npm automation token>
#   ./scripts/bootstrap-npm.sh
#
# Requirements: node, npm; run from repo root.

set -euo pipefail

echo "==> omos npm bootstrap (one-time)"

# ---------------------------------------------------------------------------
# 1. Preconditions
# ---------------------------------------------------------------------------

# Must be run from the repo root — we sanity-check for a file we know lives there.
if [[ ! -f "plugins/tripwire/package.json" ]]; then
  echo "ERROR: run this from the omos repo root (couldn't find" >&2
  echo "       plugins/tripwire/package.json)." >&2
  exit 1
fi

# Required tools.
for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not found on PATH." >&2
    exit 1
  fi
done

# npm auth: either NODE_AUTH_TOKEN is exported (the temporary token — this is
# the var actions/setup-node wires) OR npm is already logged in (`npm whoami`
# succeeds).
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

echo
echo "NOTE: This script is NOT idempotent. Publishing a version that already"
echo "      exists fails with E409 (Conflict). On a re-run, packages that were"
echo "      already published will error — that is expected and safe; just"
echo "      re-run for whatever remains, or finish the ones that succeeded."
echo

# ---------------------------------------------------------------------------
# 2. opencode-tripwire
# ---------------------------------------------------------------------------
#
# This publishes whatever version is in plugins/tripwire/package.json (currently
# 0.0.0) PURELY to create the package on the registry so a Trusted Publisher can
# be attached. The real 0.1.0 publish comes later from CI (release-please.yml)
# once the release-please PR is merged. tripwire ships raw src/*.ts — no build
# step — so a plain `npm publish` from its dir is all that's needed.
echo "==> Publishing opencode-tripwire (to create the package) ..."
# Idempotent: if this exact version is already published, npm errors with
# E409 / EPUBLISHCONFLICT ("cannot publish over previously published version").
# Tolerate ONLY that case (skip + continue); any other npm failure stays fatal.
tripwire_out=$(cd plugins/tripwire && npm publish --access public 2>&1) && tripwire_rc=0 || tripwire_rc=$?
printf '%s\n' "$tripwire_out"
if [[ $tripwire_rc -ne 0 ]]; then
  if grep -qiE 'E409|EPUBLISHCONFLICT|cannot publish over|previously published version' <<<"$tripwire_out"; then
    echo "⏭  opencode-tripwire already published, skipping"
  else
    echo "ERROR: opencode-tripwire publish failed (exit $tripwire_rc)." >&2
    exit "$tripwire_rc"
  fi
fi

# ---------------------------------------------------------------------------
# 3. opencode-review-fixer
# ---------------------------------------------------------------------------
#
# Same idea as tripwire: publish whatever version is in plugins/review-fixer/
# package.json (currently 0.1.0) PURELY to create the package on the registry so
# a Trusted Publisher can be attached. The real publishes come later from CI
# (release-please.yml) once the release-please PR is merged. review-fixer is
# pure-TS and ships raw src/*.ts — no build step — so a plain `npm publish` from
# its dir is all that's needed.
echo "==> Publishing opencode-review-fixer (to create the package) ..."
# Idempotent: if this exact version is already published, npm errors with
# E409 / EPUBLISHCONFLICT ("cannot publish over previously published version").
# Tolerate ONLY that case (skip + continue); any other npm failure stays fatal.
rf_out=$(cd plugins/review-fixer && npm publish --access public 2>&1) && rf_rc=0 || rf_rc=$?
printf '%s\n' "$rf_out"
if [[ $rf_rc -ne 0 ]]; then
  if grep -qiE 'E409|EPUBLISHCONFLICT|cannot publish over|previously published version' <<<"$rf_out"; then
    echo "⏭  opencode-review-fixer already published, skipping"
  else
    echo "ERROR: opencode-review-fixer publish failed (exit $rf_rc)." >&2
    exit "$rf_rc"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Follow-up checklist
# ---------------------------------------------------------------------------
cat <<'EOF'

==============================================================================
DONE publishing. NEXT STEPS — configure the Trusted Publisher, then delete token.
==============================================================================

For the package below, open its access page and add a Trusted Publisher:
  npmjs.com/package/<name>/access  ->  Trusted Publishers  ->  Add

Use these settings:
  Owner:      maros7
  Repository: omos

The packages and their workflow filename:

  opencode-tripwire         -> release-please.yml
  opencode-review-fixer     -> release-please.yml

FINALLY: delete the TEMPORARY npm token you used for this bootstrap
  (npmjs.com -> Access Tokens). After this, CI publishes tokenlessly via OIDC.
==============================================================================
EOF
