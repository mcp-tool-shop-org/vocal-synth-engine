/**
 * jamExport.ts — Offline re-render from EventTape → WAV.
 *
 * Takes a self-contained EventTape (recorded during a jam session) and
 * produces a deterministic WAV file by replaying all events through
 * fresh LiveSynthEngine instances.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { LiveSynthEngine } from '../../engine/LiveSynthEngine.js';
import type { LiveEngineConfig } from '../../engine/LiveSynthEngine.js';
import { loadVoicePreset } from '../../preset/loader.js';
import { resolvePresetPath } from './renderScoreToWav.js';
import type { EventTape } from '../../types/jam.js';

const RELEASE_TAIL_SEC = 2;  // extra render time after last event

export interface ExportResult {
  wavBytes: Buffer;
  durationSec: number;
  telemetry: {
    peakDbfs: number;
    blocksRendered: number;
    renderTimeMs: number;
    rtf: number;
  };
  provenance: {
    commit: string;
    scoreHash: string;
    wavHash: string;
    eventCount: number;
  };
  eventTapeJson: string;
}

function getGitCommit(): string {
  try { return execSync('git rev-parse HEAD').toString().trim(); } catch { return 'unknown'; }
}

/**
 * Offline re-render: replay EventTape through fresh engines → WAV.
 */
export async function exportEventTapeToWav(tape: EventTape): Promise<ExportResult> {
  const startMs = performance.now();
  const { sampleRateHz, blockSize, seed, events } = tape;

  // ── Load presets + create engines ──────────────────────────────
  const engines = new Map<string, { engine: LiveSynthEngine; gain: number }>();

  for (const track of tape.tracks) {
    const manifestPath = resolvePresetPath(track.presetId);
    const preset = await loadVoicePreset(manifestPath);
    const timbres = Object.keys(preset.timbres);

    const config: LiveEngineConfig = {
      sampleRateHz,
      blockSize,
      maxPolyphony: 4,
      defaultTimbre: timbres[0] || 'AH',
      rngSeed: seed,
    };

    const engine = new LiveSynthEngine(config, preset);
    engine.setLimiter(false);  // master limiter handles clipping
    engine.play();

    engines.set(track.trackId, { engine, gain: track.gain });
  }

  // ── Determine total render length ──────────────────────────────
  const lastEventSample = events.length > 0
    ? events[events.length - 1].tSample
    : 0;
  const totalSamples = lastEventSample + Math.ceil(RELEASE_TAIL_SEC * sampleRateHz);
  const totalBlocks = Math.ceil(totalSamples / blockSize);

  // ── Sort events by tSample (should already be sorted, but ensure) ──
  const sortedEvents = [...events].sort((a, b) => a.tSample - b.tSample);

  // ── Offline render loop ────────────────────────────────────────
  const output = new Float32Array(totalBlocks * blockSize);
  const mixBuf = new Float32Array(blockSize);
  let eventCursor = 0;

  for (let block = 0; block < totalBlocks; block++) {
    const blockStart = block * blockSize;
    const blockEnd = blockStart + blockSize;

    // Fire events that fall within this block
    while (eventCursor < sortedEvents.length && sortedEvents[eventCursor].tSample < blockEnd) {
      const entry = sortedEvents[eventCursor];
      const trackEngine = engines.get(entry.trackId);

      if (trackEngine) {
        if (entry.event === 'note_on') {
          trackEngine.engine.noteOn({
            noteId: entry.payload.noteId,
            midi: entry.payload.midi,
            velocity: entry.payload.velocity,
            timbre: entry.payload.timbre,
            breathiness: entry.payload.breathiness,
            vibrato: entry.payload.vibrato,
            portamentoMs: entry.payload.portamentoMs,
          });
        } else if (entry.event === 'note_off') {
          trackEngine.engine.noteOff(entry.payload.noteId, entry.payload.releaseMs);
        }
      }

      eventCursor++;
    }

    // Render + mix all tracks
    mixBuf.fill(0);
    for (const [, { engine, gain }] of engines) {
      const trackBlock = engine.render();
      for (let i = 0; i < blockSize; i++) {
        mixBuf[i] += trackBlock[i] * gain;
      }
    }

    // Master limiter (tanh soft clip)
    for (let i = 0; i < blockSize; i++) {
      mixBuf[i] = Math.tanh(mixBuf[i]);
    }

    output.set(mixBuf, blockStart);
  }

  // ── Peak normalize ─────────────────────────────────────────────
  let peak = 0;
  for (let i = 0; i < output.length; i++) {
    const abs = Math.abs(output[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0 && peak !== 1.0) {
    const scale = 1.0 / peak;
    for (let i = 0; i < output.length; i++) {
      output[i] *= scale;
    }
  }

  const peakDbfs = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

  // ── Encode WAV ─────────────────────────────────────────────────
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, '32f', output);
  const wavBytes = Buffer.from(wav.toBuffer());

  // ── Hashes + provenance ────────────────────────────────────────
  const eventTapeJson = JSON.stringify(tape);
  const scoreHash = createHash('sha256').update(eventTapeJson).digest('hex').slice(0, 8);
  const wavHash = createHash('sha256').update(wavBytes).digest('hex').slice(0, 8);

  const renderTimeMs = performance.now() - startMs;
  const durationSec = (totalBlocks * blockSize) / sampleRateHz;

  return {
    wavBytes,
    durationSec,
    telemetry: {
      peakDbfs,
      blocksRendered: totalBlocks,
      renderTimeMs,
      rtf: durationSec / (renderTimeMs / 1000),
    },
    provenance: {
      commit: getGitCommit(),
      scoreHash,
      wavHash,
      eventCount: events.length,
    },
    eventTapeJson,
  };
}
