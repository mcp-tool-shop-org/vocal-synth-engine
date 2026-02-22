/**
 * Generate synthetic vowel calibration WAVs for preset analysis.
 *
 * Usage: npx tsx src/cli/gen-vowel-wav.ts <out-dir>
 *
 * Produces AH.wav, EE.wav, OO.wav — 3 seconds each, 48kHz mono,
 * steady A3 (220 Hz) with formant-appropriate harmonic profiles.
 */
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SR = 48000;
const DURATION_SEC = 3;
const F0 = 220; // A3
const NUM_SAMPLES = SR * DURATION_SEC;

/**
 * Vowel formant frequencies (Hz) and relative bandwidths.
 * Based on standard male formant tables (Peterson & Barney, 1952).
 * F1, F2, F3, F4 — these shape the spectral envelope.
 */
const VOWEL_FORMANTS: Record<string, { freqs: number[]; bws: number[]; amps: number[] }> = {
  AH: {
    freqs: [730, 1090, 2440, 3400],
    bws:   [80,  90,   120,  130],
    amps:  [1.0, 0.5,  0.25, 0.1],
  },
  EE: {
    freqs: [270, 2290, 3010, 3400],
    bws:   [60,  100,  120,  130],
    amps:  [1.0, 0.7,  0.3,  0.1],
  },
  OO: {
    freqs: [300, 870, 2240, 3400],
    bws:   [60,  90,  120,  130],
    amps:  [1.0, 0.3,  0.15, 0.05],
  },
};

/**
 * Compute formant gain for a given frequency using sum of resonances.
 */
function formantGain(freq: number, formants: typeof VOWEL_FORMANTS['AH']): number {
  let gain = 0;
  for (let i = 0; i < formants.freqs.length; i++) {
    const f = formants.freqs[i];
    const bw = formants.bws[i];
    const a = formants.amps[i];
    // Lorentzian resonance shape
    const x = (freq - f) / (bw / 2);
    gain += a / (1 + x * x);
  }
  return gain;
}

async function main() {
  const outDir = resolve(process.argv[2] || 'calib/default-voice');
  await mkdir(outDir, { recursive: true });

  for (const [vowel, formants] of Object.entries(VOWEL_FORMANTS)) {
    const samples = new Float32Array(NUM_SAMPLES);

    // Pre-compute harmonic amplitudes from formant model
    const maxHarm = Math.floor((SR / 2) / F0);
    const harmonicAmps = new Float32Array(maxHarm);
    for (let k = 0; k < maxHarm; k++) {
      const freq = (k + 1) * F0;
      harmonicAmps[k] = formantGain(freq, formants);
    }

    // Normalize so peak harmonic = 1.0
    let maxAmp = 0;
    for (let k = 0; k < maxHarm; k++) {
      if (harmonicAmps[k] > maxAmp) maxAmp = harmonicAmps[k];
    }
    if (maxAmp > 0) {
      for (let k = 0; k < maxHarm; k++) harmonicAmps[k] /= maxAmp;
    }

    // Synthesize via additive harmonics
    for (let i = 0; i < NUM_SAMPLES; i++) {
      let s = 0;
      for (let k = 0; k < maxHarm; k++) {
        if (harmonicAmps[k] < 0.001) continue;
        const phase = 2 * Math.PI * (k + 1) * F0 * i / SR;
        s += harmonicAmps[k] * Math.sin(phase);
      }
      samples[i] = s;
    }

    // Normalize peak to -3 dBFS
    let peak = 0;
    for (let i = 0; i < NUM_SAMPLES; i++) {
      if (Math.abs(samples[i]) > peak) peak = Math.abs(samples[i]);
    }
    const target = Math.pow(10, -3 / 20); // ~0.708
    if (peak > 0) {
      const scale = target / peak;
      for (let i = 0; i < NUM_SAMPLES; i++) samples[i] *= scale;
    }

    // 10ms fade in/out to avoid clicks
    const fadeSamples = Math.round(0.01 * SR);
    for (let i = 0; i < fadeSamples; i++) {
      const g = i / fadeSamples;
      samples[i] *= g;
      samples[NUM_SAMPLES - 1 - i] *= g;
    }

    const wav = new WaveFile();
    wav.fromScratch(1, SR, '32f', samples);
    const outPath = join(outDir, `${vowel}.wav`);
    await writeFile(outPath, wav.toBuffer());
    console.log(`${vowel}: ${outPath} (${DURATION_SEC}s, ${SR}Hz, peak -3 dBFS)`);
  }
}

main().catch(console.error);
