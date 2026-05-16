---
title: CLI Reference
description: Every shipped CLI in src/cli — arguments, flags, output, examples, and JSON schema for --json mode.
sidebar:
  order: 7
---

Vocal Synth Engine ships nine command-line tools in `src/cli/`. All of them honour `--json` (machine-readable single-object output to stdout) and `-h` / `--help`. Run any of them with `--help` for the full usage banner. Two new tools (`vse-score-from-midi`, `vse-phonemize`) are planned and noted at the end of this page.

| Tool             | Entry                          | One-line purpose                                                     |
|------------------|--------------------------------|----------------------------------------------------------------------|
| `analyze`        | `src/cli/analyze.ts`           | Build a single-timbre voice preset from one calibration WAV.         |
| `build-preset`   | `src/cli/build-preset.ts`      | Build a multi-timbre voice preset from N calibration WAVs.           |
| `compare`        | `src/cli/compare.ts`           | A/B compare two WAVs by peak / RMS / max abs delta.                  |
| `gen-vowel-wav`  | `src/cli/gen-vowel-wav.ts`     | Generate AH/EE/OO calibration WAVs (A3=220Hz, 48kHz mono, peak -3dB).|
| `inspect`        | `src/cli/inspect.ts`           | Print a voice preset's manifest + timbre list.                       |
| `play-score`     | `src/cli/play-score.ts`        | Render a VocalScore JSON to WAV using a preset.                      |
| `realtime-demo`  | `src/cli/realtime-demo.ts`     | Architecture demo — worker_threads + streaming engine + telemetry.   |
| `resynth`        | `src/cli/resynth.ts`           | Standalone single-tone renderer for spot-checking a timbre.          |

Invoke via `npx tsx src/cli/<tool>.ts ...` or via the npm scripts (only `inspect` is wired in `package.json` today; add others on demand).

---

## `analyze`

```
npx tsx src/cli/analyze.ts <input.wav> <out-dir> <timbre-name> [--json]
```

Analyses a single calibration WAV (48kHz mono) and writes a one-timbre preset to `<out-dir>`:

```
<out-dir>/voicepreset.json
<out-dir>/assets/<timbre>_harmonics_mag.f32
<out-dir>/assets/<timbre>_envelope_db.f32
<out-dir>/assets/<timbre>_noise_db.f32
<out-dir>/assets/freq_axis_hz.f32
```

**Example**

```bash
npx tsx src/cli/analyze.ts calib/AH.wav presets/my-voice AH
```

**JSON output (`--json`)** — `{ ok: true, presetDir, manifestPath, timbres: [name] }` or `{ ok: false, code, message }`.

---

## `build-preset`

```
npx tsx src/cli/build-preset.ts --out <preset-dir> <wav:timbre> [<wav:timbre> ...] [--json]
```

Same shape as `analyze` but accepts multiple `<wav>:<timbre>` positional pairs to build a multi-timbre preset in a single pass. Splits on the LAST colon, so Windows drive letters (`F:/calib/AH.wav:AH`) work.

**Example**

```bash
npx tsx src/cli/build-preset.ts --out presets/my-voice \
  calib/AH.wav:AH calib/EE.wav:EE calib/OO.wav:OO
```

---

## `compare`

```
npx tsx src/cli/compare.ts <ref.wav> <test.wav> [--json]
```

Compares two WAVs sample-by-sample. Returns peak dBFS for each file, RMS, max absolute delta, and a verdict (`identical` / `close` / `different`). Used in regression tests to detect synth drift.

**Example**

```bash
npx tsx src/cli/compare.ts golden/song.wav out.wav --json
```

**JSON output** — `{ ok, peakA, peakB, rmsA, rmsB, maxAbsDelta, verdict }`.

---

## `gen-vowel-wav`

```
npx tsx src/cli/gen-vowel-wav.ts [<out-dir>]
```

Generates `AH.wav`, `EE.wav`, `OO.wav` calibration files (3 s each, 48 kHz mono, A3 = 220 Hz, peak −3 dBFS, 10 ms fade in/out). Defaults to writing into `calib/`.

**Example**

```bash
npx tsx src/cli/gen-vowel-wav.ts calib/my-voice
```

---

## `inspect`

```
npx tsx src/cli/inspect.ts <path-to-voicepreset.json> [--json]
```

Prints the manifest header of a voice preset (name, formatVersion, default timbre, pitch range, list of timbres). Useful for verifying a freshly-built preset.

**npm script**

```bash
npm run inspect -- presets/default-voice/voicepreset.json
```

**JSON output** — `{ ok, manifest: { id, name, formatVersion, defaultTimbre, pitchRangeMidi, timbres: [...] } }`.

---

## `play-score`

```
npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav> [--json]
```

The canonical "offline render" tool. Loads a preset + a VocalScore (see [Score Format](/handbook/score-format/)) and writes a WAV. Deterministic given the same inputs + seed.

**Example**

```bash
npx tsx src/cli/play-score.ts \
  presets/kokoro-am-michael/voicepreset.json \
  examples/lullaby.json \
  out/lullaby.wav
```

**JSON output** — `{ ok, wavPath, durationSec, telemetry: { peakDbfs, voicesMax, rtf, ... }, provenance: { ... } }`.

---

## `realtime-demo`

```
npx tsx src/cli/realtime-demo.ts <preset.json> <score.json>
```

Architecture demo only. Spawns a `worker_threads` audio thread, renders blocks (`blockSize=512`) with `deterministic="fast"` + `Date.now()` seed, and prints per-10-block RTF telemetry. After 1 s the control thread posts an `update_score` message to demonstrate cross-thread live edits. **No real audio device** — for deterministic offline renders use `play-score`.

---

## `resynth`

```
npx tsx src/cli/resynth.ts <preset.json> <out.wav> <f0> <duration_sec> [timbre]
```

Standalone single-tone renderer. Plays one steady additive-synthesis tone at `<f0>` Hz for `<duration_sec>` seconds using the named timbre (or the preset's default). Bypasses the streaming engine — useful for spot-checking a single timbre after `build-preset`.

**Example**

```bash
npx tsx src/cli/resynth.ts presets/default-voice/voicepreset.json out.wav 220 2.0 AH
```

---

## Common conventions

- **`--json`** — every CLI emits exactly one line of JSON to stdout. Errors emit `{ ok: false, code, message, hint? }`. Use this in scripts; do not screen-scrape the human banner.
- **`-h, --help`** — full usage block to stderr; exit code 0.
- **Exit code** — 0 on success, non-zero on any error. The non-zero code is the same value across all CLIs so shells can rely on `if ! npx tsx … ; then` chains.

---

## Planned

The following CLIs are scoped for the next release:

- **`vse-score-from-midi`** — convert a `.mid` file to a VocalScore JSON.
- **`vse-phonemize`** — wrap the `/api/phonemize` G2P pipeline in a CLI for offline workflows.

Both will follow the conventions above (`--json`, `-h, --help`, deterministic exit codes). Watch the CHANGELOG.
