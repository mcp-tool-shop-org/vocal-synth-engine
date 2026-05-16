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
import { loadVoicePreset } from '../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../engine/StreamingVocalSynthEngine.js';
import { VocalScore, parseVocalScore } from '../types/score.js';

const USAGE = `Usage: npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav>

Renders a score (notes[]) through a voice preset using the streaming engine
in deterministic 'exact' mode (rngSeed=123456789, blockSize=1024,
maxPolyphony=4) and writes the normalized result to <out.wav>.

Options:
  -h, --help    Show this message and exit.`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.length < 3) {
    console.error(USAGE);
    process.exit(1);
  }

  const [presetPath, scorePath, outWav] = args;
  
  const preset = await loadVoicePreset(resolve(presetPath));
  const scoreContent = await readFile(resolve(scorePath), 'utf-8');
  // T-009: validate score JSON shape (notes[]/bpm/MIDI ranges/finite durations)
  // before handing to the synth engine. JSON.parse-and-pray silently propagated
  // NaN/Infinity into render() and produced NaN audio.
  let score: VocalScore;
  try {
    score = parseVocalScore(scoreContent) as VocalScore;
  } catch (err: any) {
    console.error(`Invalid score JSON at ${scorePath}:`);
    console.error(err.message);
    process.exit(1);
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
  
  let offset = 0;
  while (offset < totalSamples) {
    const blockSamples = Math.min(config.blockSize, totalSamples - offset);
    const block = engine.render(blockSamples);
    outBuffer.set(block, offset);
    offset += blockSamples;
  }
  
  // Normalize
  let maxVal = 0;
  for (let i = 0; i < totalSamples; i++) {
    if (Math.abs(outBuffer[i]) > maxVal) maxVal = Math.abs(outBuffer[i]);
  }
  if (maxVal > 0) {
    for (let i = 0; i < totalSamples; i++) outBuffer[i] /= maxVal;
  }
  
  const wav = new WaveFile();
  wav.fromScratch(1, config.sampleRateHz, '32f', outBuffer);
  await writeFile(resolve(outWav), wav.toBuffer());
  
  console.log(`Rendered score to ${outWav}`);
}

main().catch(console.error);
