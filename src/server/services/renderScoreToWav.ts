import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { loadVoicePreset } from '../../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../../engine/StreamingVocalSynthEngine.js';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// --- Preset directory discovery ---
const PRESET_DIR = resolve(process.env.PRESET_DIR || 'presets');
const presetCache: Map<string, any> = new Map();

/**
 * Resolve a preset ID to its manifest path.
 * Looks for <PRESET_DIR>/<presetId>/voicepreset.json
 */
function resolvePresetPath(presetId: string): string {
  const manifestPath = join(PRESET_DIR, presetId, 'voicepreset.json');
  if (!existsSync(manifestPath)) {
    const available = listPresetIds();
    const err: any = new Error(
      `Preset '${presetId}' not found. Available presets: [${available.join(', ')}]`
    );
    err.code = 'PRESET_NOT_FOUND';
    err.presetId = presetId;
    err.presetDir = PRESET_DIR;
    err.available = available;
    throw err;
  }
  return manifestPath;
}

/**
 * List all valid preset IDs found in PRESET_DIR.
 */
export function listPresetIds(): string[] {
  if (!existsSync(PRESET_DIR)) return [];
  return readdirSync(PRESET_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(PRESET_DIR, d.name, 'voicepreset.json')))
    .map(d => d.name);
}

/**
 * Get full preset metadata for the /api/presets endpoint.
 */
export function listPresets() {
  const ids = listPresetIds();
  return ids.map(id => {
    try {
      const manifestPath = join(PRESET_DIR, id, 'voicepreset.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return {
        id,
        name: manifest.id || id,
        sampleRateHz: manifest.sampleRateHz,
        timbres: (manifest.timbres || []).map((t: any) => t.name),
        version: manifest.version,
      };
    } catch {
      return { id, name: id, error: 'Failed to read manifest' };
    }
  });
}

async function getPreset(presetId: string) {
  if (!presetCache.has(presetId)) {
    const manifestPath = resolvePresetPath(presetId);
    presetCache.set(presetId, await loadVoicePreset(manifestPath));
  }
  return presetCache.get(presetId)!;
}

function getGitCommit() {
  try { return execSync('git rev-parse HEAD').toString().trim(); } catch (e) { return 'unknown'; }
}

/** Return PRESET_DIR and count for boot logging */
export function getPresetDirInfo() {
  return { presetDir: PRESET_DIR, count: listPresetIds().length, presets: listPresetIds() };
}

export async function renderScoreToWav({ score, config }: { score: any; config: any }) {
  // Resolve preset — accept presetId or fall back to "default-voice"
  const presetId = config.presetId || 'default-voice';
  const preset = await getPreset(presetId);
  const presetPath = resolvePresetPath(presetId);

  const synthConfig: StreamingVocalSynthConfig = {
    sampleRateHz: preset.manifest.sampleRateHz,
    blockSize: config.blockSize || 1024,
    presetPath,
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

  const provenance = { commit, scoreHash, wavHash, config: synthConfig, presetId };
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
