import { AutomationPoint } from '../types/score.js';

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
  
  const t = (targetX - x[i]) / (x[i + 1] - x[i]);
  return y[i] + t * (y[i + 1] - y[i]);
}

export function xorshift32(state: { seed: number }) {
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
