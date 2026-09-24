# vocal-synth-engine: how it works

Mapped at 2026-09-24 from commit f8fe895.

## What this is

10 parts, mostly TypeScript (99 files). Work enters through 15 doors; CI and Release each reach 3 parts, and CI is followed because a pull request goes through it. It publishes to npm. People run vocal-synth-engine-mcp, vse-analyze, vse-build-preset, vse-compare, vse-gen-vowel-wav, vse-inspect, vse-phonemize, vse-play-score, vse-resynth and vse-score-from-midi. People import @mcptoolshop/vocal-synth-engine.

## What changed since the last map

This is the first map.

## What comes in

1. **CI.** On a pull request touching 10 paths; on a push to main touching 10 paths; on a schedule (`0 6 * * 1`), Monday at 06:00 UTC; or by hand. Runs scripts/bench-gate.mjs, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more; checks src/.
2. **Release.** When a tag matching `v*` is pushed. Runs scripts/verify.sh, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more; checks src/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **Dogfood.** On a push to main touching 3 paths; or by hand. On main, it runs src/server/index.prod.ts; checks src/.
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

1. The workflow runs scripts/bench-gate.mjs in scripts and 17 files in tests; it checks src/ in src.
2. It writes to tests/__bench__/baseline.json.

## Who reads the results

Only CI itself reads what it writes.

## The other doors

**Release** runs scripts/verify.sh, tests/cross-domain-stage-c.test.ts, tests/curves.test.ts and 15 more, checks src/, publishes to npm, and creates a GitHub release.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**Dogfood** runs src/server/index.prod.ts and checks src/ on main, runs git, and sends a dispatch to mcp-tool-shop-org/dogfood-labs on main.

**@mcptoolshop/vocal-synth-engine** (the package people import) loads src/index.ts, src/engine/LiveSynthEngine.ts, src/engine/StreamingVocalSynthEngine.ts and 8 more.

**vocal-synth-engine-mcp** (a command people run) runs src/mcp/server.ts and runs git.

**vse-analyze** (a command people run) runs src/cli/analyze.ts and writes to assets/.

**vse-build-preset** (a command people run) runs src/cli/build-preset.ts.

**vse-compare** (a command people run) runs src/cli/compare.ts.

**vse-gen-vowel-wav** (a command people run) runs src/cli/gen-vowel-wav.ts.

**vse-inspect** (a command people run) runs src/cli/inspect.ts.

**vse-phonemize** (a command people run) runs src/cli/phonemize.ts.

**vse-play-score** (a command people run) runs src/cli/play-score.ts.

**vse-resynth** (a command people run) runs src/cli/resynth.ts.

**vse-score-from-midi** (a command people run) runs src/cli/score-from-midi.ts.

## What breaks what

- **src** is imported by 1 part (scripts), and by 1 more only from tests; it sits on the path of 14 doors.
- **scripts** is imported by no other part and sits on the path of 2 doors.
- **tests** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

No two source files changed together often enough to name.

Window: 180 days; a pair counts from 3 shared commits, since the window holds fewer than 30 qualifying commits.

## What no test touches

- **cockpit** is imported by no test.
- **scripts** is imported by no test.

## Written but never read

- **assets/** is written by src/cli/analyze.ts and read by nothing else in this repository.
- **ref/ah_sustain.wav** is written by scripts/generate-ref-wav.ts and read by nothing else in this repository.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

- **assets/** is written by src/cli/analyze.ts.
- **ref/ah_sustain.wav** is written by scripts/generate-ref-wav.ts.
- **tests/__bench__/baseline.json** has a block written by scripts/bench-gate.mjs.

## Hand-authored

People write .github/, presets/, the repository root and site/; 4 writes with paths built at run time may land here.

## Where to start

.github/workflows/ci.yml → src/index.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 4 writes and 9 reads use paths built at run time and are not named here.
- 33 writes and 50 reads go to the directory the command is run in, the home directory or a path its caller passes, not to this repository.
- 1 command is built at run time and not followed, and it is in tests.
- Statistics confidence is low: fewer than 30 qualifying commits in the window, and fewer than 20 source files reach 10 revisions.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
