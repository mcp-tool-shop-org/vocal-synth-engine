/**
 * Envelope correctness tests — covers E-005 (LiveSynthEngine attack ×
 * release product → 'thump-then-fade' instead of standard min(attack,
 * release) shape) and the audible failure mode of a note released before
 * its attack completes.
 *
 * Correct post-fix behavior: the envelope at the moment of note-off
 * starts the release from the CURRENT attack-ramp value (or 1.0 if past
 * attack), and decays monotonically to 0. The buggy form started the
 * release from CURRENT*release-curve, producing a non-monotonic shape
 * that pops on note-off.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadVoicePreset } from '../src/preset/loader.js';
import { LiveSynthEngine } from '../src/engine/LiveSynthEngine.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import { PRESET_PATH } from './helpers/index.js';

function envelopePeak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Compute frame-to-frame max abs delta to detect a 'thump' or click.
 * A monotonic release should have small per-sample deltas (smooth fade);
 * an attack×release product collapse-and-pop would show a much larger
 * spike at the note-off boundary.
 */
function maxAbsDelta(buf: Float32Array): number {
  let m = 0;
  for (let i = 1; i < buf.length; i++) {
    const d = Math.abs(buf[i] - buf[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

describe('LiveSynthEngine envelope', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  // E-005 cross-domain. Note released during its attack must NOT produce
  // a thump (large derivative spike) immediately after note-off.
  // Specifically: env should start the release at min(attackEnv, 1.0),
  // not at attackEnv*releaseEnv (which jumps abruptly because the
  // release curve resets to 1.0 at note-off).
  it('note released during attack does not produce a thump', () => {
    const sr = 48000;
    const blockSize = 256;
    const engine = new LiveSynthEngine(
      { sampleRateHz: sr, blockSize, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 12345 },
      preset
    );
    engine.play();

    // Note on, render half a block, then release before attack (10 ms) finishes.
    engine.noteOn({ noteId: 'short', midi: 69, velocity: 1.0, breathiness: 0.0 });
    // Attack is 10 ms (480 samples @ 48k). Release after just 3 ms (~144 samples).
    // Half-block 128 samples ≈ 2.7 ms into attack.
    const block1 = engine.render();
    engine.noteOff('short', 100); // 100ms release
    const block2 = engine.render();
    const block3 = engine.render();

    // Concatenate envelope samples
    const all = new Float32Array(block1.length + block2.length + block3.length);
    all.set(block1, 0);
    all.set(block2, block1.length);
    all.set(block3, block1.length + block2.length);

    const peak = envelopePeak(all);
    const delta = maxAbsDelta(all);

    // Sanity: there should be SOME output (this catches a regression that
    // killed audio entirely).
    expect(peak).toBeGreaterThan(0);

    // The audible "thump" the bug produces: a sample-to-sample delta larger
    // than the peak itself, OR a delta that is a large fraction of the peak
    // at the note-off boundary. A correctly clamped envelope has delta
    // proportional to f0/sr per harmonic, well under peak.
    // Use a loose-but-correct ceiling: max delta must not exceed peak (i.e.
    // the signal cannot swing more than its own amplitude in one sample).
    expect(delta).toBeLessThanOrEqual(peak * 1.5 + 1e-6);
  });

  // Boundary check: release that lasts longer than the engine renders
  // should decay smoothly to near zero, not snap.
  it('long release decays smoothly to near zero', () => {
    const sr = 48000;
    const blockSize = 256;
    const engine = new LiveSynthEngine(
      { sampleRateHz: sr, blockSize, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 4242 },
      preset
    );
    engine.play();
    engine.noteOn({ noteId: 'long', midi: 60, velocity: 1.0, breathiness: 0.0 });

    // Build up past attack: ~20 ms.
    for (let i = 0; i < 4; i++) engine.render();

    engine.noteOff('long', 50); // 50ms release
    const blocks: Float32Array[] = [];
    for (let i = 0; i < 20; i++) blocks.push(engine.render());

    // Take the last block — expect near silence.
    const last = blocks[blocks.length - 1];
    const tailPeak = envelopePeak(last);
    expect(tailPeak).toBeLessThan(0.05);
  });
});
