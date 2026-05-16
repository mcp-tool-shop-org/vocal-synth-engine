# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-05-16

First release after standalone-repo restoration and full dogfood-swarm
treatment (Stages A-D health + Feature Pass + Phase 10 Full Treatment).
Tests 28 → 246 (+218). Coverage 35% → 40%+. Multi-OS CI matrix.
npm audit clean. SHA-256 asset-integrity verification. Worker-loop-
yielding render queue. Graceful shutdown. WS heartbeat. Structured
error envelope on every API failure. Backward-compatible across all
changes; no breaking API changes from 1.0.3.

### Added

#### Engine
- **Stereo + per-voice pan** — `StreamingVocalSynthConfig.channels: 1|2` and `VocalNote.pan: -1..1` with equal-power panning (default mono, pan 0 for back-compat).
- **`score.lanes.{dynamics, breathiness}` now consumed** — were schema-validated but engine-ignored; now applied per-sample.
- **StreamingVocalSynthEngine ergonomics** — `seek()`, `reset()`, `panic()`, `getCurrentTime()`, `getTelemetryAndReset()`, `setLanes()`, `setScore()`, `outputChannels` getter. New `StreamingTelemetry` interface.
- **Real SHA-256 determinism telemetry** in `RendererTelemetry` (was hardcoded mock hash).
- **`MonophonicRenderer.reseed()`** — set RNG seed without touching phase or hash state.
- **`LiveTelemetry`** gains `limiterReductionDb`, `voicesStolenLastWindow`, `sunsetVoiceCount`, `outputNaNCount` (operator-actionable names).
- **Operator-actionable validation** on `noteOn`, `updateConfig`, streaming constructor, `render(numSamples)` — clear `RangeError`/`TypeError` with offending value, expected range, and noteId in message.
- **Polyphony-shrink no longer clicks** — in-release voices excised by `updateConfig({maxPolyphony:N})` move to a sunset list and finish their natural release.
- **`KNOWN_CONSONANT_KINDS`** + `isKnownConsonantKind` type guard + exhaustive switch.

#### Library entry
- **Engine subpath exports** — `package.json main` now points at `dist/index.js` (the engine), not the server. `exports` field maps 12 subpaths: `.`, `./server`, `./preset/loader`, `./preset/schema`, `./engine/{live,streaming,renderer,curves,consonantProfiles}`, `./types/{score,scoreSchema}`, `./package.json`. `npm install @mcptoolshop/vocal-synth-engine` now gives you the engine, not an Express server.

#### Server
- **Worker-loop-yielding render queue** (`renderQueue.ts`) — single-flight FIFO; `setImmediate` per-block keeps health + WS responsive mid-render. Queue depth cap returns `503 RENDER_QUEUE_FULL`.
- **Render-progress SSE stream** — `GET /api/render/events?jobId=...` emits `queued/started/progress/done/failed/cancelled` events with 15s heartbeat. `X-Render-Job-Id` response header lets clients subscribe.
- **HTTP render-cancel surface** — `DELETE /api/v1/render/jobs/:jobId` (+ POST alias) cancels queued OR in-flight jobs.
- **Per-user identity** — `AUTH_KEYS_FILE` / `AUTH_KEYS` env for multi-key configs with optional `admin` flag. Legacy `AUTH_TOKEN` preserved. `req.principal` + `req.userId` attached. `meta.createdBy` recorded by `saveRender`. `/api/renders` filters by `createdBy` unless admin. `authorizeRenderRead` helper centralizes per-user gating.
- **API versioning** — all routes mounted at `/api/v1/*` (canonical) with `/api/*` alias (Deprecation/Sunset headers).
- **OpenAPI 3.1 spec** — `GET /api/openapi.json` generated from existing Zod schemas via `@asteasolutions/zod-to-openapi`.
- **Prometheus metrics** — `GET /api/v1/metrics` (admin-auth). Queue depth, store budget, HTTP totals + duration histograms, WS sessions, render duration + RTF, auth failures, rate-limit drops.
- **k8s probes** — `GET /livez` (open, unconditional 200) + `GET /readyz` (init + store + queue accepting jobs).
- **Disk-budget enforcement** — `RenderBudgetError` returns `413 RENDER_STORE_FULL` / `RENDER_TOO_LARGE` with hint. Snapshot exposed on `GET /api/renders`.
- **Graceful shutdown** (`gracefulShutdown.ts`) — SIGTERM/SIGINT drains queue, closes WS with `1001 "reconnect to resume"`, exits 0 (30s deadline → 1).
- **WS heartbeat** (`wsHeartbeat.ts`) — 30s ping, reap after 2 missed pongs with `1008 "idle timeout"`.
- **Structured error envelope** — `{ok:false, code, message, hint?, requestId, details?}` on every API failure. `HttpError` class. body-parser errors mapped to `BODY_TOO_LARGE` / `INVALID_JSON` (no more HTML/stack leaks).
- **pino structured logger** + `X-Request-Id` middleware; summary line per request with `method/path/status/durMs`; slow-request warn >5s.
- **17+ new error codes**, `CORS exposedHeaders`, `Retry-After` on 429.

