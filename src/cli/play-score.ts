import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadVoicePreset } from '../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../engine/StreamingVocalSynthEngine.js';
import { VocalScore } from '../types/score.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav>');
    process.exit(1);
  }

  const [presetPath, scorePath, outWav] = args;
  
  const preset = await loadVoicePreset(resolve(presetPath));
  const scoreContent = await readFile(resolve(scorePath), 'utf-8');
  const score: VocalScore = JSON.parse(scoreContent);
  
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
