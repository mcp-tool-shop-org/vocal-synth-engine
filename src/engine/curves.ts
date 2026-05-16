import { AutomationPoint } from '../types/score.js';

// ── Sine lookup table (4096 entries, ~0.09° resolution, ~70 dB SNR) ──
const SINE_TABLE_SIZE = 4096;
const SINE_TABLE_MASK = SINE_TABLE_SIZE - 1;
const SINE_TABLE = new Float32Array(SINE_TABLE_SIZE);
for (let i = 0; i < SINE_TABLE_SIZE; i++) {
  SINE_TABLE[i] = Math.sin(2 * Math.PI * i / SINE_TABLE_SIZE);
}

/** Fast sine from normalized phase [0..1). Uses 4096-entry LUT. */
export function fastSin(phase01: number): number {
  return SINE_TABLE[((phase01 * SINE_TABLE_SIZE) | 0) & SINE_TABLE_MASK];
}

// ── dB → linear conversion ──
const LN10_OVER_20 = Math.LN10 / 20; // ≈ 0.11513

/** Convert dB to linear amplitude. ~2-3× faster than Math.pow(10, db/20). */
export function dbToLinear(db: number): number {
  return Math.exp(db * LN10_OVER_20);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

export function calculateVibrato(
  tSec: number,
  noteStartSec: number,
  rateHz: number,
  depthCents: number,
  onsetSec: number
): number {
  const activeTime = tSec - noteStartSec;
  if (activeTime <= 0) return 0;
  
  // Fade in vibrato over onsetSec
  const fade = onsetSec > 0 ? Math.min(1.0, activeTime / onsetSec) : 1.0;
  
  // Sine wave LFO
  const lfo = Math.sin(2 * Math.PI * rateHz * activeTime);
  
  return depthCents * fade * lfo;
}

export function calculateAdsr(
  tSec: number,
  noteStartSec: number,
  noteEndSec: number,
  attackSec: number = 0.05,
  releaseSec: number = 0.1
): number {
  if (tSec < noteStartSec) return 0;
  
  const activeTime = tSec - noteStartSec;
  const timeFromEnd = noteEndSec - tSec;
  
  if (timeFromEnd <= 0) {
    // In release phase (or past it)
    const releaseTime = tSec - noteEndSec;
    if (releaseTime >= releaseSec) return 0;
    return 1.0 - (releaseTime / releaseSec);
  }
  
  // In attack phase
  if (activeTime < attackSec) {
    return activeTime / attackSec;
  }
  
  // Sustain phase
  return 1.0;
}

export function interpLinear(x: Float32Array, y: Float32Array, targetX: number): number {
  if (targetX <= x[0]) return y[0];
  if (targetX >= x[x.length - 1]) return y[y.length - 1];

  let i = 0;
  while (i < x.length - 1 && x[i + 1] < targetX) i++;

  // Guard against duplicate adjacent x values (denom == 0 → NaN poisoning).
  // A malformed preset with two identical frequency entries would otherwise
  // silently NaN-poison the entire output buffer.
  const denom = x[i + 1] - x[i];
  if (denom === 0) return y[i];

  const t = (targetX - x[i]) / denom;
  return y[i] + t * (y[i + 1] - y[i]);
}

/**
 * Fallback seed used when state.seed lands at xorshift32's fixed point (0).
 * The constant is the golden-ratio integer (2^32 / phi) — a well-mixed,
 * non-zero, non-trivial bit pattern commonly used to escape the xorshift
 * trap. Documented invariant: xorshift32 NEVER returns identical output
 * for two identical input seeds when seed=0 — both are silently remapped
 * to this constant. Callers should avoid seed=0 (and the renderer's
 * `rngSeed + index` arithmetic should not land voice 0 at seed 0).
 */
const XORSHIFT32_SEED_ZERO_REMAP = 0x9E3779B9 | 0;

export function xorshift32(state: { seed: number }) {
  // xorshift32 has a fixed point at 0: 0 XOR (0<<n) = 0 forever.
  // Remap silently to a non-trivial seed to avoid a permanent-zero output
  // stream (which would silence breath/consonant noise).
  if (state.seed === 0) state.seed = XORSHIFT32_SEED_ZERO_REMAP;
  let x = state.seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  state.seed = x;
  return (x >>> 0) / 4294967296.0;
}

export function interpAutomation(points: AutomationPoint[], tSec: number): number {
  if (!points || points.length === 0) return 0;
  if (points.length === 1) return points[0].value;
  if (tSec <= points[0].tSec) return points[0].value;
  if (tSec >= points[points.length - 1].tSec) return points[points.length - 1].value;
  
  let i = 0;
  while (i < points.length - 1 && points[i + 1].tSec < tSec) i++;
  
  const p0 = points[i];
  const p1 = points[i + 1];
  const t = (tSec - p0.tSec) / (p1.tSec - p0.tSec);
  return p0.value + t * (p1.value - p0.value);
}