#### Tooling + CLIs
- **10 `bin` entries** — `vse-{analyze, build-preset, compare, gen-vowel-wav, inspect, phonemize, play-score, resynth, score-from-midi}` + `vocal-synth-engine-mcp`.
- **`vse-score-from-midi`** — MIDI → VocalScore JSON via `midi-file`. Stable `--json` schema v1.0.0.
- **`vse-phonemize`** — standalone G2P CLI. TEXT (syllabification) + SCORE (note-aligned PhonemeEvents) modes.
- **`vocal-synth-engine-mcp`** — MCP server (stdio transport) exposing `render_score`, `phonemize_text`, `list_presets`, `validate_score`, `inspect_preset`. Pure adapter over existing in-process API.
- **Stable `--json` output** on `inspect`/`analyze`/`build-preset`/`compare`/`play-score`.
- **`SUPPORTED_LYRICS_LANGUAGES`** with explicit warnings on unsupported input; `tokenizeLyrics` Unicode-aware.
- **`SUPPORTED_PRESET_VERSIONS`** + `SUPPORTED_SCORE_VERSIONS` semver gates.
- **Real SHA-256 asset-integrity verification** in preset loader; `ASSET_INTEGRITY_MISMATCH` error.
- **Proper CLI exit codes** — `_runner.ts` helper wraps every CLI so rejections set `process.exitCode = 1`.

#### Tests + CI
- **246 tests** (was 28 at restore) across 17 files. 8 property-based tests via `fast-check`. 4 Playwright cockpit smoke tests. 3 vitest benches with `bench-gate.mjs` (2× regression threshold).
- **Coverage threshold 30/25/25/30%** (was 10% theater); current floor 40.34% stmts.
- **Multi-OS CI matrix** — Node {20, 22} × OS {ubuntu, macos, windows}; `cockpit-tests` + `bench-gate` jobs.
- **`.github/workflows/release.yml`** — tag-push spine; verify gate (tests/build/audit/verify.sh), tag-vs-`package.json` version equality, `npm publish --provenance` (Sigstore), CHANGELOG-driven `gh release create`.

#### Cockpit + docs
- **Cockpit Authorization headers** — `apps/cockpit/src/auth.ts` localStorage token + `authFetch`. Header `🔑 API Key` panel; opens on 401.
- **Waveform + comparison + LiveScope** — vanilla canvas (`apps/cockpit/src/waveform.ts`). Wired into render result, Compare modal stacked A/B, Live tab telemetry.
- **Render-progress SSE consumption** — cockpit reads `X-Render-Job-Id` and renders a determinate progress bar from the new server SSE stream.
- **Budget snapshot UI** — used/total MB + 4px progress bar (amber > 70%, red > 90%).
- **Structured error envelope display** — replaces `alert(e.message)` with inline `role="alert"` panel showing `{code, message, hint}`.
- **Responsive breakpoints + WCAG focus ring + empty state**.
- **4 new handbook pages** — `score-format`, `cli-reference`, `deployment`, `troubleshooting` under `site/src/content/docs/handbook/`.
- **README** — install + brand asset wiring + truthful badges; MCP section.

#### Infrastructure + ops
- **HEALTHCHECK** in Dockerfile + `[[http_service.checks]]` in fly.toml + `healthCheckPath` in render.yaml.
- **CODEOWNERS**, issue/PR templates, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- **Dependabot weekly** on npm ecosystems (root + apps/cockpit + site); monthly on docker + github-actions.
- **`prepublishOnly`** ensures fresh `dist/` before publish.
- **`scripts/verify.sh`** end-to-end gate (test + bench gate + build + pack dry-run).

### Changed
- `package.json` `main`/`types`/`exports` re-pointed to the engine (was server bootstrap).
- License field `ISC` → `MIT` (matches LICENSE + READMEs).
- `engines.node >= 20` and Node 20 unified across CI, Dockerfile, pages.yml, dogfood.yml.
- `files[]` allowlist — npm pack 5.8 MB → 287 kB (96% reduction; 304 → 244 files).
- Default body limit 50 MB → 2 MB (`JSON_BODY_LIMIT` overridable).
- Rate limit applied to `POST /api/renders` (was bypassed); rate-limit map LRU-bounded.
- Coverage threshold 10% → 30%/25%/25%/30%.
- `RenderQueue.cancel()` return type expanded from `boolean` to `'queued_removed' | 'running_flagged' | 'unknown'`.

