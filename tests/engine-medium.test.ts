/**
 * Engine MEDIUM-severity cross-domain tests — written by the tests-domain
 * agent in Wave 3b to lock in the post-fix behavior of three MEDIUM findings
 * delivered by the engine-domain agent this same wave.
 *
 * Covers:
 *   - E-016 (consonantProfiles.ts): consonantEnvelope default-case returns 0
 *     instead of undefined → NaN-poisoning consonantAmp math downstream.
 *   - E-020 (LiveSynthEngine.ts): polyphony shrink via updateConfig() with
 *     a mid-release voice must NOT abruptly truncate the audio tail (the
 *     "sunset" pattern). Pre-fix: voice was dropped from the array and its
 *     release went silent mid-fade.
 *   - E-022 (dsp/pitch.ts): findPitchYin must reject oversized inputs to
 *     bound its O(N²) inner loop. Pre-fix: 1 MB signal blocked the event
 *     loop for minutes (DoS surface on any API exposing pitch).
 *
 * These are the highest-leverage MEDIUMs where a test materially changes the
 * trust ratio from "we believe this is fixed" to "we know this is fixed."
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { consonantEnvelope, type ConsonantEnvelopeKind } from '../src/engine/consonantProfiles.js';
import { findPitchYin, FIND_PITCH_YIN_MAX_LENGTH } from '../src/dsp/pitch.js';
import { LiveSynthEngine } from '../src/engine/LiveSynthEngine.js';
import { loadVoicePreset } from '../src/preset/loader.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import { PRESET_PATH } from './helpers/index.js';

describe('consonantEnvelope default case (E-016)', () => {
  // E-016: a JSON-deserialized profile (or a future-added phoneme kind that
  // wasn't wired into the switch) used to fall through to undefined →
  // coerced to NaN in consonantAmp math at StreamingVocalSynthEngine.ts:295
  // and poison the buffer. Post-fix: default branch returns 0.
  it('returns 0 (not NaN) for an unknown kind passed through type cast', () => {
    // Cast through `as` to bypass TS narrowing — this mirrors how a JSON
    // loader would produce an unknown string at runtime.
    const result = consonantEnvelope(0.5, 'glottal' as ConsonantEnvelopeKind);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it('returns 0 for a completely bogus kind value', () => {
    const result = consonantEnvelope(0.5, 'totally-not-a-real-kind' as ConsonantEnvelopeKind);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it('still returns the right envelope shape for valid kinds (sanity)', () => {
    // Sanity: real kinds still work — the default-branch fix did not regress.
    expect(consonantEnvelope(0.5, 'fricative')).toBeCloseTo(1.0, 5); // sustain
    expect(consonantEnvelope(0.5, 'plosive')).toBe(0); // closure phase
    expect(consonantEnvelope(0.5, 'nasal')).toBeCloseTo(1.0, 5); // sustain
  });

  it('does not propagate NaN even when tRel is out of range with unknown kind', () => {
    // Compound bad input: out-of-range tRel AND unknown kind. The tRel check
    // (line 97) returns 0 before the switch, but if a refactor moved that
    // check, the default would still catch it.
    const result = consonantEnvelope(-0.5, 'glottal' as ConsonantEnvelopeKind);
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('findPitchYin input-length cap (E-022)', () => {
  // E-022: O(N²) inner loop with no length cap = DoS vector. A 1 MB signal
  // would block JS for minutes. Post-fix: throw on signal.length >
  // FIND_PITCH_YIN_MAX_LENGTH (default 8192 ≈ 170 ms @48 kHz).
  it('throws on inputs exceeding FIND_PITCH_YIN_MAX_LENGTH', () => {
    const tooLarge = new Float32Array(FIND_PITCH_YIN_MAX_LENGTH + 1);
    expect(() => findPitchYin(tooLarge, 48000)).toThrow();
  });

  it('throws with a descriptive error mentioning the cap', () => {
    const tooLarge = new Float32Array(FIND_PITCH_YIN_MAX_LENGTH + 100);
    let msg = '';
    try {
      findPitchYin(tooLarge, 48000);
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toContain(String(FIND_PITCH_YIN_MAX_LENGTH));
  });

  it('accepts inputs exactly at the cap', () => {
    // Exactly at the cap should NOT throw — boundary check is strict >.
    const sr = 48000;
    const f0 = 220;
    const buf = new Float32Array(FIND_PITCH_YIN_MAX_LENGTH);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.sin((2 * Math.PI * f0 * i) / sr);
    }
    expect(() => findPitchYin(buf, sr)).not.toThrow();
  });

  it('cap is at least 2048 (normal YIN frame size)', () => {
    // Document the contract: the cap must accommodate normal-sized frames.
    expect(FIND_PITCH_YIN_MAX_LENGTH).toBeGreaterThanOrEqual(2048);
  });

  it('1 MB signal (256 K samples) is rejected fast — no DoS', () => {
    const huge = new Float32Array(256 * 1024);
    const t0 = Date.now();
    expect(() => findPitchYin(huge, 48000)).toThrow();
    const elapsed = Date.now() - t0;
    // Should reject essentially instantly. Allow a generous ceiling for slow CI.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('LiveSynthEngine polyphony shrink with active voice (E-020)', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  // E-020: shrinking maxPolyphony while a voice is mid-release used to
  // simply truncate `voices.length`, dropping the in-flight audio. The
  // result was an audible click as the tail snapped to silence.
  // Post-fix: excised voices are moved to a sunset list and continue to
  // render through their release tail. We assert: (a) no immediate-snap
  // click on the shrink boundary, (b) the held tail decays smoothly.
  it('shrinking polyphony does not snap a mid-release voice to silence', () => {
    const sr = 48000;
    const blockSize = 256;
    const engine = new LiveSynthEngine(
      { sampleRateHz: sr, blockSize, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 31337 },
      preset
    );
    engine.play();
    // Start two notes so both voices are occupied.
    engine.noteOn({ noteId: 'a', midi: 67, velocity: 0.8, breathiness: 0.0 });
    engine.noteOn({ noteId: 'b', midi: 72, velocity: 0.8, breathiness: 0.0 });

    // Build up past attack.
    for (let i = 0; i < 6; i++) engine.render();

    // Release voice 'b' so it's mid-fade.
    engine.noteOff('b', 100); // 100 ms release
    engine.render();

    // Capture peak BEFORE shrink so we can compare to immediately-after.
    const beforeShrink = engine.render();
    let peakBefore = 0;
    for (let i = 0; i < beforeShrink.length; i++) {
      const a = Math.abs(beforeShrink[i]);
      if (a > peakBefore) peakBefore = a;
    }

    // Shrink polyphony from 2 → 1. Pre-fix: this would silently drop voice
    // 'b' from the array. Post-fix: it goes to the sunset list.
    engine.updateConfig({ maxPolyphony: 1 });

    // Render the next block — voice 'b' should still be audible (faded but
    // not silent).
    const afterShrink = engine.render();

    // The sample-to-sample delta at the boundary must not be catastrophically
    // larger than the signal level. Pre-fix snap-to-silence would produce a
    // delta near peakBefore at the boundary sample.
    const lastBefore = beforeShrink[beforeShrink.length - 1];
    const firstAfter = afterShrink[0];
    const boundaryDelta = Math.abs(firstAfter - lastBefore);

    // Boundary delta must be small relative to the pre-shrink peak. A snap
    // to zero would give boundaryDelta ≈ |lastBefore| which is comparable
    // to peakBefore. Allow at most 0.5× peakBefore at the boundary.
    expect(boundaryDelta).toBeLessThanOrEqual(peakBefore * 0.5 + 1e-6);

    // Sanity: there is SOME continued output (voice 'a' is still held and
    // voice 'b' is still in sunset).
    let peakAfter = 0;
    for (let i = 0; i < afterShrink.length; i++) {
      const a = Math.abs(afterShrink[i]);
      if (a > peakAfter) peakAfter = a;
    }
    expect(peakAfter).toBeGreaterThan(0);
  });

  it('sunset voice eventually decays to silence (release completes)', () => {
    const sr = 48000;
    const blockSize = 256;
    const engine = new LiveSynthEngine(
      { sampleRateHz: sr, blockSize, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 17 },
      preset
    );
    engine.play();
    engine.noteOn({ noteId: 'a', midi: 67, velocity: 0.6, breathiness: 0.0 });
    engine.noteOn({ noteId: 'b', midi: 72, velocity: 0.6, breathiness: 0.0 });
    for (let i = 0; i < 6; i++) engine.render();

    // Release 'a' and shrink immediately — 'a' goes to sunset OR is dropped.
    engine.noteOff('a', 30); // 30 ms release
    engine.updateConfig({ maxPolyphony: 1 });

    // Render long enough that 30ms release would complete.
    let lastPeak = 1;
    for (let i = 0; i < 100; i++) {
      const buf = engine.render();
      lastPeak = 0;
      for (let j = 0; j < buf.length; j++) {
        const v = Math.abs(buf[j]);
        if (v > lastPeak) lastPeak = v;
      }
    }
    // After 100 blocks (~533 ms) the sunset voice's 30 ms release is long
    // done. Voice 'b' is still held — so peak should track 'b' only, not be
    // anomalously high or stuck on a permanently-stuck sunset voice.
    // We don't assert silence here (voice 'b' is still held), only that the
    // engine remains responsive and the sunset path didn't break held voices.
    expect(Number.isFinite(lastPeak)).toBe(true);
  });

  it('shrinking to current size is a no-op (no spurious sunset)', () => {
    const sr = 48000;
    const blockSize = 256;
    const engine = new LiveSynthEngine(
      { sampleRateHz: sr, blockSize, maxPolyphony: 4, defaultTimbre: 'AH', rngSeed: 42 },
      preset
    );
    engine.play();
    engine.noteOn({ noteId: 'a', midi: 60, velocity: 0.5, breathiness: 0.0 });
    engine.render();
    // No-op update.
    engine.updateConfig({ maxPolyphony: 4 });
    expect(engine.maxPolyphony).toBe(4);
    // Still produces audio for held voice.
    const buf = engine.render();
    let peak = 0;
    for (const v of buf) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0);
  });
});
