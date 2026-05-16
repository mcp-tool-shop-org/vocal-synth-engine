/**
 * Build a multi-timbre voice preset from multiple WAV inputs.
 *
 * Usage: npx tsx src/cli/build-preset.ts --out presets/default-voice \
 *          calib/default-voice/AH.wav:AH calib/default-voice/EE.wav:EE calib/default-voice/OO.wav:OO
 *        npx tsx src/cli/build-preset.ts --help
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
import { computeAssetsHash } from '../preset/loader.js';
import { runCli, CliError } from './_runner.js';

// Strict timbre-name shape closes TB-005 (2): empty timbre ('foo.wav:') no
// longer creates `assets/_harmonics_mag.f32` and a manifest entry with
// `name: ''`. Keep it permissive enough for common identifiers (AH, EE_2,
// vowel-1) but reject obvious malformed values at the boundary.
const TIMBRE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

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

  // T-006: refuse WAVs shorter than one FFT frame (same defect previously in
  // analyze.ts at line 31). Negative startIdx → V8 counts from end of array
  // → garbage F0 + spectrum → silent broken preset. Fail loudly instead.
  if (mono.length < FFT_SIZE) {
    const err: CliError = new Error(
      `input WAV '${wavPath}' too short: ${mono.length} samples at 48 kHz = ` +
      `${(mono.length / SR).toFixed(3)}s (need at least ${FFT_SIZE} samples ` +
      `~${(FFT_SIZE / SR).toFixed(3)}s)`
    );
    err.hint = `record a longer take or pad with silence`;
    throw err;
  }

  // Take frame from center of file
  const startIdx = Math.floor(mono.length / 2) - Math.floor(FFT_SIZE / 2);
  const frame = new Float32Array(FFT_SIZE);
  frame.set(mono.subarray(startIdx, startIdx + FFT_SIZE));

  const f0 = findPitchYin(frame, SR);
  // Caller (main) reports per-file F0 — TB-007 progress indication.
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

const USAGE = `Usage: npx tsx src/cli/build-preset.ts --out <preset-dir> <wav:timbre> [<wav:timbre> ...] [--json]

Builds a multi-timbre voicepreset.json + asset files from one or more WAV
inputs. Each positional argument is <wav-path>:<timbre-name> (split on the
LAST colon so Windows drive letters work, e.g. F:/calib/AH.wav:AH).

Example:
  npx tsx src/cli/build-preset.ts --out presets/my-voice \\
    calib/AH.wav:AH calib/EE.wav:EE calib/OO.wav:OO

Options:
  --out <dir>   Output preset directory (required).
  --json        Emit a single JSON object to stdout in lieu of human banners.
                Schema: { presetDir, timbres[], harmonics, freqBins, assetsHash }
  -h, --help    Show this message and exit.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  // Parse --out + --json flags, leave wav:timbre positionals untouched.
  let outDir = '';
  let json = false;
  const inputs: { wavPath: string; timbre: string }[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        // TB-005 (1): --out used to silently default to '' when missing the
        // value; now we throw so a typo doesn't write to the wrong directory.
        const err: CliError = new Error(`--out requires a directory argument`);
        err.hint = `e.g. --out presets/my-voice`;
        throw err;
      }
      outDir = args[++i];
    } else if (args[i] === '--json') {
      json = true;
    } else if (args[i].includes(':')) {
      // Split on LAST colon to handle Windows drive letters (e.g. F:/path/AH.wav:AH)
      const lastColon = args[i].lastIndexOf(':');
      const wavPath = args[i].slice(0, lastColon);
      const timbre = args[i].slice(lastColon + 1);

      // TB-005 (2): reject empty timbre / known-flag-as-timbre at the
      // boundary so we don't write asset files keyed by '' or 'out'.
      if (!TIMBRE_NAME_RE.test(timbre)) {
        const err: CliError = new Error(
          `invalid timbre name '${timbre}' in '${args[i]}'`
        );
        err.hint = `timbre names must match /^[A-Za-z][A-Za-z0-9_-]*$/ (e.g. AH, vowel_1)`;
        throw err;
      }
      inputs.push({ wavPath, timbre });
    }
  }

  if (!outDir) {
    const err: CliError = new Error(`missing required --out <preset-dir>`);
    err.hint = `run with --help for the full usage block`;
    throw err;
  }
  if (inputs.length === 0) {
    const err: CliError = new Error(`no <wav-path>:<timbre-name> inputs given`);
    err.hint = `pass one or more positional args like calib/AH.wav:AH`;
    throw err;
  }

  const presetDir = resolve(outDir);
  const assetsDir = join(presetDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  if (!json) console.log(`Building preset with ${inputs.length} timbres → ${presetDir}`);

  // Analyze each input — TB-007: announce each file before its FFT pass so a
  // multi-second per-WAV run no longer feels like a hung terminal.
  const results: TimbreResult[] = [];
  for (const { wavPath, timbre } of inputs) {
    if (!json) process.stdout.write(`  Analyzing ${wavPath}... `);
    const r = await analyzeWav(wavPath, timbre);
    if (!json) process.stdout.write(`F0 = ${r.f0.toFixed(2)} Hz\n`);
    results.push(r);
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

  // Write assets and collect bytes (keyed by manifest-relative path) so we
  // can compute the integrity hash via the same helper the loader uses for
  // verification — closes T-007.
  const assetEntries = new Map<string, Buffer>();
  const writeF32 = async (relPath: string, data: Float32Array) => {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await writeFile(join(presetDir, relPath), buf);
    assetEntries.set(relPath, buf);
  };

  // Shared freq axis — use first timbre's (they're all identical for same SR/FFT)
  await writeF32('assets/freq_axis_hz.f32', results[0].freqHz);

  for (const r of results) {
    await writeF32(`assets/${r.name}_harmonics_mag.f32`, r.harmonicsMag);
    await writeF32(`assets/${r.name}_envelope_db.f32`, r.envelopeDb);
    await writeF32(`assets/${r.name}_noise_db.f32`, r.noiseDb);
  }

  // T-007: real SHA-256 from on-disk asset bytes via the shared helper. No
  // more 'sha256:pending' — the loader will reject any future mismatch.
  const assetsHash = computeAssetsHash(assetEntries);

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
    // analysisHash dropped — T-007 closes the "integrity for show" pattern.
    // The loader only verifies assetsHash; shipping a second hash field with
    // a stub value would re-introduce the exact misleading behaviour.
    integrity: {
      assetsHash,
    },
  };

  await writeFile(join(presetDir, 'voicepreset.json'), JSON.stringify(manifest, null, 2));

  if (json) {
    // Stable schema — document in CHANGELOG when fields change.
    const out = {
      presetDir,
      timbres: results.map(r => ({ name: r.name, f0Hz: Number(r.f0.toFixed(2)) })),
      harmonics: MAX_HARMONICS,
      freqBins: refLen,
      assetsHash,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else {
    console.log(`\nPreset built:`);
    console.log(`  Timbres: ${results.map(r => r.name).join(', ')}`);
    console.log(`  Harmonics: ${MAX_HARMONICS}`);
    console.log(`  Freq bins: ${refLen}`);
    console.log(`  Assets: ${assetsDir}`);
    console.log(`  Integrity: ${assetsHash}`);
  }
}

runCli('build-preset', main);
