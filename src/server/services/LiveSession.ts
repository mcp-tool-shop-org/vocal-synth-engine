/**
 * LiveSession — one per WebSocket connection.
 *
 * Owns: preset, LiveSynthEngine, recording buffer, telemetry ticker.
 * Receives parsed ClientMessages, sends ServerMessages via callback.
 */

import type { WebSocket } from 'ws';
import { loadVoicePreset } from '../../preset/loader.js';
import { LoadedVoicePreset } from '../../preset/schema.js';
import { LiveSynthEngine, LiveEngineConfig } from '../../engine/LiveSynthEngine.js';
import { resolvePresetPath } from './renderScoreToWav.js';
import {
  LIVE_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type HelloAckMessage,
  type ErrorMessage,
  type TelemetryMessage,
  type TransportAckMessage,
  type NoteAckMessage,
  type RecordStatusMessage,
  type RecordSavedMessage,
  type PongMessage,
} from '../../types/live.js';
import { saveRender } from '../storage/renderStore.js';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;

export interface LiveSessionConfig {
  presetId: string;
  maxPolyphony: number;
  blockSize: number;
  rngSeed: number;
  defaultTimbre?: string;
}

const DEFAULT_SESSION_CONFIG: LiveSessionConfig = {
  presetId: 'default-voice',
  maxPolyphony: 4,
  blockSize: 1024,
  rngSeed: 123456789,
};

/**
 * Binary audio frame layout (16-byte header + PCM payload):
 *
 *   Offset  Type     Field
 *   ──────  ───────  ─────────────
 *   0       uint32   seq            (frame sequence number, LE)
 *   4       uint16   channels       (1 = mono)
 *   6       uint16   (reserved)
 *   8       uint32   sampleRate     (Hz, LE)
 *   12      uint32   blockSize      (samples per channel, LE)
 *   16..    float32  PCM samples    (blockSize × channels × 4 bytes)
 */
const AUDIO_HEADER_SIZE = 16;
const MAX_RECORD_SEC = 60;          // cap recording at 60 seconds
const MAX_MSGS_PER_SEC = 200;       // WS message rate limit per session
const MAX_SEND_QUEUE_BYTES = 4 * 1024 * 1024; // 4 MB — skip audio frames if client is backed up

function getGitCommit(): string {
  try { return execSync('git rev-parse HEAD').toString().trim(); } catch { return 'unknown'; }
}

export class LiveSession {
  private ws: WebSocket;
  private engine: LiveSynthEngine | null = null;
  private preset: LoadedVoicePreset | null = null;
  private config: LiveSessionConfig;
  private createdAt: number = Date.now();
  private telemetryInterval: ReturnType<typeof setInterval> | null = null;
  private renderLoopInterval: ReturnType<typeof setInterval> | null = null;

  // Audio frame state
  private audioSeq: number = 0;
  private audioFrameBuf: Buffer | null = null;

  // Recording state
  private recording: boolean = false;
  private recordBuffer: Float32Array[] = [];
  private recordStartSample: number = 0;

  // Rate limiter (sliding window)
  private msgTimestamps: number[] = [];
  private rateLimitWarned: boolean = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.config = { ...DEFAULT_SESSION_CONFIG };
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Initialize engine + preset, send hello_ack. Called on 'hello'. */
  async init(protocolVersion: number): Promise<void> {
    if (protocolVersion !== LIVE_PROTOCOL_VERSION) {
      this.sendError('PROTOCOL_MISMATCH',
        `Server speaks protocol v${LIVE_PROTOCOL_VERSION}, client sent v${protocolVersion}`);
      return;
    }

    try {
      await this.loadPresetAndCreateEngine();
    } catch (err: any) {
      this.sendError('INIT_FAILED', err.message);
      return;
    }

    const timbres = Object.keys(this.preset!.timbres);
    const ack: HelloAckMessage = {
      type: 'hello_ack',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      presetId: this.config.presetId,
      timbres,
      sampleRateHz: this.engine!.sampleRateHz,
      maxPolyphony: this.engine!.maxPolyphony,
      blockSize: this.engine!.blockSize,
    };
    this.send(ack);

    // Start telemetry ticker (15 Hz)
    this.startTelemetry();
  }

  /** Clean up timers and buffers on disconnect. */
  destroy() {
    this.stopRenderLoop();
    this.stopTelemetry();
    this.engine = null;
    this.preset = null;
    this.recordBuffer = [];
    this.audioFrameBuf = null;
    this.msgTimestamps = [];
  }

  // ── Message dispatch ─────────────────────────────────────────

