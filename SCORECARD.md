# Scorecard

**Repo:** vocal-synth-engine
**Date:** 2026-05-16 (refreshed post-extraction from `prototypes` monorepo)
**Type tags:** `[npm]`

## Pre-Remediation Assessment (2026-02-27)

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 2/10 | No SECURITY.md, no threat model in README |
| B. Error Handling | 7/10 | TypeScript error handling, comprehensive test suite |
| C. Operator Docs | 6/10 | README current, CHANGELOG template only |
| D. Shipping Hygiene | 7/10 | CI present, tests, npm package |
| E. Identity (soft) | 10/10 | Logo, translations, landing page, metadata |
| **Overall** | **32/50** | |

## Original Remediation (2026-02-27 → 2026-03-25)

| Category | Before | After |
|----------|--------|-------|
| A. Security | 2/10 | 10/10 |
| B. Error Handling | 7/10 | 10/10 |
| C. Operator Docs | 6/10 | 10/10 |
| D. Shipping Hygiene | 7/10 | 10/10 |
| E. Identity (soft) | 10/10 | 10/10 |
| **Overall** | 32/50 | **50/50** |

## Post-Extraction Re-Audit (2026-05-16)

Repo was restored from the `prototypes` monorepo snapshot in May 2026 and gained metadata drift in transit (wrong license, no `files[]`, no `engines`, no author, no keywords, no verify script, stale passport URL, 4 npm audit vulns, oversize tarball). Phase 3 swarm Wave 3a (`8ea0460`) restored most package hygiene; this scorecard reflects Wave 3b state.

| Category | Pre-Wave-3a | Post-Wave-3b | Notes |
|----------|-------------|--------------|-------|
| A. Security | 6/10 | 9/10 | SECURITY.md retained; audit threshold tuned (`--audit-level=high`); weekly scheduled audit added; 4 vulns cleared via non-breaking `npm audit fix`. Dockerfile minor-pinned (`node:20.18-slim`) + docker dependabot added; immutable-digest pin remains an Open Item. |
| B. Error Handling | 9/10 | 9/10 | Unchanged. |
| C. Operator Docs | 7/10 | 9/10 | SHIP_GATE.md + SCORECARD.md realigned with reality; CHANGELOG `[1.0.2]` still a stub (low-severity finding C-018, deferred); README + translations intact. |
| D. Shipping Hygiene | 4/10 | 9/10 | `files[]` declared (wave 3a, 5.8 MB → 264.8 kB); `engines.node` set; `license`/`author`/`keywords` corrected; `verify` script added; `prepublishOnly` ensures fresh `dist/`; Dependabot extended to Docker + cockpit + site. Git tag `v1.0.3` still absent (one D-row remains `[ ]`). |
| E. Identity (soft) | 10/10 | 10/10 | Unchanged. |
| **Overall** | **36/50** | **46/50** | Pre-publish gap = `v1.0.3` tag + Dockerfile SHA-pin (Open Items below). |

## Open Items (not yet remediated)

- **Dockerfile immutable-digest pin (C-014, partial)** — Wave 3b applied minor-pin (`node:20.18-slim`) + docker Dependabot ecosystem. For strict reproducibility, upgrade to `@sha256:<digest>` once digest is verified against Docker Hub.
- **Tag `v1.0.3`** — no git tag exists in the local clone post-extraction. Create against the release commit.
- **CHANGELOG `[1.0.2]` stub (C-018, LOW)** — backfill or fold into `[1.0.3]`.
- **README translation drift (C-019, LOW)** — Hindi README outlier on length; re-run polyglot translation if/when source README changes.
- **apps/cockpit/package-lock.json not COPYed in Dockerfile (C-020, LOW)** — silently allows latest-compatible resolution for cockpit deps. Fix is one additional COPY line.

## Methodology

This scorecard intentionally tracks *current* truth, not aspirational checkmarks. Categories are scored against the SHIP_GATE.md rubric. A category drops a point when a check claimed `[x]` is empirically false; it gains back when the underlying fix lands.
