import { describe, it, expect } from 'vitest';
import {
  fastSin,
  dbToLinear,
  midiToHz,
  hzToMidi,
  centsToRatio,
  calculateVibrato,
  calculateAdsr,
  interpLinear,
  xorshift32,
  interpAutomation,
} from '../src/engine/curves.js';

describe('midiToHz / hzToMidi', () => {
  it('A4 (MIDI 69) = 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 5);
  });

  it('C4 (MIDI 60) ~= 261.63 Hz', () => {
    expect(midiToHz(60)).toBeCloseTo(261.63, 1);
  });

  it('round-trips correctly', () => {
    for (const midi of [48, 60, 69, 72, 84]) {
      expect(hzToMidi(midiToHz(midi))).toBeCloseTo(midi, 5);
    }
  });
});

describe('fastSin', () => {
  it('returns 0 at phase 0', () => {
    expect(fastSin(0)).toBeCloseTo(0, 2);
  });

  it('returns ~1 at phase 0.25', () => {
    expect(fastSin(0.25)).toBeCloseTo(1, 2);
  });

  it('returns ~0 at phase 0.5', () => {
    expect(fastSin(0.5)).toBeCloseTo(0, 2);
  });
});

describe('dbToLinear', () => {
  it('0 dB = 1.0', () => {
    expect(dbToLinear(0)).toBeCloseTo(1.0, 5);
  });

  it('-6 dB ~= 0.5', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3);
  });

  it('-20 dB = 0.1', () => {
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 5);
  });
});

describe('centsToRatio', () => {
  it('0 cents = ratio 1.0', () => {
    expect(centsToRatio(0)).toBeCloseTo(1.0, 5);
  });

  it('1200 cents = ratio 2.0 (one octave)', () => {
    expect(centsToRatio(1200)).toBeCloseTo(2.0, 5);
  });
});

describe('calculateVibrato', () => {
  it('returns 0 before note starts', () => {
    expect(calculateVibrato(0, 1.0, 5, 50, 0.2)).toBe(0);
  });

  it('returns non-zero during active vibrato', () => {
    const v = calculateVibrato(2.0, 1.0, 5, 50, 0.2);
    expect(Math.abs(v)).toBeGreaterThan(0);
  });
});

describe('calculateAdsr', () => {
  it('returns 0 before note starts', () => {
    expect(calculateAdsr(0, 1.0, 2.0)).toBe(0);
  });

  it('returns 1.0 during sustain', () => {
    expect(calculateAdsr(1.5, 1.0, 2.0, 0.05, 0.1)).toBe(1.0);
  });

  it('returns 0 after release completes', () => {
    expect(calculateAdsr(3.0, 1.0, 2.0, 0.05, 0.1)).toBe(0);
  });

  it('ramps up during attack', () => {
    const t = 1.025; // halfway through 0.05s attack
    const val = calculateAdsr(t, 1.0, 2.0, 0.05, 0.1);
    expect(val).toBeGreaterThan(0);
    expect(val).toBeLessThan(1);
  });
});

describe('interpLinear', () => {
  it('interpolates between two points', () => {
    const x = new Float32Array([0, 1]);
    const y = new Float32Array([0, 10]);
    expect(interpLinear(x, y, 0.5)).toBeCloseTo(5, 5);
  });

  it('clamps below range', () => {
    const x = new Float32Array([1, 2]);
    const y = new Float32Array([10, 20]);
    expect(interpLinear(x, y, 0)).toBe(10);
  });

  it('clamps above range', () => {
    const x = new Float32Array([1, 2]);
    const y = new Float32Array([10, 20]);
    expect(interpLinear(x, y, 5)).toBe(20);
  });
});

describe('xorshift32', () => {
  it('produces different values on successive calls', () => {
    const state = { seed: 42 };
    const a = xorshift32(state);
    const b = xorshift32(state);
    expect(a).not.toBe(b);
  });

  it('produces values in [0, 1)', () => {
    const state = { seed: 12345 };
    for (let i = 0; i < 100; i++) {
      const v = xorshift32(state);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('interpAutomation', () => {
  it('returns 0 for empty array', () => {
    expect(interpAutomation([], 1.0)).toBe(0);
  });

  it('returns single point value', () => {
    expect(interpAutomation([{ tSec: 0, value: 42 }], 1.0)).toBe(42);
  });

  it('interpolates between points', () => {
    const points = [
      { tSec: 0, value: 0 },
      { tSec: 1, value: 100 },
    ];
    expect(interpAutomation(points, 0.5)).toBeCloseTo(50, 5);
  });
});
