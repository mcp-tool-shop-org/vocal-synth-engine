# vocal-synth-engine: how it works

Mapped at 2026-09-30 from commit 231081d by Atlas 1.24.0.

## What this is

10 parts, mostly TypeScript (99 files), JavaScript (3), Astro (2), CSS (2), shell (2), HTML (1) and Python (1). Work enters through 15 doors; CI and Release each reach 3 parts, and CI is followed because a pull request goes through it. It publishes to npm. It deploys a site to GitHub Pages. People run vocal-synth-engine-mcp, vse-analyze, vse-build-preset, vse-compare, vse-gen-vowel-wav, vse-inspect, vse-phonemize, vse-play-score, vse-resynth and vse-score-from-midi. People import @mcptoolshop/vocal-synth-engine.

## What changed since 2026-09-24 (f8fe895)

- CI's pull request trigger now also names `codecov.yml`.
- CI's push trigger now also names `codecov.yml`.
- assets was generated and is now authored.
- 1 file added and 203 changed content, across 9 parts.

## What comes in

1. **CI.** On a pull request to main touching 11 paths; on a push to main touching 11 paths; on a schedule (`0 6 * * 1`), Monday at 06:00 UTC; or by hand. Runs scripts/bench-gate.mjs, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more; builds src/.
2. **Release.** When a tag matching `v*` is pushed. Runs scripts/verify.sh, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more; builds src/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **Dogfood.** On a push to main touching 3 paths; or by hand. On main, it runs src/server/index.prod.ts; builds src/.
5. **@mcptoolshop/vocal-synth-engine** (the package people import). Loads src/index.ts, src/engine/LiveSynthEngine.ts, src/engine/StreamingVocalSynthEngine.ts and 8 more.
6. **vocal-synth-engine-mcp** (a command people run). Runs src/mcp/server.ts.
7. **vse-analyze** (a command people run). Runs src/cli/analyze.ts.
8. **vse-build-preset** (a command people run). Runs src/cli/build-preset.ts.
9. **vse-compare** (a command people run). Runs src/cli/compare.ts.
10. **vse-gen-vowel-wav** (a command people run). Runs src/cli/gen-vowel-wav.ts.
11. **vse-inspect** (a command people run). Runs src/cli/inspect.ts.
12. **vse-phonemize** (a command people run). Runs src/cli/phonemize.ts.
13. **vse-play-score** (a command people run). Runs src/cli/play-score.ts.
14. **vse-resynth** (a command people run). Runs src/cli/resynth.ts.
15. **vse-score-from-midi** (a command people run). Runs src/cli/score-from-midi.ts.

## What happens through CI

1. The workflow runs scripts/bench-gate.mjs in scripts and 17 files in tests; it builds src/ in src.
2. It uploads coverage to Codecov.

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs scripts/verify.sh, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more, builds src/, publishes to npm, and creates a GitHub release.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**Dogfood** runs src/server/index.prod.ts on main, runs git, and sends a dispatch to mcp-tool-shop-org/dogfood-labs on main.

**@mcptoolshop/vocal-synth-engine** (the package people import) loads src/index.ts, src/engine/LiveSynthEngine.ts, src/engine/StreamingVocalSynthEngine.ts and 8 more.

**vocal-synth-engine-mcp** (a command people run) runs src/mcp/server.ts and runs git.

**vse-analyze** (a command people run) runs src/cli/analyze.ts.

**vse-build-preset** (a command people run) runs src/cli/build-preset.ts.

**vse-compare** (a command people run) runs src/cli/compare.ts.

**vse-gen-vowel-wav** (a command people run) runs src/cli/gen-vowel-wav.ts.

**vse-inspect** (a command people run) runs src/cli/inspect.ts.

**vse-phonemize** (a command people run) runs src/cli/phonemize.ts.

**vse-play-score** (a command people run) runs src/cli/play-score.ts.

**vse-resynth** (a command people run) runs src/cli/resynth.ts.

**vse-score-from-midi** (a command people run) runs src/cli/score-from-midi.ts.

## What breaks what

- **src** is imported by 1 part (scripts), and by 1 more only from tests, is called over HTTP by 2 parts (cockpit, scripts), and sits on the path of 14 doors.
- **scripts** is imported by no other part and sits on the path of 2 doors.
- **tests** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

No two source files changed together often enough to name.

Window: 180 days; a pair counts from 3 shared commits, since the window holds fewer than 30 qualifying commits.

## What no test touches

- **cockpit** is imported by no test.
- **scripts** is imported by no test.

apps/cockpit/tests/smoke.spec.ts runs in no workflow.

## Written but never read

- **ref/ah_sustain.wav** is written by scripts/generate-ref-wav.ts and read by nothing else in this repository.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

- **ref/ah_sustain.wav** is written by scripts/generate-ref-wav.ts.
- **tests/__bench__/baseline.json** is written once by scripts/bench-gate.mjs when absent.

## Hand-authored

People write .github/, assets/, presets/, the repository root and site/. Nothing in this repository writes to them.

## Where to start

.github/workflows/ci.yml → src/index.ts → src/engine/LiveSynthEngine.ts → src/engine/renderer.ts → src/engine/curves.ts → src/types/score.ts → src/types/scoreSchema.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 4 reads use paths built at run time and are not named here.
- 28 writes and 33 reads go to the directory the command is run in (.vscockpit/, assets/, calib/ and 2 more places) or a path their caller passes, not to this repository.
- 7 writes and 21 reads go to a path their caller passes, not to this repository.
- 4 writes and 1 read go to the directory the command is run in, not to this repository.
- cockpit calls src over HTTP at 11 routes, a link no import shows: the map draws it, and no door's reach follows it.
- scripts calls src over HTTP at 1 route, a link no import shows: the map draws it, and no door's reach follows it.
- There is a Dockerfile, a fly.toml and a render.yaml that no workflow runs; what deploys from them does so from outside this repository, and is not on this page.
- Statistics confidence is low: fewer than 30 qualifying commits in the window, and fewer than 25 source files reach 10 revisions.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