  /** Handle a parsed client message. */
  async handleMessage(msg: ClientMessage): Promise<void> {
    // Rate limit: sliding 1-second window
    const now = Date.now();
    this.msgTimestamps.push(now);
    // Trim timestamps older than 1 second
    while (this.msgTimestamps.length > 0 && this.msgTimestamps[0] < now - 1000) {
      this.msgTimestamps.shift();
    }
    if (this.msgTimestamps.length > MAX_MSGS_PER_SEC) {
      if (!this.rateLimitWarned) {
        this.rateLimitWarned = true;
        this.sendError('RATE_LIMITED', `Too many messages (>${MAX_MSGS_PER_SEC}/sec). Slow down.`);
        console.warn(`[live] Rate limited session (${this.msgTimestamps.length} msgs in 1s)`);
      }
      return;
    }
    this.rateLimitWarned = false;

    switch (msg.type) {
      case 'hello':
        await this.init(msg.protocolVersion);
        break;

      case 'transport':
        this.handleTransport(msg.command, msg.bpm);
        break;

      case 'note_on':
        this.handleNoteOn(msg);
        break;

      case 'note_off':
        this.handleNoteOff(msg.noteId, msg.releaseMs);
        break;

      case 'param_update':
        await this.handleParamUpdate(msg);
        break;

      case 'record_start':
        this.handleRecordStart();
        break;

      case 'record_stop':
        this.handleRecordStop(msg.name);
        break;

      case 'timbre_morph':
        if (this.engine) {
          this.engine.setTimbreWeights(msg.weights);
        }
        break;

      case 'ping':
        this.send({
          type: 'pong',
          clientTimestamp: msg.clientTimestamp,
          serverTimestamp: Date.now(),
        } as PongMessage);
        break;

      default:
        this.sendError('UNKNOWN_MESSAGE', `Unknown message type: ${(msg as any).type}`);
    }
  }

  // ── Transport ────────────────────────────────────────────────

  private handleTransport(command: string, bpm?: number) {
    if (!this.engine) {
      this.sendError('NOT_INITIALIZED', 'Send hello first');
      return;
    }

    switch (command) {
      case 'play':
        this.engine.play();
        this.startRenderLoop();
        this.send({ type: 'transport_ack', state: 'playing' } as TransportAckMessage);
        break;

      case 'stop':
        this.stopRenderLoop();
        this.engine.stop();
        if (this.recording) this.handleRecordStop();
        this.send({ type: 'transport_ack', state: 'stopped' } as TransportAckMessage);
        break;

      case 'panic':
        this.engine.panic();
        this.send({ type: 'transport_ack', state: this.engine.isPlaying ? 'playing' : 'stopped' } as TransportAckMessage);
        break;

      default:
        this.sendError('INVALID_COMMAND', `Unknown transport command: ${command}`);
    }
  }

  // ── Note events ──────────────────────────────────────────────

  private handleNoteOn(msg: {
    noteId: string;
    midi: number;
    velocity: number;
    timbre?: string;
    breathiness?: number;
    vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
    portamentoMs?: number;
  }) {
    if (!this.engine) {
      this.sendError('NOT_INITIALIZED', 'Send hello first');
      return;
    }

    // Auto-play on first note if stopped
    if (!this.engine.isPlaying) {
      this.engine.play();
      this.startRenderLoop();
    }

    const { voiceIndex, stolen } = this.engine.noteOn({
      noteId: msg.noteId,
      midi: msg.midi,
      velocity: msg.velocity,
      timbre: msg.timbre,
      breathiness: msg.breathiness,
      vibrato: msg.vibrato,
      portamentoMs: msg.portamentoMs,
    });

    const ack: NoteAckMessage = {
      type: 'note_ack',
      noteId: msg.noteId,
      voiceIndex,
      stolen,
    };
    this.send(ack);
  }

  private handleNoteOff(noteId: string, releaseMs?: number) {
    if (!this.engine) return;
    this.engine.noteOff(noteId, releaseMs);
  }

  // ── Param updates ────────────────────────────────────────────