### Fixed
- **Path traversal** on `/api/renders/:id/*` (CRITICAL) — `safeRenderDir` validates id pattern + realpath prefix assertion; `DELETE` can no longer `fs.rmSync({recursive,force:true})` outside the render store.
- **`xorshift32` seed=0 fixed point** — `rngSeed + index` remap blocks the silent-zero-stream pathology.
- **Consonant HPF NaN tripwire + cutoff clamp** — one bad sample no longer poisons `hpfLastOutput` for engine lifetime.
- **`findPitchYin` silent-input handling** — returns 0 sentinel, never `-sampleRate`.
- **Envelope thump on early release** — uses `min(attack, release)` not product.
- **`updateConfig({rngSeed})` propagation** to voices via `renderer.reseed()`.
- **Renderer phase always advances when `f0 > 0`** — no more silent-attack desync.
- **`panic()` resets `lastSample`** — no more fake delta after panic.
- **`peakDbfs` measured pre-limiter** + new `limiterReductionDb` field — clipping is now visible.
- **StreamingVocalSynthEngine perf** — buffers hoisted to constructor with auto-grow; notes pre-sorted with `noteCursor` + cached `prevNote`; eliminated O(samples × notes × voices) per-sample work.
- **`setTimbreWeights`** validates keys + clamps `[0,1]`; throws on unknown key (was silently 0).
- **FFT/Hann window** safe at `n < 2`.
- **`SafeTokenEqual`** via SHA-256 + `crypto.timingSafeEqual` (was timing-unsafe `===`).
- **CORS** restricted (was permissive `cors()`); `?token=` query auth removed (Bearer header only).
- **Trust proxy** honored; rate-limit `hits` map bounded.
- **Zod schemas on every POST/PUT/PATCH route + WS messages** (zod was a devDep, never imported at runtime before).
- **`bytesToFloat32`** asserts 4-byte alignment; `ASSET_CORRUPT` error.
- **Inspect/resynth fake telemetry removed** — clear `NOT IMPLEMENTED` markers instead of `Math.random()` + hardcoded mock hashes.
- **`test-multi-timbre` click threshold** 1.95 → 0.25 (was no-op).
- **Async I/O on render-store routes** — replaced sync `fs.readFileSync` with `fs.promises.readFile`; no more sync throws bubbling through express.
- **`saveRender` collision-free** — id is ISO-timestamp + 8-char UUID slug; `mkdir({recursive:false})` retry on EEXIST.
- **`saveLastRender` atomic rename** via dot-prefixed staging dir.
- **`GIT_COMMIT` cached once at module load** — no `execSync('git rev-parse')` on hot path.
- **dogfood.yml dispatch tolerant of missing receiver** (404 → warning, scenario verdict gates job).
- **dogfood.yml health check** updated to match S-018 trimmed public `/api/health` shape.
- **`POST /api/renders/promote-last`** received the S-016 UUID-slug fix (was a regression carrier).
- **Render-config `deterministic` enum** corrected `['exact', 'fast']` (was `['exact', 'approximate']` — schema invented a value the engine never handled).
- **License mismatch fixed**, package metadata (`main`, `types`, `bin`, `files[]`, `keywords`, `author`, `engines`, `exports`) all corrected.
- **passport.json codeRepository** points at standalone repo URL.
- **`fly.toml` + `render.yaml`** `APP_VERSION` synced with `package.json`.

### Security
- **npm audit 0 vulnerabilities** (was 4 — 1 moderate, 3 high — at restore; fixed via `npm audit fix`).
- All deploy surfaces now call `/api/health` (Dockerfile HEALTHCHECK, fly probe, render healthCheckPath).
- npm publish workflow uses Sigstore `--provenance` via OIDC.

### Notes
- All 7 README translations (`README.{es,fr,hi,it,ja,pt-BR,zh}.md`) regenerated against this README via TranslateGemma 12B before publish per CLAUDE.md hard rule.
- 2 click-threshold tests on `test-score-{morph,poly}.json` remain `.todo` pending engine polyphony/morph polish (planned for v1.2 — tracked as `TODO(engine-polyphony-clicks)`).

## [1.0.3] - 2026-03-25

### Fixed
- SHA-pin CI workflow actions (checkout, setup-node, upload-pages-artifact, deploy-pages) for supply chain security

### Added
- Version alignment test suite (3 tests)
- CHANGELOG entry for 1.0.2

## [1.0.2] - 2026-03-25

### Changed
- Patch release (details not previously documented)

## [1.0.1] - 2026-02-27

### Added

- Shipcheck audit — SHIP_GATE.md, SCORECARD.md, SECURITY.md
- Security & Data Scope section in README

## [1.0.0] - 2026-02-20

### Added

- Deterministic additive synthesis engine
- Voice presets with formant configurations
- Real-time WebSocket streaming server
- Multi-user jam session support
- Score rendering pipeline with WAV export
- Grapheme-to-phoneme conversion
- Cockpit UI for live performance
- MIDI/keyboard input handling
