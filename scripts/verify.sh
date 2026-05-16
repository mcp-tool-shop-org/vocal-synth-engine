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

echo "[verify] 1/4 npm test"
npm test

echo "[verify] 2/4 npm run bench (FTC-004 — informational; gate runs in CI)"
# Local verify keeps this informational: it confirms the bench targets
# still execute. The 2x-regression gate runs in CI only (bench-gate job)
# so a local-noise bench result doesn't block `bash scripts/verify.sh`.
npm run bench || echo "[verify] bench step exited non-zero — ignored locally; CI gates"

echo "[verify] 3/4 npm run build:server"
npm run build:server

echo "[verify] 4/4 npm pack --dry-run (size + file count sanity)"
npm pack --dry-run 2>&1 | tail -20

echo "[verify] PASS"
