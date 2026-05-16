/**
 * Engine determinism tests — covers E-002 (xorshift32 seed=0 fixed point),
 * E-007 (updateConfig rngSeed must propagate to voices), and the README's
 * core "deterministic additive synthesis" claim.
 *
 * Two engines constructed with identical rngSeed and fed identical input
 * must produce byte-identical output. If they do not, the package's
 * marketing claim is false.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadVoicePreset } from '../src/preset/loader.js';
import { StreamingVocalSynthEngine } from '../src/engine/StreamingVocalSynthEngine.js';
import { LiveSynthEngine } from '../src/engine/LiveSynthEngine.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import type { VocalScore } from '../src/types/score.js';
import { PRESET_PATH, hashFloat32 } from './helpers/index.js';

function makeScore(): VocalScore {
  return {
    bpm: 120,
    notes: [
      { id: 'n0', startSec: 0.0, durationSec: 0.4, midi: 69 },
      { id: 'n1', startSec: 0.5, durationSec: 0.4, midi: 72 },
    ],
  };
}

describe('engine determinism', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  /**
   * Render a fixed number of samples using repeated render() calls of
   * at most `blockSize`. Returns the concatenated output. This honors
   * the StreamingVocalSynthEngine maxBlockSize cap (E-011 fix).
   */
  function renderInBlocks(
    engine: StreamingVocalSynthEngine,
    totalSamples: number,
    blockSize: number
  ): Float32Array {
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

  // E-002 / TS-001 cross-domain assertion. Same seed must produce identical
  // PCM output, byte-for-byte. A regression that silently dropped seed
  // propagation, or replaced xorshift32 with Math.random(), will fail here.
  it('StreamingVocalSynthEngine — same seed → byte-identical output', () => {
    const blockSize = 1024;
    const config = {
      sampleRateHz: 48000,
      blockSize,
      presetPath: PRESET_PATH,
      deterministic: 'exact' as const,
      rngSeed: 42,
      defaultTimbre: 'AH',
      maxPolyphony: 4,
    };
    const e1 = new StreamingVocalSynthEngine(config, preset, makeScore());
    const e2 = new StreamingVocalSynthEngine(config, preset, makeScore());

    const buf1 = renderInBlocks(e1, 48000, blockSize);
    const buf2 = renderInBlocks(e2, 48000, blockSize);

    expect(buf1.length).toBe(buf2.length);
    expect(hashFloat32(buf1)).toBe(hashFloat32(buf2));
  });

  // E-002 specifically: rngSeed=0 must NOT produce a silent / zero stream
  // for the first voice. The renderer uses `rngSeed + index` so voice 0
  // lands at xorshift32's fixed point. With remap, output should NOT be
  // permanently zero AND must remain deterministic.
  it('StreamingVocalSynthEngine — rngSeed=0 is handled deterministically', () => {
    const blockSize = 1024;
    const config = {
      sampleRateHz: 48000,
      blockSize,
      presetPath: PRESET_PATH,
      deterministic: 'exact' as const,
      rngSeed: 0,
      defaultTimbre: 'AH',
      maxPolyphony: 4,
    };
    const e1 = new StreamingVocalSynthEngine(config, preset, makeScore());
    const e2 = new StreamingVocalSynthEngine(config, preset, makeScore());

    const buf1 = renderInBlocks(e1, 48000, blockSize);
    const buf2 = renderInBlocks(e2, 48000, blockSize);

    expect(hashFloat32(buf1)).toBe(hashFloat32(buf2));
    // Must not be permanently silent.
    let hasNonZero = false;
    for (let i = 0; i < buf1.length; i++) {
      if (buf1[i] !== 0) { hasNonZero = true; break; }
    }
    expect(hasNonZero).toBe(true);
  });

  it('StreamingVocalSynthEngine — different seeds → different output', () => {
    const blockSize = 1024;
    const baseConfig = {
      sampleRateHz: 48000,
      blockSize,
      presetPath: PRESET_PATH,
      deterministic: 'exact' as const,
      defaultTimbre: 'AH',
      maxPolyphony: 4,
    };
    const e1 = new StreamingVocalSynthEngine({ ...baseConfig, rngSeed: 1 }, preset, makeScore());
    const e2 = new StreamingVocalSynthEngine({ ...baseConfig, rngSeed: 999_999 }, preset, makeScore());

    const buf1 = renderInBlocks(e1, 48000, blockSize);
    const buf2 = renderInBlocks(e2, 48000, blockSize);

    // Output may overlap structurally (same harmonics) but the noise
    // component must differ. Hash must NOT match.
    expect(hashFloat32(buf1)).not.toBe(hashFloat32(buf2));
  });

  // E-007 cross-domain. updateConfig({ rngSeed }) on LiveSynthEngine must
  // propagate to per-voice renderers. If the seed is only stored in
  // this.config and never pushed down, two engines constructed once and
  // re-seeded later would still produce divergent output (the same as if
  // re-seed did nothing). The post-fix behavior: re-seed should make
  // outputs match between an originally-seeded engine and a re-seeded one.
  it('LiveSynthEngine — updateConfig rngSeed actually propagates (E-007)', () => {
    const baseConfig = {
      sampleRateHz: 48000,
      blockSize: 256,
      maxPolyphony: 2,
      defaultTimbre: 'AH',
    };

    // Engine A: born with seed 7, played with one note.
    const a = new LiveSynthEngine({ ...baseConfig, rngSeed: 7 }, preset);
    a.play();
    a.noteOn({ noteId: 'n', midi: 69, velocity: 1.0, breathiness: 0.5 });
    const a1 = a.render();

    // Engine B: born with seed 999, then re-seeded to 7 BEFORE play.
    const b = new LiveSynthEngine({ ...baseConfig, rngSeed: 999 }, preset);
    b.updateConfig({ rngSeed: 7 });
    b.play();
    b.noteOn({ noteId: 'n', midi: 69, velocity: 1.0, breathiness: 0.5 });
    const b1 = b.render();

    // If updateConfig does propagate the seed, A's and B's first-block
    // noise output should match. If not, they diverge from sample 0 of
    // the breath/consonant noise.
    expect(hashFloat32(a1)).toBe(hashFloat32(b1));
  });
});
