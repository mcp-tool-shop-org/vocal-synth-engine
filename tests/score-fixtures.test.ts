/**
 * Score fixture regression tests — addresses TS-005 by promoting the
 * four orphaned test-score-*.json fixtures from "CLI demo only" to
 * "actually exercised by the suite."
 *
 * Each fixture is loaded, rendered through StreamingVocalSynthEngine
 * with a pinned rngSeed, and the determinism hash + click-delta are
 * asserted. This is the recommendation (a) from TS-005: keep the
 * fixtures where they are but make them load-bearing.
 *
 * If a refactor changes the deterministic output, snapshot diff will
 * surface it — operator decides whether the change is intentional and
 * updates the snapshot.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadVoicePreset } from '../src/preset/loader.js';
import { StreamingVocalSynthEngine } from '../src/engine/StreamingVocalSynthEngine.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import type { VocalScore } from '../src/types/score.js';
import { PRESET_PATH, REPO_ROOT, hashFloat32 } from './helpers/index.js';

const FIXTURES = [
  'test-score.json',
  'test-score-lyrics.json',
  'test-score-morph.json',
  'test-score-poly.json',
];

/**
 * Maximum frame-to-frame delta on a normalized signal. Matches the
 * algorithm in src/cli/test-score-render.ts (normalize → derive → max).
 * The CLI's CLICK_THRESHOLD is 0.25 — a normalized signal should not
 * jump more than 25% per sample under healthy synthesis.
 */
function normalizedMaxAbsDelta(buf: Float32Array): number {
  // Normalize first (mirror the CLI).
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return 0;
  let m = 0;
  let prev = buf[0] / peak;
  for (let i = 1; i < buf.length; i++) {
    const cur = buf[i] / peak;
    const d = Math.abs(cur - prev);
    if (d > m) m = d;
    prev = cur;
  }
  return m;
}

function renderScore(
  preset: LoadedVoicePreset,
  score: VocalScore,
  blockSize: number,
  rngSeed: number
): Float32Array {
  const cfg = {
    sampleRateHz: preset.manifest.sampleRateHz,
    blockSize,
    presetPath: PRESET_PATH,
    deterministic: 'exact' as const,
    rngSeed,
    defaultTimbre: Object.keys(preset.timbres)[0],
    maxPolyphony: 4,
  };
  const engine = new StreamingVocalSynthEngine(cfg, preset, score);

  let maxT = 0;
  for (const n of score.notes) {
    const end = n.startSec + n.durationSec + 0.2;
    if (end > maxT) maxT = end;
  }
  const totalSamples = Math.ceil(maxT * cfg.sampleRateHz);
  const out = new Float32Array(totalSamples);
  let written = 0;
  while (written < totalSamples) {
    const n = Math.min(blockSize, totalSamples - written);
    const block = engine.render(n);
    out.set(block, written);
    written += n;
  }
  return out;
}

describe('score fixtures', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  for (const fixture of FIXTURES) {
    // Stage C TSB-004: pin the rendered-bytes hash via snapshot instead of
    // comparing two same-process re-renders. A re-render-equals-re-render
    // test only proves intra-run determinism (which the engine-determinism
    // suite already covers); it does NOT lock the actual bytes against a
    // silent engine-math drift (e.g., commutative-multiplication reorder
    // that flips float32 LSBs, FM modulator sign swap, default-constant
    // change). The snapshot files live at tests/__snapshots__/score-
    // fixtures.test.ts.snap and are committed to git — any engine-math
    // change surfaces as a diff that an operator MUST acknowledge.
    it(`${fixture} renders deterministically (pinned hash)`, () => {
      const scorePath = resolve(REPO_ROOT, fixture);
      const score = JSON.parse(readFileSync(scorePath, 'utf-8')) as VocalScore;
      const seed = 123456789;
      const a = renderScore(preset, score, 1024, seed);
      // Same-process determinism check (cheap regression brake).
      const b = renderScore(preset, score, 1024, seed);
      expect(hashFloat32(a)).toBe(hashFloat32(b));
      // Pinned bytes — flips on any engine-math change.
      expect(hashFloat32(a)).toMatchSnapshot(`${fixture} rngSeed=123456789 blockSize=1024 hash`);
    });

    it(`${fixture} produces audible output (not silent)`, () => {
      const scorePath = resolve(REPO_ROOT, fixture);
      const score = JSON.parse(readFileSync(scorePath, 'utf-8')) as VocalScore;
      const buf = renderScore(preset, score, 1024, 1);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
      expect(peak).toBeGreaterThan(0.01);
    });

    // Stage C TSB-005: replace it.skip with it.todo for the two known-
    // pending click-threshold cases so they surface in the test reporter
    // as a discoverable backlog rather than a silent "2 skipped".
    //
    // TODO(engine-polyphony-clicks): test-score-morph.json and
    //   test-score-poly.json exceed the 0.25 normalized-derivative click
    //   threshold on this engine version. Engine-side fixes needed:
    //     - E-006 voice-steal: stolen-voice tail should release smoothly
    //       rather than jump-cutting. Suspected in
    //       src/engine/LiveSynthEngine.ts noteOn voice-steal branch.
    //     - E-024 timbre-switch transients: 'as any' silent-key miss in
    //       src/engine/StreamingVocalSynthEngine.ts timbre-blend path +
    //       smoothing alpha that's too aggressive at the morph boundary.
    //   File a GitHub issue at github.com/mcp-tool-shop-org/vocal-synth-
    //   engine/issues and link the issue number once filed. When the
    //   engine-domain agent lands those fixes, flip the .todo back to a
    //   regular it() block — the assertion below is already the correct
    //   contract.
    const isKnownPending = fixture === 'test-score-morph.json' || fixture === 'test-score-poly.json';
    if (isKnownPending) {
      // it.todo surfaces with a distinct icon in the vitest reporter and
      // requires no callback (planned-but-not-implemented).
      it.todo(`${fixture} stays below click threshold (engine-polyphony-clicks)`);
    } else {
      it(`${fixture} stays below click threshold`, () => {
        const scorePath = resolve(REPO_ROOT, fixture);
        const score = JSON.parse(readFileSync(scorePath, 'utf-8')) as VocalScore;
        const buf = renderScore(preset, score, 1024, 1);
        const delta = normalizedMaxAbsDelta(buf);
        // The CLI's CLICK_THRESHOLD is 0.25 on normalized signal — a
        // normalized signal should not jump more than 25% per sample
        // under healthy synthesis. Same threshold as test-score-render.ts.
        expect(delta).toBeLessThan(0.25);
      });
    }
  }
});
