import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { loadVoicePreset } from '../../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../../engine/StreamingVocalSynthEngine.js';
import { resolve } from 'node:path';

const PRESET_PATH = resolve(process.env.PRESET_PATH || 'test-preset/voicepreset.json');
let presetCache: any = null;

async function getPreset() {
  if (!presetCache) presetCache = await loadVoicePreset(PRESET_PATH);
  return presetCache;
}

function getGitCommit() {
  try { return execSync('git rev-parse HEAD').toString().trim(); } catch (e) { return 'unknown'; }
}

export async function renderScoreToWav({ score, config }: { score: any; config: any }) {
  const preset = await getPreset();
  const synthConfig: StreamingVocalSynthConfig = {
    sampleRateHz: preset.manifest.sampleRateHz,
    blockSize: config.blockSize || 1024,
    presetPath: PRESET_PATH,
    deterministic: config.deterministic || "exact",
    rngSeed: config.rngSeed !== undefined ? config.rngSeed : 123456789,
    defaultTimbre: config.defaultTimbre || Object.keys(preset.timbres)[0],
    maxPolyphony: config.maxPolyphony || 4
  };

  const engine = new StreamingVocalSynthEngine(synthConfig, preset, score);

  let maxEndSec = 0;
  const events: { time: number; type: 'start' | 'end' }[] = [];
  for (const note of score.notes || []) {
    const endSec = note.startSec + note.durationSec;
    if (endSec > maxEndSec) maxEndSec = endSec;
    events.push({ time: note.startSec, type: 'start' });
    events.push({ time: endSec, type: 'end' });
  }

  events.sort((a, b) => a.time === b.time ? (a.type === 'end' ? -1 : 1) : a.time - b.time);
  let currentVoices = 0;
  let voicesMax = 0;
  for (const ev of events) {
    if (ev.type === 'start') currentVoices++;
    else currentVoices--;
    if (currentVoices > voicesMax) voicesMax = currentVoices;
  }

  const tailSec = 0.3;
  const maxTimeSec = maxEndSec + tailSec;

  const totalSamples = Math.ceil((maxTimeSec * synthConfig.sampleRateHz) / synthConfig.blockSize) * synthConfig.blockSize;
  const actualDurationSec = totalSamples / synthConfig.sampleRateHz;

  const outBuffer = new Float32Array(totalSamples);
  const startTime = performance.now();

  let offset = 0;
  let blocksRendered = 0;
  while (offset < totalSamples) {
    const blockSamples = Math.min(synthConfig.blockSize, totalSamples - offset);
    const block = engine.render(blockSamples);
    outBuffer.set(block, offset);
    offset += blockSamples;
    blocksRendered++;
  }

  const renderTimeMs = performance.now() - startTime;
  const rtf = actualDurationSec > 0 ? (renderTimeMs / 1000) / actualDurationSec : 0;

  let maxVal = 0;
  for (let i = 0; i < totalSamples; i++) {
    if (Math.abs(outBuffer[i]) > maxVal) maxVal = Math.abs(outBuffer[i]);
  }
  const peakDbfs = maxVal > 0 ? 20 * Math.log10(maxVal) : -Infinity;
  
  if (maxVal > 0) {
    for (let i = 0; i < totalSamples; i++) outBuffer[i] /= maxVal;
  }

  let maxAbsDelta = 0;
  let maxDeltaIndex = 0;
  for (let i = 1; i < totalSamples; i++) {
    const delta = Math.abs(outBuffer[i] - outBuffer[i - 1]);
    if (delta > maxAbsDelta) {
      maxAbsDelta = delta;
      maxDeltaIndex = i;
    }
  }

  const wav = new WaveFile();
  wav.fromScratch(1, synthConfig.sampleRateHz, '32f', outBuffer);
  const wavBuffer = wav.toBuffer();

  const commit = getGitCommit();
  const scoreHash = createHash('sha256').update(JSON.stringify(score)).digest('hex');
  const wavHash = createHash('sha256').update(wavBuffer).digest('hex');

  const provenance = { commit, scoreHash, wavHash, config: synthConfig };
  const telemetry = {
    maxAbsDelta, maxDeltaIndex, maxDeltaTimeSec: maxDeltaIndex / synthConfig.sampleRateHz,
    totalSamples, blocksRendered, durationSec: actualDurationSec, scoreDurationSec: maxEndSec,
    notesEndSec: maxEndSec,
    tailSec, renderTimeMs, rtf,
    peakDbfs, voicesMax
  };

  return {
    wavBytes: Buffer.from(wavBuffer),
    telemetry,
    provenance,
    durationSec: actualDurationSec
  };
}
