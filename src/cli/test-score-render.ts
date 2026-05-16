import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadVoicePreset } from '../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../engine/StreamingVocalSynthEngine.js';
import { VocalScore } from '../types/score.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx src/cli/test-score-render.ts <preset.json> <score.json>');
    process.exit(1);
  }

  const [presetPath, scorePath] = args;
  
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
  
  let maxTimeSec = 0;
  for (const note of score.notes) {
    const endSec = note.startSec + note.durationSec + 0.2;
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
  
  // Click Detector: max absolute derivative spike
  let maxAbsDelta = 0;
  let maxDeltaIndex = 0;
  for (let i = 1; i < totalSamples; i++) {
    const delta = Math.abs(outBuffer[i] - outBuffer[i - 1]);
    if (delta > maxAbsDelta) {
      maxAbsDelta = delta;
      maxDeltaIndex = i;
    }
  }
  
  // Determinism Hash
  const hash = createHash('sha256');
  hash.update(Buffer.from(outBuffer.buffer));
  const determinismHash = hash.digest('hex');
  
  console.log(`=== Golden Test Results ===`);
  console.log(`Max Abs Delta (Click Detector): ${maxAbsDelta.toFixed(6)} at sample ${maxDeltaIndex} (t=${(maxDeltaIndex/config.sampleRateHz).toFixed(3)}s)`);
  console.log(`Determinism Hash: sha256:${determinismHash}`);
  
  // Assertions
  const CLICK_THRESHOLD = 0.25; // Normalized signal shouldn't jump more than 25% per sample
  if (maxAbsDelta > CLICK_THRESHOLD) {
    console.error(`FAIL: Click detected! Max delta ${maxAbsDelta.toFixed(6)} > ${CLICK_THRESHOLD}`);
    process.exit(1);
  } else {
    console.log(`PASS: No clicks detected.`);
  }
  
  console.log(`PASS: Golden render stable.`);
}

main().catch(console.error);
