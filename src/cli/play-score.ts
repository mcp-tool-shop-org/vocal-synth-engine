/**
 * Render a score JSON through a voice preset and write the result to WAV.
 *
 * Usage: npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav>
 *        npx tsx src/cli/play-score.ts --help
 *
 * Uses StreamingVocalSynthEngine in 'exact' deterministic mode with a fixed
 * RNG seed (123456789) so the same inputs always produce byte-identical output.
 */
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadVoicePreset } from '../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../engine/StreamingVocalSynthEngine.js';
import { VocalScore, parseVocalScore } from '../types/score.js';
import { runCli, parseCommonFlags, CliError } from './_runner.js';

const USAGE = `Usage: npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav> [--json]

Renders a score (notes[]) through a voice preset using the streaming engine
in deterministic 'exact' mode (rngSeed=123456789, blockSize=1024,
maxPolyphony=4) and writes the normalized result to <out.wav>.

Example:
  npx tsx src/cli/play-score.ts presets/default-voice/voicepreset.json \\
    test-score.json out.wav --json

After the render, prints a telemetry block (durationSec, peakDbfs,
maxAbsDelta, RTF, determinismHash) so a regression in the streaming engine
is visible without a separate measurement pass.

Options:
  --json        Emit a single JSON object to stdout in lieu of human banners.
                Schema: { outWav, durationSec, peakDbfs, maxAbsDelta,
                          maxDeltaTimeSec, elapsedMs, rtf, determinismHash }
  -h, --help    Show this message and exit.`;

