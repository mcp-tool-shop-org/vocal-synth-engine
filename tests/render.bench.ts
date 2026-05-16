/**
 * Perf regression benches — FTC-004 closer.
 *
 * Vitest 4 ships `vitest bench` (tinybench under the hood). The repo's
 * whole identity is "real-time WebSocket streaming server" + "deterministic
 * additive synthesis engine", but no perf signal exists today: a 2x
 * slowdown in `StreamingVocalSynthEngine.render(blockSize)` would land
 * as a green PR with nothing flagging it.
 *
 * What we bench:
 *   1. StreamingVocalSynthEngine.render(48000 samples) — one second of
 *      audio at 48kHz, single render() call. Measures cold render cost
 *      including allocation amortization.
 *   2. LiveSynthEngine.noteOn + 100 × render() — 100 blocks of 256 samples
 *      after triggering one note. Measures the steady-state real-time
 *      path that the WebSocket /ws route exercises.
 *   3. phonemize 1000 iterations of "hello world" — the G2P + syllabify
 *      pipeline runs once per score load; bench it 1000x to amortize
 *      vitest's own per-iteration overhead.
 *
 * Gate strategy (FTC-004): the first run emits a JSON baseline file at
 * `tests/__bench__/baseline.json` (only created if not present). The CI
 * `bench-gate` job in `.github/workflows/ci.yml` runs `vitest bench`,
 * dumps results as JSON, and compares against the committed baseline.
 * Any bench that regresses > 2x fails CI loud. To rebaseline, delete
 * the baseline file and commit a fresh one (intentional opt-in).
 *
 * Why 2x and not 25%: this is a coarse "did we break the algorithm"
 * check, not a fine-grained perf-tuning loop. Engine throughput on a
 * shared CI runner has high variance — tight thresholds churn. A 2x
 * regression is "the algorithm changed shape", not "Tuesday's runner
 * was 5% slower".
 */

import { bench, describe, beforeAll } from 'vitest';
import { loadVoicePreset } from '../src/preset/loader.js';
import { StreamingVocalSynthEngine } from '../src/engine/StreamingVocalSynthEngine.js';
import { LiveSynthEngine } from '../src/engine/LiveSynthEngine.js';
import { phonemizeLyrics } from '../src/phonemize/index.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import type { VocalScore } from '../src/types/score.js';
import { PRESET_PATH } from './helpers/index.js';

let preset: LoadedVoicePreset;

beforeAll(async () => {
  preset = await loadVoicePreset(PRESET_PATH);
});

const SCORE: VocalScore = {
  bpm: 120,
  notes: [
    { id: 'n0', startSec: 0.0, durationSec: 0.4, midi: 69 },
    { id: 'n1', startSec: 0.5, durationSec: 0.4, midi: 72 },
    { id: 'n2', startSec: 1.0, durationSec: 0.4, midi: 76 },
  ],
};

describe('StreamingVocalSynthEngine.render', () => {
  bench(
    'render 48000 samples (one second @ 48kHz, exact, polyphony 4)',
    () => {
      const e = new StreamingVocalSynthEngine(
        {
          sampleRateHz: 48000,
          blockSize: 1024,
          presetPath: PRESET_PATH,
          deterministic: 'exact' as const,
          rngSeed: 42,
          defaultTimbre: 'AH',
          maxPolyphony: 4,
          maxBlockSize: 48000,
        },
        preset,
        SCORE
      );
      e.render(48000);
    },
    { iterations: 5, time: 1500 }
  );
});

describe('LiveSynthEngine real-time path', () => {
  bench(
    'noteOn + 100 × render() blocks of 256 samples (steady-state RT)',
    () => {
      const e = new LiveSynthEngine(
        {
          sampleRateHz: 48000,
          blockSize: 256,
          maxPolyphony: 4,
          defaultTimbre: 'AH',
          rngSeed: 42,
        },
        preset
      );
      e.play();
      e.noteOn({ noteId: 'n', midi: 69, velocity: 0.8, breathiness: 0.3 });
      for (let i = 0; i < 100; i++) {
        e.render();
      }
    },
    { iterations: 10, time: 1500 }
  );
});

describe('phonemizeLyrics throughput', () => {
  bench(
    'phonemizeLyrics("hello world") × 1000',
    () => {
      for (let i = 0; i < 1000; i++) {
        phonemizeLyrics('hello world', [
          { id: 'n0', startSec: 0.0, durationSec: 0.4, midi: 60 },
          { id: 'n1', startSec: 0.4, durationSec: 0.4, midi: 62 },
        ]);
      }
    },
    { iterations: 5, time: 2000 }
  );
});
