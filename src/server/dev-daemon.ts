import express from 'express';
import cors from 'cors';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;

import { loadVoicePreset } from '../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../engine/StreamingVocalSynthEngine.js';
import { VocalScore } from '../types/score.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const PRESET_PATH = resolve(process.env.PRESET_PATH || 'test-preset/voicepreset.json');

let presetCache: any = null;

async function getPreset() {
  if (!presetCache) {
    presetCache = await loadVoicePreset(PRESET_PATH);
  }
  return presetCache;
}

function getGitCommit() {
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch (e) {
    return 'unknown';
  }
}

app.get('/api/health', async (req, res) => {
  const preset = await getPreset();
  res.json({
    status: 'ok',
    commit: getGitCommit(),
    engineVersion: '1.0.0',
    sampleRateHz: preset.manifest.sampleRateHz,
    blockSize: 1024,
    presetPath: PRESET_PATH
  });
});

app.post('/api/render', async (req, res) => {
  try {
    const score: VocalScore = req.body.score;
    if (!score || !score.notes) {
      return res.status(400).json({ error: 'Invalid score' });
    }

    const preset = await getPreset();
    
    const config: StreamingVocalSynthConfig = {
      sampleRateHz: preset.manifest.sampleRateHz,
      blockSize: 1024,
      presetPath: PRESET_PATH,
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
    
    // Click Detector
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
    wav.fromScratch(1, config.sampleRateHz, '32f', outBuffer);
    const wavBuffer = wav.toBuffer();
    
    const scoreHash = createHash('sha256').update(JSON.stringify(score)).digest('hex');
    const wavHash = createHash('sha256').update(wavBuffer).digest('hex');
    
    const provenance = {
      commit: getGitCommit(),
      scoreHash,
      wavHash,
      config
    };
    
    const telemetry = {
      maxAbsDelta,
      maxDeltaIndex,
      maxDeltaTimeSec: maxDeltaIndex / config.sampleRateHz,
      totalSamples,
      durationSec: maxTimeSec
    };
    
    res.json({
      wavBase64: Buffer.from(wavBuffer).toString('base64'),
      provenance,
      telemetry
    });
    
  } catch (err: any) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`VocalSynth Daemon running on http://localhost:${PORT}`);
  console.log(`Using preset: ${PRESET_PATH}`);
});
