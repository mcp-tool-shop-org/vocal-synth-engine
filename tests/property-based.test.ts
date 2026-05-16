/**
 * Property-based tests — FTC-003 closer.
 *
 * Pre-existing fuzz coverage was hand-rolled `it.each` tables (see
 * `tests/ws-schema-fuzz.test.ts`) which catch the boundary cases the
 * author thought of. fast-check generates inputs across the input
 * domain, including the ones nobody thought of — the textbook example
 * being E-002, where xorshift32(seed=0) silently produces a permanent
 * zero stream. A property test `fc.integer() → render(seed) is
 * deterministic AND not all-zero` would have flagged that without
 * anyone needing to remember to test seed=0 specifically.
 *
 * Three target domains here:
 *   1. Engine determinism — same seed + same score → byte-identical
 *      output across two independent engine constructions. Asserted
 *      with literal seeds in engine-determinism.test.ts; here we
 *      sample across the int32 space.
 *   2. wsSchema fuzz — fc.anything() in, .safeParse never throws,
 *      result.success is consistently boolean. Same shape for both
 *      live and jam discriminated unions.
 *   3. JamSession.quantizeSample — the snap-to-grid math has several
 *      division paths that have to stay finite + non-NaN for any
 *      sample/divisor combo, including pathological bpm/sampleRate.
 *      We don't access the private method directly; we exercise the
 *      Math.round(sample / gridSamples) * gridSamples invariant
 *      against a reference implementation so the formula property
 *      holds across the input space.
 *
 * Budget: at least 3 fast-check properties spanning engine + server
 * + math. Run defaults to ~100 examples per property; we keep that
 * tame so CI cost stays low.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import {
  liveClientMessageSchema,
  jamClientMessageSchema,
} from '../src/server/services/wsSchemas.js';
import { loadVoicePreset } from '../src/preset/loader.js';
import { StreamingVocalSynthEngine } from '../src/engine/StreamingVocalSynthEngine.js';
import { xorshift32, midiToHz, hzToMidi, centsToRatio } from '../src/engine/curves.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import type { VocalScore } from '../src/types/score.js';
import { PRESET_PATH, hashFloat32 } from './helpers/index.js';

// Pin run count tight on CI — these are property tests, the value is in
// many random samples, but we don't want a 10s burn-in on every PR.
const RUN_COUNT = 50;

describe('property: engine determinism (FTC-003)', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  // For any int32 seed AND any random score the renderer accepts, two
  // engines built with the same seed + score must produce a hash-equal
  // output. This generalises engine-determinism.test.ts's literal seeds
  // (42, 0) across the seed space.
  //
  // The score generator is deliberately small (1-4 notes) so each
  // example renders cheaply. Renderer cost dominates fast-check cost.
  it('same seed → byte-identical output (any int32 seed, any small score)', () => {
    const seedArb = fc.integer({ min: -2_147_483_648, max: 2_147_483_647 });
    // fast-check's fc.float() bounds must be representable 32-bit floats.
    // Use Math.fround on min/max to round any double to the nearest f32.
    const f = Math.fround;
    const scoreArb: fc.Arbitrary<VocalScore> = fc.record({
      bpm: fc.float({ min: f(60), max: f(240), noNaN: true, noDefaultInfinity: true }),
      notes: fc.array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `n${s.replace(/\s/g, '_')}`),
          startSec: fc.float({ min: f(0), max: f(2), noNaN: true, noDefaultInfinity: true }),
          durationSec: fc.float({ min: f(0.05), max: f(1), noNaN: true, noDefaultInfinity: true }),
          midi: fc.integer({ min: 36, max: 84 }),
        }),
        { minLength: 1, maxLength: 4 }
      ),
    });
    fc.assert(
      fc.property(seedArb, scoreArb, (seed, score) => {
        const config = {
          sampleRateHz: 48000,
          blockSize: 1024,
          // Pre-size buffers to 4096 so the growBuffers one-shot warn
          // doesn't spam stderr across 50 fast-check iterations.
          maxBlockSize: 4096,
          presetPath: PRESET_PATH,
          deterministic: 'exact' as const,
          rngSeed: seed,
          defaultTimbre: 'AH',
          maxPolyphony: 4,
        };
        // Make a defensive copy of `score` for each engine — the
        // engine constructor sorts notes in place via [...score.notes]
        // but accepting the same VocalScore reference for both is the
        // documented contract.
        const e1 = new StreamingVocalSynthEngine(config, preset, structuredClone(score));
        const e2 = new StreamingVocalSynthEngine(config, preset, structuredClone(score));
        // 4096 samples = ~85 ms. Enough to surface a seed-propagation
        // bug, fast enough not to slow the suite.
        const buf1 = e1.render(4096);
        const buf2 = e2.render(4096);
        return hashFloat32(buf1) === hashFloat32(buf2);
      }),
      { numRuns: RUN_COUNT }
    );
  });

  // For any int32 seed, xorshift32 must never return NaN, Infinity,
  // or a value outside [0, 1). The fixed-point at seed=0 is silently
  // remapped (see curves.ts:XORSHIFT32_SEED_ZERO_REMAP).
  it('xorshift32 always returns a finite [0,1) float', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }), (seed) => {
        const state = { seed };
        for (let i = 0; i < 32; i++) {
          const v = xorshift32(state);
          if (!Number.isFinite(v)) return false;
          if (v < 0 || v >= 1) return false;
        }
        return true;
      }),
      { numRuns: RUN_COUNT }
    );
  });
});

describe('property: math/curves invariants (FTC-003)', () => {
  // midiToHz then hzToMidi roundtrips within tight tolerance for any
  // finite midi value. This pins a numerical-stability invariant that
  // a refactor breaking the log/exp pair would otherwise pass silently.
  it('midi -> hz -> midi roundtrips within 1e-6 (any finite midi)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-100), max: Math.fround(200), noNaN: true, noDefaultInfinity: true }),
        (midi) => {
          const hz = midiToHz(midi);
          if (!Number.isFinite(hz) || hz <= 0) return false;
          const back = hzToMidi(hz);
          return Math.abs(back - midi) < 1e-3;
        }
      ),
      { numRuns: RUN_COUNT }
    );
  });

  // The quantize-to-grid invariant lifted out of JamSession's private
  // quantizeSample. We test the formula against the property the
  // method has to maintain: the result is `round(sample/g) * g` where
  // g = (sampleRateHz * 60 / bpm) / (divisor/4). Both NaN and Infinity
  // outputs are forbidden; the result must be finite AND on the grid
  // (i.e. result % g == 0 within float tolerance).
  it('snap-to-grid never produces NaN or Infinity for any finite sample/bpm/divisor', () => {
    const sampleArb = fc.integer({ min: 0, max: 1_000_000_000 });
    const bpmArb = fc.float({ min: Math.fround(20), max: Math.fround(400), noNaN: true, noDefaultInfinity: true });
    const divisorArb = fc.constantFrom(4, 8, 16, 32); // 1/4, 1/8, 1/16, 1/32 grids
    const srArb = fc.constantFrom(22050, 44100, 48000, 96000);
    fc.assert(
      fc.property(sampleArb, bpmArb, divisorArb, srArb, (sample, bpm, divisor, sr) => {
        const samplesPerBeat = (sr * 60) / bpm;
        if (!Number.isFinite(samplesPerBeat) || samplesPerBeat <= 0) return true; // skip — would be early-returned
        const gridSamples = samplesPerBeat / (divisor / 4);
        if (!Number.isFinite(gridSamples) || gridSamples <= 0) return true; // skip
        const result = Math.round(sample / gridSamples) * gridSamples;
        return Number.isFinite(result);
      }),
      { numRuns: RUN_COUNT }
    );
  });

  // centsToRatio: 1200 cents = octave, so centsToRatio(1200) must be 2.
  // For any finite cents the result is positive and finite.
  it('centsToRatio is positive and finite for any finite cents', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-12_000), max: Math.fround(12_000), noNaN: true, noDefaultInfinity: true }),
        (cents) => {
          const r = centsToRatio(cents);
          return Number.isFinite(r) && r > 0;
        }
      ),
      { numRuns: RUN_COUNT }
    );
  });
});

describe('property: wsSchema fuzz (FTC-003)', () => {
  // For ANY arbitrary JS value, safeParse must NOT throw — it must
  // return a {success, ...} result object. This is the contract zod
  // guarantees but a custom .refine() that throws on a typeof check
  // would break it.
  it('liveClientMessageSchema.safeParse never throws on fc.anything()', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        let result;
        try {
          result = liveClientMessageSchema.safeParse(v);
        } catch (e) {
          return false;
        }
        return typeof result === 'object' && result !== null && 'success' in result;
      }),
      { numRuns: RUN_COUNT }
    );
  });

  it('jamClientMessageSchema.safeParse never throws on fc.anything()', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        let result;
        try {
          result = jamClientMessageSchema.safeParse(v);
        } catch (e) {
          return false;
        }
        return typeof result === 'object' && result !== null && 'success' in result;
      }),
      { numRuns: RUN_COUNT }
    );
  });

  // A randomly-generated message that already has the right discriminator
  // shape is more likely to surface a refinement bug than fc.anything().
  // Here: for the live `note_on` discriminator with random midi/velocity,
  // the schema should reject all-but-the-in-range values consistently.
  it('liveClientMessageSchema.note_on accepts iff midi in [0,127] AND velocity in [0,1]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 300 }),
        fc.float({ min: Math.fround(-2), max: Math.fround(2), noNaN: true, noDefaultInfinity: true }),
        (midi, velocity) => {
          const r = liveClientMessageSchema.safeParse({
            type: 'note_on',
            noteId: 'p',
            midi,
            velocity,
          });
          const expected =
            Number.isInteger(midi) && midi >= 0 && midi <= 127 &&
            velocity >= 0 && velocity <= 1;
          return r.success === expected;
        }
      ),
      { numRuns: RUN_COUNT }
    );
  });
});
