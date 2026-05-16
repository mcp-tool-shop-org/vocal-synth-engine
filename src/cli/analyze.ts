import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fft, applyHannWindow } from '../dsp/fft.js';
import { findPitchYin } from '../dsp/pitch.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: npx tsx src/cli/analyze.ts <input.wav> <out-dir> <timbre-name>');
    process.exit(1);
  }

  const [wavPath, outDir, timbreName] = args;
  const wavBuffer = await readFile(resolve(wavPath));
  const wav = new WaveFile(wavBuffer);
  
  wav.toSampleRate(48000);
  let samples: any = wav.getSamples(false, Float32Array as any);
  // Handle multi-channel by taking the first channel
  if (Array.isArray(samples) || (samples.length > 0 && samples[0] instanceof Float32Array)) {
    samples = samples[0];
  }
  const mono = samples as Float32Array;
  
  const sampleRate = 48000;
  const fftSize = 2048;
  const halfFft = fftSize / 2 + 1;
  
  const startIdx = Math.floor(mono.length / 2) - Math.floor(fftSize / 2);
  const frame = new Float32Array(fftSize);
  frame.set(mono.subarray(startIdx, startIdx + fftSize));
  
  const f0 = findPitchYin(frame, sampleRate);
  console.log(`Detected F0: ${f0.toFixed(2)} Hz`);
  
  applyHannWindow(frame);
  const real = new Float32Array(frame);
  const imag = new Float32Array(fftSize);
  fft(real, imag);
  
  const mag = new Float32Array(halfFft);
  for (let i = 0; i < halfFft; i++) {
    mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (fftSize / 2);
  }
  
  const envelopeDb = new Float32Array(halfFft);
  const noiseDb = new Float32Array(halfFft);
  const freqHz = new Float32Array(halfFft);
  
  const smoothWindow = Math.max(1, Math.round((f0 / sampleRate) * fftSize));
  
  for (let i = 0; i < halfFft; i++) {
    freqHz[i] = (i / fftSize) * sampleRate;
    
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - smoothWindow); j <= Math.min(halfFft - 1, i + smoothWindow); j++) {
      sum += Math.max(1e-6, mag[j]);
      count++;
    }
    const smoothedMag = sum / count;
    envelopeDb[i] = 20 * Math.log10(smoothedMag);
    
    const noiseMag = Math.max(1e-6, mag[i] * 0.1);
    noiseDb[i] = 20 * Math.log10(noiseMag);
  }

  const maxHarmonics = 80;
  const harmonicsMag = new Float32Array(maxHarmonics);
  for (let k = 1; k <= maxHarmonics; k++) {
    const targetFreq = k * f0;
    if (targetFreq >= sampleRate / 2) break;
    
    const bin = Math.round((targetFreq / sampleRate) * fftSize);
    let peak = 0;
    for (let b = Math.max(0, bin - 2); b <= Math.min(halfFft - 1, bin + 2); b++) {
      if (mag[b] > peak) peak = mag[b];
    }
    
    // Normalize the harmonic magnitude by the envelope to get the source magnitude
    const envGain = Math.pow(10, envelopeDb[bin] / 20);
    harmonicsMag[k - 1] = peak / Math.max(1e-6, envGain);
  }
  
  const presetDir = resolve(outDir);
  const assetsDir = join(presetDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  
  const manifest = {
    schema: "mcp-voice-engine.voicepreset",
    version: "0.1.0",
    id: `vp_analyzed_${timbreName}`,
    sampleRateHz: sampleRate,
    analysis: {
      frameMs: (fftSize / sampleRate) * 1000,
      hopMs: 10,
      f0Method: "yin",
      maxHarmonics,
      envelope: { method: "moving_average" },
      noise: { method: "residual_approx", fftSize }
    },
    timbres: [
      {
        name: timbreName,
        kind: "vowel",
        assets: {
          harmonicsMag: `assets/${timbreName}_harmonics_mag.f32`,
          envelopeDb: `assets/${timbreName}_envelope_db.f32`,
          noiseDb: `assets/${timbreName}_noise_db.f32`,
          freqHz: `assets/freq_axis_hz.f32`
        },
        defaults: {
          hnrDb: 18,
          breathiness: 0.12,
          vibrato: { rateHz: 5.8, depthCents: 35, onsetMs: 220 }
        }
      }
    ],
    integrity: {
      assetsHash: "sha256:mock_assets_hash",
      analysisHash: "sha256:mock_analysis_hash"
    }
  };
  
  await writeFile(join(presetDir, 'voicepreset.json'), JSON.stringify(manifest, null, 2));
  
  const writeF32 = async (name: string, data: Float32Array) => {
    await writeFile(join(assetsDir, name), Buffer.from(data.buffer));
  };
  
  await writeF32(`${timbreName}_harmonics_mag.f32`, harmonicsMag);
  await writeF32(`${timbreName}_envelope_db.f32`, envelopeDb);
  await writeF32(`${timbreName}_noise_db.f32`, noiseDb);
  await writeF32(`freq_axis_hz.f32`, freqHz);
  
  console.log(`Preset saved to ${presetDir}`);
}

main().catch(console.error);
