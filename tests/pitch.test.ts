/**
 * Pitch detection tests — covers E-004 (findPitchYin on silent input
 * computes 0/0 in CMNDF normalization and returns sampleRate / -1 =
 * negative Hz, silently wrong).
 *
 * Correct post-fix behavior: silent input returns 0 (no pitch detected)
 * OR throws — but NEVER a negative or NaN frequency.
 */

import { describe, it, expect } from 'vitest';
import { findPitchYin } from '../src/dsp/pitch.js';

describe('findPitchYin', () => {
  // Sanity: sine input must yield correct pitch.
  it('detects a 220 Hz sine accurately', () => {
    const sr = 44100;
    const f0 = 220;
    const n = 4096;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * f0 * i / sr);
    const detected = findPitchYin(buf, sr);
    expect(detected).toBeGreaterThan(f0 * 0.95);
    expect(detected).toBeLessThan(f0 * 1.05);
  });

  it('detects a 440 Hz sine accurately', () => {
    const sr = 48000;
    const f0 = 440;
    const n = 4096;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * f0 * i / sr);
    const detected = findPitchYin(buf, sr);
    expect(detected).toBeGreaterThan(f0 * 0.95);
    expect(detected).toBeLessThan(f0 * 1.05);
  });

  // E-004 cross-domain. Silent (all-zero) input must not return a negative
  // frequency. Acceptable post-fix outputs: 0 (documented no-pitch), or
  // throw. NEVER negative, NEVER NaN.
  it('silent input does NOT return a negative or NaN frequency', () => {
    const sr = 48000;
    const buf = new Float32Array(4096); // all zeros
    let result: number | undefined;
    let threw = false;
    try {
      result = findPitchYin(buf, sr);
    } catch {
      threw = true;
    }
    if (!threw) {
      expect(result).toBeDefined();
      const r = result as number;
      expect(Number.isNaN(r)).toBe(false);
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });

  // Also: input with denormal/very-small noise should not collapse to
  // negative frequency. Tests the runningSum guard.
  it('near-silent input (1e-30 noise) does not produce negative Hz', () => {
    const sr = 48000;
    const buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (i % 2 === 0 ? 1 : -1) * 1e-30;
    let result: number | undefined;
    let threw = false;
    try {
      result = findPitchYin(buf, sr);
    } catch {
      threw = true;
    }
    if (!threw) {
      const r = result as number;
      expect(Number.isNaN(r)).toBe(false);
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });
});