async function main() {
  const { help, json, positionals } = parseCommonFlags(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length < 3) {
    const err: CliError = new Error(
      `expected 3 positional args (<preset.json> <score.json> <out.wav>), got ${positionals.length}`
    );
    err.hint = `run with --help for the full usage block`;
    throw err;
  }

  const [presetPath, scorePath, outWav] = positionals;

  const preset = await loadVoicePreset(resolve(presetPath));
  const scoreContent = await readFile(resolve(scorePath), 'utf-8');
  // T-009: validate score JSON shape (notes[]/bpm/MIDI ranges/finite durations)
  // before handing to the synth engine. JSON.parse-and-pray silently propagated
  // NaN/Infinity into render() and produced NaN audio.
  let score: VocalScore;
  try {
    score = parseVocalScore(scoreContent) as VocalScore;
  } catch (err: any) {
    const cliErr: CliError = new Error(`invalid score JSON at ${scorePath}: ${err.message}`);
    cliErr.hint = `validate against VocalScoreSchema — see src/types/scoreSchema.ts`;
    throw cliErr;
  }

  const config: StreamingVocalSynthConfig = {
    sampleRateHz: preset.manifest.sampleRateHz,
    blockSize: 1024,
    presetPath: resolve(presetPath),
    deterministic: "exact",
    rngSeed: 123456789,
    defaultTimbre: Object.keys(preset.timbres)[0],
    maxPolyphony: 4
  };

  const engine = new StreamingVocalSynthEngine(config, preset, score);

  // Find total duration of score
  let maxTimeSec = 0;
  for (const note of score.notes) {
    const endSec = note.startSec + note.durationSec + 0.2; // Add release tail
    if (endSec > maxTimeSec) maxTimeSec = endSec;
  }

  const totalSamples = Math.ceil(maxTimeSec * config.sampleRateHz);
  const outBuffer = new Float32Array(totalSamples);
  const totalBlocks = Math.ceil(totalSamples / config.blockSize);

  if (!json) {
    // TB-007 progress — announce the render before the long compute, plus a
    // simple percent log on a TTY so a hung process is distinguishable from
    // a slow one. Kept off non-TTY (CI / pipes) to keep logs clean.
    console.log(
      `Rendering ${totalSamples} samples (${maxTimeSec.toFixed(1)}s) ` +
      `in ${totalBlocks} blocks of ${config.blockSize}...`
    );
  }

  const renderStart = performance.now();
  let offset = 0;
  let nextProgressBlock = Math.max(1, Math.floor(totalBlocks / 10));
  let blockIdx = 0;
  while (offset < totalSamples) {
    const blockSamples = Math.min(config.blockSize, totalSamples - offset);
    const block = engine.render(blockSamples);
    outBuffer.set(block, offset);
    offset += blockSamples;
    blockIdx++;
    if (!json && process.stdout.isTTY && blockIdx >= nextProgressBlock) {
      const pct = Math.min(100, Math.round((blockIdx / totalBlocks) * 100));
      process.stdout.write(`\r  Render: ${pct}%`);
      nextProgressBlock += Math.max(1, Math.floor(totalBlocks / 10));
    }
  }
  const elapsedMs = performance.now() - renderStart;
  if (!json && process.stdout.isTTY) process.stdout.write(`\r  Render: 100%\n`);

  // Normalize
  let peakRawVal = 0;
  for (let i = 0; i < totalSamples; i++) {
    if (Math.abs(outBuffer[i]) > peakRawVal) peakRawVal = Math.abs(outBuffer[i]);
  }
  if (peakRawVal > 0) {
    for (let i = 0; i < totalSamples; i++) outBuffer[i] /= peakRawVal;
  }

  // TB-011: compute the same telemetry block test-score-render.ts already
  // computes — durationSec, peakDbfs, maxAbsDelta (click detector), RTF,
  // determinismHash — so the keeper CLI exposes the regression signal
  // production users actually need.
  const durationSec = totalSamples / config.sampleRateHz;
  // After normalization, peak is 1.0 (or 0 if silent). Report the PRE-norm
  // peak in dBFS — that's the value an operator actually wants for clipping
  // / headroom diagnosis.
  const peakDbfs = peakRawVal > 0 ? 20 * Math.log10(peakRawVal) : -Infinity;
  let maxAbsDelta = 0;
  let maxDeltaIndex = 0;
  for (let i = 1; i < totalSamples; i++) {
    const delta = Math.abs(outBuffer[i] - outBuffer[i - 1]);
    if (delta > maxAbsDelta) {
      maxAbsDelta = delta;
      maxDeltaIndex = i;
    }
  }
  const maxDeltaTimeSec = maxDeltaIndex / config.sampleRateHz;
  const rtf = (elapsedMs / 1000) / Math.max(1e-9, durationSec);
  const determinismHash = 'sha256:' + createHash('sha256').update(Buffer.from(outBuffer.buffer)).digest('hex');

  const wav = new WaveFile();
  wav.fromScratch(1, config.sampleRateHz, '32f', outBuffer);
  await writeFile(resolve(outWav), wav.toBuffer());

  if (json) {
    // Stable schema — document in CHANGELOG when fields change.
    const out = {
      outWav: resolve(outWav),
      durationSec: Number(durationSec.toFixed(6)),
      peakDbfs: Number.isFinite(peakDbfs) ? Number(peakDbfs.toFixed(2)) : null,
      maxAbsDelta: Number(maxAbsDelta.toFixed(6)),
      maxDeltaTimeSec: Number(maxDeltaTimeSec.toFixed(6)),
      elapsedMs: Number(elapsedMs.toFixed(2)),
      rtf: Number(rtf.toFixed(4)),
      determinismHash,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else {
    console.log(`Rendered score to ${outWav}`);
    console.log(`  Duration:    ${durationSec.toFixed(3)} s`);
    console.log(`  Peak dBFS:   ${Number.isFinite(peakDbfs) ? peakDbfs.toFixed(2) : '-inf'}`);
    console.log(`  Max delta:   ${maxAbsDelta.toFixed(6)} at t=${maxDeltaTimeSec.toFixed(4)}s`);
    console.log(`  Elapsed:     ${elapsedMs.toFixed(0)} ms  (RTF ${rtf.toFixed(4)})`);
    console.log(`  Determinism: ${determinismHash}`);
  }
}

runCli('play-score', main);
