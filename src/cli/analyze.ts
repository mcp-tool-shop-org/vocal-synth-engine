/**
 * Analyze a single WAV file into a single-timbre voice preset.
 *
 * Usage: npx tsx src/cli/analyze.ts <input.wav> <out-dir> <timbre-name> [--json]
 *        npx tsx src/cli/analyze.ts --help
 *
 * For multi-timbre presets, use build-preset.ts instead.
 */
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fft, applyHannWindow } from '../dsp/fft.js';
import { findPitchYin } from '../dsp/pitch.js';
import { computeAssetsHash } from '../preset/loader.js';
import { runCli, parseCommonFlags, CliError } from './_runner.js';

const USAGE = `Usage: npx tsx src/cli/analyze.ts <input.wav> <out-dir> <timbre-name> [--json]

Analyzes a WAV at 48kHz mono and emits a single-timbre voice preset:
  <out-dir>/voicepreset.json
  <out-dir>/assets/<timbre>_harmonics_mag.f32
  <out-dir>/assets/<timbre>_envelope_db.f32
  <out-dir>/assets/<timbre>_noise_db.f32
  <out-dir>/assets/freq_axis_hz.f32

Example:
  npx tsx src/cli/analyze.ts calib/AH.wav presets/my-voice AH

Options:
  --json        Emit a single JSON object to stdout in lieu of human banners.
                Schema: { wavPath, outDir, timbreName, f0Hz, harmonics,
                          freqBins, assetsHash, presetDir }
  -h, --help    Show this message and exit.

For multi-timbre presets see build-preset.ts.`;

async function main() {
  const { help, json, positionals } = parseCommonFlags(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length < 3) {
    const err: CliError = new Error(
      `expected 3 positional args (<input.wav> <out-dir> <timbre-name>), got ${positionals.length}`
    );
    err.hint = `run with --help for the full usage block`;
    throw err;
  }

  const [wavPath, outDir, timbreName] = positionals;
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

  // T-006: refuse WAVs shorter than one FFT frame. The previous code computed
  // `startIdx = Math.floor(mono.length/2) - Math.floor(fftSize/2)` which went
  // NEGATIVE for inputs under ~43ms at 48kHz, then mono.subarray(negative, ...)
  // counted from the end of the array (V8 TypedArray semantics) and produced
  // either garbage or an empty slice. Pitch + envelope estimates downstream
  // ran on that garbage with no error. Throw clearly instead.
  if (mono.length < fftSize) {
    const err: CliError = new Error(
      `input WAV too short: ${mono.length} samples at 48 kHz = ${(mono.length / sampleRate).toFixed(3)}s ` +
      `(need at least ${fftSize} samples ~${(fftSize / sampleRate).toFixed(3)}s)`
    );
    err.hint = `record a longer take, or pad with silence — analyze needs one full FFT frame`;
    throw err;
  }

  const startIdx = Math.floor(mono.length / 2) - Math.floor(fftSize / 2);
  const frame = new Float32Array(fftSize);
  frame.set(mono.subarray(startIdx, startIdx + fftSize));

  const f0 = findPitchYin(frame, sampleRate);
  if (!json) console.log(`Analyzing ${wavPath}... F0 = ${f0.toFixed(2)} Hz`);
  
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

  // T-007: write assets first so we can hash the actual on-disk bytes
  // (Float32Array buffers re-used by the writer happen to be identical to
  // file contents but going through Buffer.from(...) keeps the same code
  // path as analyze.ts → loader.ts and avoids any subtle slicing surprise).
  const assetEntries = new Map<string, Buffer>();
  const writeF32 = async (relPath: string, data: Float32Array) => {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await writeFile(join(presetDir, relPath), buf);
    assetEntries.set(relPath, buf);
  };

  await writeF32(`assets/${timbreName}_harmonics_mag.f32`, harmonicsMag);
  await writeF32(`assets/${timbreName}_envelope_db.f32`, envelopeDb);
  await writeF32(`assets/${timbreName}_noise_db.f32`, noiseDb);
  await writeF32(`assets/freq_axis_hz.f32`, freqHz);

  // T-007: real SHA-256 over the asset bytes via the SAME helper the loader
  // uses for verification — guarantees a round-trip passes integrity checks.
  // The `analysisHash` slot is intentionally dropped: the loader only
  // verifies assetsHash, and shipping a second stub-named hash field would
  // re-introduce the "integrity for show" pattern T-007 is closing.
  const assetsHash = computeAssetsHash(assetEntries);

  // T-010: align with build-preset.ts on schema version 0.2.0. The previous
  // mismatch (analyze=0.1.0, build-preset=0.2.0) plus the unconstrained
  // schema let two CLIs ship presets that the loader treated identically
  // while their version strings drifted.
  const manifest = {
    schema: "mcp-voice-engine.voicepreset",
    version: "0.2.0",
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
      assetsHash,
    }
  };

  await writeFile(join(presetDir, 'voicepreset.json'), JSON.stringify(manifest, null, 2));

  if (json) {
    // Stable schema — document in CHANGELOG when fields change.
    const out = {
      wavPath: resolve(wavPath),
      outDir: presetDir,
      timbreName,
      f0Hz: Number(f0.toFixed(2)),
      harmonics: maxHarmonics,
      freqBins: halfFft,
      assetsHash,
      presetDir,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else {
    console.log(`Preset saved to ${presetDir}`);
    console.log(`Integrity: ${assetsHash}`);
  }
}

runCli('analyze', main);
