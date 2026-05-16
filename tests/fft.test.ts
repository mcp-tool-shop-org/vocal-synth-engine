/**
 * FFT round-trip + Hann window tests — covers E-014 (applyHannWindow
 * divides by n-1 → NaN for n=1) and E-015 (no direct FFT coverage).
 *
 * Correct post-fix behavior:
 *   - fft(ifft(x)) ≈ x within float32 epsilon
 *   - applyHannWindow on n<2 must NOT NaN-poison the buffer
 *   - fft rejects non-power-of-2 and n<2 lengths
 */

import { describe, it, expect } from 'vitest';
import { fft, ifft, applyHannWindow } from '../src/dsp/fft.js';

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

describe('FFT', () => {
  it('round-trips: fft → ifft recovers input within float32 epsilon', () => {
    const n = 64;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    // Mix of impulse + sine + DC.
    real[0] = 1.0;
    for (let i = 0; i < n; i++) real[i] += Math.sin(2 * Math.PI * 3 * i / n) * 0.5;

    const realCopy = new Float32Array(real);
    const imagCopy = new Float32Array(imag);

    fft(real, imag);
    ifft(real, imag);

    expect(maxAbsDiff(real, realCopy)).toBeLessThan(1e-4);
    expect(maxAbsDiff(imag, imagCopy)).toBeLessThan(1e-4);
  });

  it('rejects non-power-of-2 length', () => {
    const r = new Float32Array(7);
    const i = new Float32Array(7);
    expect(() => fft(r, i)).toThrow();
  });

  it('rejects degenerate n=1 (no butterflies)', () => {
    const r = new Float32Array(1);
    const i = new Float32Array(1);
    expect(() => fft(r, i)).toThrow();
  });
});

describe('applyHannWindow', () => {
  // E-014 cross-domain. n=1 used to divide by zero → Infinity → NaN.
  // Post-fix behavior: early-return for n<2, no mutation.
  it('does not NaN-poison the buffer when n=1', () => {
    const buf = new Float32Array([0.5]);
    applyHannWindow(buf);
    expect(Number.isFinite(buf[0])).toBe(true);
  });

  it('handles n=0 (empty buffer) without throwing', () => {
    const buf = new Float32Array(0);
    expect(() => applyHannWindow(buf)).not.toThrow();
  });

  it('zeros the endpoints (n>=2)', () => {
    const buf = new Float32Array(64);
    buf.fill(1.0);
    applyHannWindow(buf);
    expect(buf[0]).toBeCloseTo(0, 5);
    expect(buf[buf.length - 1]).toBeCloseTo(0, 5);
    // Middle should be near 1.0.
    expect(buf[buf.length >> 1]).toBeGreaterThan(0.95);
  });
});
