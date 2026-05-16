#!/usr/bin/env bash
# verify.sh — single-command verification gate.
#
# Runs tests + server build + dry-pack inspection in one shot.
# Equivalent to running `npm run verify` plus a pack-size sanity check.
#
# Exit codes:
#   0  — everything passed
#   1  — a step failed (see step name in output)
#
# Used by:
#   - operators ahead of `npm publish`
#   - SHIP_GATE.md "verify script exists" claim
#
# Does NOT run linting (no lint config — intentional, see SHIP_GATE.md).
# Does NOT exercise the dogfood scenario (lives in .github/workflows/dogfood.yml).

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[verify] 1/3 npm test"
npm test

echo "[verify] 2/3 npm run build:server"
npm run build:server

echo "[verify] 3/3 npm pack --dry-run (size + file count sanity)"
npm pack --dry-run 2>&1 | tail -20

echo "[verify] PASS"