  private async handleParamUpdate(msg: {
    maxPolyphony?: number;
    rngSeed?: number;
    defaultTimbre?: string;
    presetId?: string;
    blockSize?: number;
  }) {
    if (!this.engine) {
      this.sendError('NOT_INITIALIZED', 'Send hello first');
      return;
    }

    // Preset change requires full reload
    if (msg.presetId && msg.presetId !== this.config.presetId) {
      this.config.presetId = msg.presetId;
      try {
        await this.loadPresetAndCreateEngine();
        // Re-send hello_ack with new preset info
        const timbres = Object.keys(this.preset!.timbres);
        this.send({
          type: 'hello_ack',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          presetId: this.config.presetId,
          timbres,
          sampleRateHz: this.engine!.sampleRateHz,
          maxPolyphony: this.engine!.maxPolyphony,
          blockSize: this.engine!.blockSize,
        } as HelloAckMessage);
      } catch (err: any) {
        this.sendError('PRESET_LOAD_FAILED', err.message);
      }
      return;
    }

    // In-place config updates
    const updates: Partial<LiveEngineConfig> = {};
    if (msg.maxPolyphony !== undefined) {
      updates.maxPolyphony = msg.maxPolyphony;
      this.config.maxPolyphony = msg.maxPolyphony;
    }
    if (msg.rngSeed !== undefined) {
      updates.rngSeed = msg.rngSeed;
      this.config.rngSeed = msg.rngSeed;
    }
    if (msg.defaultTimbre !== undefined) {
      updates.defaultTimbre = msg.defaultTimbre;
    }
    this.engine.updateConfig(updates);
  }

  // ── Recording ────────────────────────────────────────────────

  private handleRecordStart() {
    if (!this.engine) {
      this.sendError('NOT_INITIALIZED', 'Send hello first');
      return;
    }
    this.recording = true;
    this.recordBuffer = [];
    this.recordStartSample = 0; // will be set on first render
    this.send({
      type: 'record_status',
      recording: true,
      durationSec: 0,
      samplesRecorded: 0,
    } as RecordStatusMessage);
  }

