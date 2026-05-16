/**
 * Resynthesize a steady tone from a voice preset at a given pitch + duration.
 *
 * Usage: npx tsx src/cli/resynth.ts <preset.json> <out.wav> <f0> <duration_sec> [timbre]
 *        npx tsx src/cli/resynth.ts --help
 *
 * Standalone additive-synthesis renderer (does NOT use the streaming engine).
 * Useful for spot-checking a preset's harmonic envelope without a full score.
 */
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadVoicePreset } from '../preset/loader.js';
import { runCli, parseFiniteNumber, CliError } from './_runner.js';

const USAGE = `Usage: npx tsx src/cli/resynth.ts <preset.json> <out.wav> <f0> <duration_sec> [timbre]

Renders a steady additive-synthesis tone at <f0> Hz for <duration_sec>
seconds using the named [timbre] (defaults to first timbre in preset).
Writes <out.wav> only.

Example:
  npx tsx src/cli/resynth.ts presets/default-voice/voicepreset.json \\
    out.wav 220 2.0 AH

NOTE: This is a standalone spot-check renderer (does NOT use the streaming
engine). For a measured render with click/determinism telemetry, use
play-score.ts.

Options:
  -h, --help    Show this message and exit.`;

function interp(x: Float32Array, y: Float32Array, targetX: number): number {
  if (targetX <= x[0]) return y[0];
  if (targetX >= x[x.length - 1]) return y[y.length - 1];
  
  let i = 0;
  while (i < x.length - 1 && x[i + 1] < targetX) i++;
  
  const t = (targetX - x[i]) / (x[i + 1] - x[i]);
  return y[i] + t * (y[i + 1] - y[i]);
}

// Simple seeded RNG for deterministic noise
function xorshift32(state: { seed: number }) {
  let x = state.seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  state.seed = x;
  return (x >>> 0) / 4294967296.0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.length < 4) {
    const err: CliError = new Error(
      `expected at least 4 args (<preset.json> <out.wav> <f0> <duration_sec>), got ${args.length}`
    );
    err.hint = `run with --help for the full usage block`;
    throw err;
  }

  const [presetPath, outWav, f0Str, durStr, timbreName] = args;
  // TB-005 (4): parseFloat('abc') silently became NaN and the engine wrote a
  // silent WAV. parseFiniteNumber rejects NaN/Infinity/text at the boundary.
  const f0 = parseFiniteNumber(f0Str, 'f0');
  const durationSec = parseFiniteNumber(durStr, 'duration_sec');
  if (f0 <= 0) {
    const err: CliError = new Error(`<f0> must be positive, got ${f0}`);
    throw err;
  }
  if (durationSec <= 0) {
    const err: CliError = new Error(`<duration_sec> must be positive, got ${durationSec}`);
    throw err;
  }

  const preset = await loadVoicePreset(resolve(presetPath));
  const timbre = timbreName ? preset.timbres[timbreName] : Object.values(preset.timbres)[0];

  if (!timbre) {
    const available = Object.keys(preset.timbres).join(', ') || '(none)';
    const err: CliError = new Error(`timbre '${timbreName}' not found in preset`);
    err.hint = `available timbres: ${available}`;
    throw err;
  }

  const sampleRate = preset.manifest.sampleRateHz;
  const numSamples = Math.floor(durationSec * sampleRate);
  const outBuffer = new Float32Array(numSamples);
  
  const H = timbre.harmonicsMag.length;
  const phases = new Float32Array(H);
  
  const rngState = { seed: 123456789 }; // Deterministic seed
  
  // Precompute harmonic gains based on envelope
  const harmonicGains = new Float32Array(H);
  for (let k = 1; k <= H; k++) {
    const freq = k * f0;
    if (freq >= sampleRate / 2) break;
    const envDb = interp(timbre.freqHz, timbre.envelopeDb, freq);
    harmonicGains[k - 1] = timbre.harmonicsMag[k - 1] * Math.pow(10, envDb / 20);
  }

  // Synthesis loop
  for (let i = 0; i < numSamples; i++) {
    let sample = 0;
    
    // Harmonics
    for (let k = 1; k <= H; k++) {
      const freq = k * f0;
      if (freq >= sampleRate / 2) break;
      
      phases[k - 1] += (2 * Math.PI * freq) / sampleRate;
      if (phases[k - 1] > 2 * Math.PI) phases[k - 1] -= 2 * Math.PI;
      
      sample += harmonicGains[k - 1] * Math.sin(phases[k - 1]);
    }
    
    // Noise (simplified: white noise scaled by average noise energy)
    // In a full implementation, this would be spectrally shaped via FFT overlap-add
    const noiseVal = (xorshift32(rngState) * 2 - 1) * 0.01; // Mock noise level
    sample += noiseVal;
    
    outBuffer[i] = sample;
  }
  
  // Normalize to avoid clipping
  let maxVal = 0;
  for (let i = 0; i < numSamples; i++) {
    if (Math.abs(outBuffer[i]) > maxVal) maxVal = Math.abs(outBuffer[i]);
  }
  if (maxVal > 0) {
    for (let i = 0; i < numSamples; i++) outBuffer[i] /= maxVal;
  }

  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '32f', outBuffer);
  await writeFile(resolve(outWav), wav.toBuffer());

  // TB-008: the previous version unconditionally wrote a
  // `<out>_telemetry.json` file whose contents were labelled `_MOCK` — every
  // invocation polluted the user's output directory with a file that LOOKED
  // like telemetry. Matching the discipline T-002 applied to inspect.ts
  // (either implement real measurement or remove the affordance) we drop
  // the sidecar entirely. Users who need measured determinism / click
  // numbers should render via play-score.ts (TB-011).
  console.log(`Resynthesized audio saved to ${outWav}`);
  console.log(`  Target F0: ${f0.toFixed(2)} Hz, duration: ${durationSec.toFixed(3)}s, timbre: ${timbreName ?? Object.keys(preset.timbres)[0]}`);
  console.log(`  (no telemetry sidecar — run play-score.ts for measured determinism numbers)`);
}

runCli('resynth', main);
