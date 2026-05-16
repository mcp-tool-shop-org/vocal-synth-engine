/**
 * Build a multi-timbre voice preset from multiple WAV inputs.
 *
 * Usage: npx tsx src/cli/build-preset.ts --out presets/default-voice \
 *   calib/default-voice/AH.wav:AH calib/default-voice/EE.wav:EE calib/default-voice/OO.wav:OO
 *
 * Each positional arg is <wav-path>:<timbre-name>.
 * All WAVs are analyzed with identical parameters (48kHz, FFT 2048, 80 harmonics)
 * and the resulting assets are combined into a single voicepreset.json.
 */
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fft, applyHannWindow } from '../dsp/fft.js';
import { findPitchYin } from '../dsp/pitch.js';

const SR = 48000;
const FFT_SIZE = 2048;
const HALF_FFT = FFT_SIZE / 2 + 1;
const MAX_HARMONICS = 80;

interface TimbreResult {
  name: string;
  f0: number;
  harmonicsMag: Float32Array;
  envelopeDb: Float32Array;
  noiseDb: Float32Array;
  freqHz: Float32Array;
}

async function analyzeWav(wavPath: string, timbreName: string): Promise<TimbreResult> {
  const wavBuffer = await readFile(resolve(wavPath));
  const wav = new WaveFile(wavBuffer);

  wav.toSampleRate(SR);
  let samples: any = wav.getSamples(false, Float32Array as any);
  if (Array.isArray(samples) || (samples.length > 0 && samples[0] instanceof Float32Array)) {
    samples = samples[0];
  }
  const mono = samples as Float32Array;

  // Take frame from center of file
  const startIdx = Math.floor(mono.length / 2) - Math.floor(FFT_SIZE / 2);
  const frame = new Float32Array(FFT_SIZE);
  frame.set(mono.subarray(startIdx, startIdx + FFT_SIZE));

  const f0 = findPitchYin(frame, SR);
  console.log(`  ${timbreName}: F0 = ${f0.toFixed(2)} Hz`);

  applyHannWindow(frame);
  const real = new Float32Array(frame);
  const imag = new Float32Array(FFT_SIZE);
  fft(real, imag);

  const mag = new Float32Array(HALF_FFT);
  for (let i = 0; i < HALF_FFT; i++) {
    mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (FFT_SIZE / 2);
  }

  const envelopeDb = new Float32Array(HALF_FFT);
  const noiseDb = new Float32Array(HALF_FFT);
  const freqHz = new Float32Array(HALF_FFT);

  const smoothWindow = Math.max(1, Math.round((f0 / SR) * FFT_SIZE));

  for (let i = 0; i < HALF_FFT; i++) {
    freqHz[i] = (i / FFT_SIZE) * SR;

    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - smoothWindow); j <= Math.min(HALF_FFT - 1, i + smoothWindow); j++) {
      sum += Math.max(1e-6, mag[j]);
      count++;
    }
    const smoothedMag = sum / count;
    envelopeDb[i] = 20 * Math.log10(smoothedMag);

    const noiseMag = Math.max(1e-6, mag[i] * 0.1);
    noiseDb[i] = 20 * Math.log10(noiseMag);
  }

  const harmonicsMag = new Float32Array(MAX_HARMONICS);
  for (let k = 1; k <= MAX_HARMONICS; k++) {
    const targetFreq = k * f0;
    if (targetFreq >= SR / 2) break;

    const bin = Math.round((targetFreq / SR) * FFT_SIZE);
    let peak = 0;
    for (let b = Math.max(0, bin - 2); b <= Math.min(HALF_FFT - 1, bin + 2); b++) {
      if (mag[b] > peak) peak = mag[b];
    }

    const envGain = Math.pow(10, envelopeDb[bin] / 20);
    harmonicsMag[k - 1] = peak / Math.max(1e-6, envGain);
  }

  return { name: timbreName, f0, harmonicsMag, envelopeDb, noiseDb, freqHz };
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --out flag
  let outDir = '';
  const inputs: { wavPath: string; timbre: string }[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = args[++i];
    } else if (args[i].includes(':')) {
      // Split on LAST colon to handle Windows drive letters (e.g. F:/path/AH.wav:AH)
      const lastColon = args[i].lastIndexOf(':');
      const wavPath = args[i].slice(0, lastColon);
      const timbre = args[i].slice(lastColon + 1);
      inputs.push({ wavPath, timbre });
    }
  }

  if (!outDir || inputs.length === 0) {
    console.error('Usage: npx tsx src/cli/build-preset.ts --out <preset-dir> <wav:timbre> [<wav:timbre> ...]');
    process.exit(1);
  }

  const presetDir = resolve(outDir);
  const assetsDir = join(presetDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  console.log(`Building preset with ${inputs.length} timbres → ${presetDir}`);

  // Analyze each input
  const results: TimbreResult[] = [];
  for (const { wavPath, timbre } of inputs) {
    results.push(await analyzeWav(wavPath, timbre));
  }

  // Validate consistency: all freqHz arrays should be identical
  const refLen = results[0].freqHz.length;
  for (let i = 1; i < results.length; i++) {
    if (results[i].freqHz.length !== refLen) {
      throw new Error(
        `ASSET_SHAPE_MISMATCH: ${results[i].name} freqHz length (${results[i].freqHz.length}) ` +
        `differs from ${results[0].name} (${refLen})`
      );
    }
  }

  // Write assets
  const writeF32 = async (name: string, data: Float32Array) => {
    await writeFile(join(assetsDir, name), Buffer.from(data.buffer));
  };

  // Shared freq axis — use first timbre's (they're all identical for same SR/FFT)
  await writeF32('freq_axis_hz.f32', results[0].freqHz);

  for (const r of results) {
    await writeF32(`${r.name}_harmonics_mag.f32`, r.harmonicsMag);
    await writeF32(`${r.name}_envelope_db.f32`, r.envelopeDb);
    await writeF32(`${r.name}_noise_db.f32`, r.noiseDb);
  }

  // Build manifest
  const manifest = {
    schema: 'mcp-voice-engine.voicepreset' as const,
    version: '0.2.0',
    id: 'vp_multi_timbre',
    sampleRateHz: SR,
    analysis: {
      frameMs: (FFT_SIZE / SR) * 1000,
      hopMs: 10,
      f0Method: 'yin',
      maxHarmonics: MAX_HARMONICS,
      envelope: { method: 'moving_average' },
      noise: { method: 'residual_approx', fftSize: FFT_SIZE },
    },
    timbres: results.map(r => ({
      name: r.name,
      kind: 'vowel',
      assets: {
        harmonicsMag: `assets/${r.name}_harmonics_mag.f32`,
        envelopeDb: `assets/${r.name}_envelope_db.f32`,
        noiseDb: `assets/${r.name}_noise_db.f32`,
        freqHz: 'assets/freq_axis_hz.f32',
      },
      defaults: {
        hnrDb: 18,
        breathiness: 0.12,
        vibrato: { rateHz: 5.8, depthCents: 35, onsetMs: 220 },
      },
    })),
    integrity: {
      assetsHash: 'sha256:pending',
      analysisHash: 'sha256:pending',
    },
  };

  await writeFile(join(presetDir, 'voicepreset.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nPreset built:`);
  console.log(`  Timbres: ${results.map(r => r.name).join(', ')}`);
  console.log(`  Harmonics: ${MAX_HARMONICS}`);
  console.log(`  Freq bins: ${refLen}`);
  console.log(`  Assets: ${assetsDir}`);
}

main().catch(console.error);