  private handleRecordStop(name?: string) {
    if (!this.recording) return;
    this.recording = false;

    const totalSamples = this.recordBuffer.reduce((sum, b) => sum + b.length, 0);
    const sampleRate = this.engine?.sampleRateHz ?? 48000;
    const durationSec = totalSamples / sampleRate;

    this.send({
      type: 'record_status',
      recording: false,
      durationSec,
      samplesRecorded: totalSamples,
    } as RecordStatusMessage);

    // Save recording to render bank
    const audio = this.getRecordedAudio();
    if (!audio || audio.length === 0) {
      console.log('[live] Recording stopped with no audio');
      this.recordBuffer = [];
      return;
    }

    // Normalize to peak = 1.0
    let peak = 0;
    for (let i = 0; i < audio.length; i++) {
      const abs = Math.abs(audio[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0 && peak < 1) {
      const gain = 1 / peak;
      for (let i = 0; i < audio.length; i++) audio[i] *= gain;
    }

    // Compute click delta
    let maxAbsDelta = 0;
    for (let i = 1; i < audio.length; i++) {
      const d = Math.abs(audio[i] - audio[i - 1]);
      if (d > maxAbsDelta) maxAbsDelta = d;
    }

    const peakDbfs = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

    // Encode WAV
    const wav = new WaveFile();
    wav.fromScratch(1, sampleRate, '32f', audio);
    const wavBuffer = Buffer.from(wav.toBuffer());

    const commit = getGitCommit();
    const finalName = name?.trim() || `Live Take ${new Date().toLocaleTimeString('en-US', { hour12: false })}`;

    const config = {
      presetId: this.config.presetId,
      maxPolyphony: this.config.maxPolyphony,
      blockSize: this.config.blockSize,
      rngSeed: this.config.rngSeed,
      sampleRateHz: sampleRate,
      mode: 'live',
    };

    const scoreHash = createHash('sha256').update(JSON.stringify({ live: true })).digest('hex');
    const wavHash = createHash('sha256').update(wavBuffer).digest('hex');

    const provenance = {
      commit,
      scoreHash,
      wavHash,
      config,
      presetId: this.config.presetId,
    };

    const telemetry = {
      maxAbsDelta,
      peakDbfs,
      durationSec,
      renderTimeMs: 0,
      rtf: 0,
      voicesMax: this.config.maxPolyphony,
      mode: 'live',
    };

    try {
      const meta = saveRender({
        name: finalName,
        score: { live: true, durationSec },
        config,
        telemetry,
        provenance,
        wavBytes: wavBuffer,
        durationSec,
      });

      console.log(`[live] Recording saved: "${meta.name}" (${durationSec.toFixed(2)}s) → ${meta.id}`);

      this.send({
        type: 'record_saved',
        renderId: meta.id,
        name: meta.name,
        durationSec,
      } as RecordSavedMessage);
    } catch (err: any) {
      console.error('[live] Failed to save recording:', err);
      this.sendError('RECORD_SAVE_FAILED', err.message);
    }

    this.recordBuffer = [];
  }

  /** Called by the render loop to capture audio if recording. */
  captureBlock(block: Float32Array) {
    if (!this.recording) return;

    const sampleRate = this.engine?.sampleRateHz ?? 48000;
    const currentSamples = this.recordBuffer.reduce((sum, b) => sum + b.length, 0);
    if (currentSamples / sampleRate >= MAX_RECORD_SEC) {
      // Auto-stop at cap
      this.handleRecordStop();
      return;
    }

    this.recordBuffer.push(new Float32Array(block)); // copy
  }

  /** Get recorded audio as a single contiguous buffer. */
  getRecordedAudio(): Float32Array | null {
    if (this.recordBuffer.length === 0) return null;
    const totalLen = this.recordBuffer.reduce((sum, b) => sum + b.length, 0);
    const out = new Float32Array(totalLen);
    let offset = 0;
    for (const block of this.recordBuffer) {
      out.set(block, offset);
      offset += block.length;
    }
    return out;
  }

  // ── Render loop ─────────────────────────────────────────────

  /** Start the server-side render loop. Ticks at block rate, sends binary PCM. */
  private startRenderLoop() {
    this.stopRenderLoop();
    if (!this.engine) return;

    const blockSize = this.engine.blockSize;
    const sampleRate = this.engine.sampleRateHz;
    const channels = 1; // mono
    const blockMs = (blockSize / sampleRate) * 1000;

    // Pre-allocate the binary frame buffer (header + PCM payload)
    this.audioSeq = 0;
    this.audioFrameBuf = Buffer.alloc(AUDIO_HEADER_SIZE + blockSize * 4);
    // Write static header fields once
    this.audioFrameBuf.writeUInt16LE(channels, 4);
    this.audioFrameBuf.writeUInt16LE(0, 6);          // reserved
    this.audioFrameBuf.writeUInt32LE(sampleRate, 8);
    this.audioFrameBuf.writeUInt32LE(blockSize, 12);

    this.renderLoopInterval = setInterval(() => {
      if (!this.engine || !this.engine.isPlaying) return;

      const block = this.engine.render();
      this.captureBlock(block);

      if (this.ws.readyState === 1 /* OPEN */) {
        // Backpressure: skip frame if send queue is backed up
        if (this.ws.bufferedAmount > MAX_SEND_QUEUE_BYTES) {
          this.audioSeq++; // still advance seq so client detects gap
          return;
        }
        const frame = this.audioFrameBuf!;
        frame.writeUInt32LE(this.audioSeq++, 0);
        Buffer.from(block.buffer, block.byteOffset, block.byteLength).copy(frame, AUDIO_HEADER_SIZE);
        this.ws.send(frame);
      }
    }, blockMs);
  }

  /** Stop the render loop. */
  private stopRenderLoop() {
    if (this.renderLoopInterval) {
      clearInterval(this.renderLoopInterval);
      this.renderLoopInterval = null;
    }
  }

  /** Render one block on demand (for testing). Returns audio samples. */
  renderBlock(): Float32Array | null {
    if (!this.engine) return null;
    const block = this.engine.render();
    this.captureBlock(block);
    return block;
  }

  // ── Telemetry ────────────────────────────────────────────────

  private startTelemetry() {
    this.stopTelemetry();
    // 15 Hz telemetry = every ~67ms
    this.telemetryInterval = setInterval(() => {
      if (!this.engine) return;

      const t = this.engine.getTelemetryAndReset();
      const recordingSec = this.recording
        ? this.recordBuffer.reduce((sum, b) => sum + b.length, 0) / this.engine.sampleRateHz
        : null;

      const msg: TelemetryMessage = {
        type: 'telemetry',
        voicesActive: t.voicesActive,
        voicesMax: t.voicesMax,
        peakDbfs: t.peakDbfs,
        clickDeltaMaxRecent: t.clickDeltaMaxRecent,
        rtf: t.rtf,
        recordingSec,
        uptimeSec: (Date.now() - this.createdAt) / 1000,
      };
      this.send(msg);
    }, 67);
  }

  private stopTelemetry() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async loadPresetAndCreateEngine() {
    const manifestPath = resolvePresetPath(this.config.presetId);
    this.preset = await loadVoicePreset(manifestPath);

    const timbres = Object.keys(this.preset.timbres);
    const defaultTimbre = this.config.defaultTimbre || timbres[0] || 'AH';

    const engineConfig: LiveEngineConfig = {
      sampleRateHz: this.preset.manifest.sampleRateHz,
      blockSize: this.config.blockSize,
      maxPolyphony: this.config.maxPolyphony,
      defaultTimbre,
      rngSeed: this.config.rngSeed,
    };

    this.engine = new LiveSynthEngine(engineConfig, this.preset);
  }

  private send(msg: ServerMessage) {
    if (this.ws.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendError(code: string, message: string) {
    this.send({ type: 'error', code, message } as ErrorMessage);
  }
}
