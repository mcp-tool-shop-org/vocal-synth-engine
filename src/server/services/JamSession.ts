/**
 * JamSession — multi-participant jam session with per-track engines.
 *
 * Owns: transport clock, track registry, render loop, mixer, broadcast.
 * Each Track has its own LiveSynthEngine instance for isolation.
 */

import type { WebSocket } from 'ws';
import { LiveSynthEngine } from '../../engine/LiveSynthEngine.js';
import type { LiveEngineConfig } from '../../engine/LiveSynthEngine.js';
import { loadVoicePreset } from '../../preset/loader.js';
import { resolvePresetPath } from './renderScoreToWav.js';
import type {
  TrackState, Participant, TransportState, JamSessionSnapshot,
  TrackAddMessage, TrackUpdateMessage, TrackNoteOnMessage, TrackNoteOffMessage,
  JamTransportSetMessage, TransportTickMessage, JamTelemetryMessage,
  JamServerMessage,
} from '../../types/jam.js';

const AUDIO_HEADER_SIZE = 16;
const MAX_SEND_QUEUE_BYTES = 4 * 1024 * 1024;
const TRANSPORT_TICK_INTERVAL_BLOCKS = 5;  // ~50ms at 512 samples / 48kHz
const TELEMETRY_INTERVAL_MS = 67;          // ~15 Hz
const STUCK_NOTE_CHECK_MS = 5000;

export interface JamSessionConfig {
  sessionId: string;
  bpm: number;
  timeSig: { num: number; den: number };
  sampleRateHz: number;
  blockSize: number;
  seed: number;
}

interface TrackEntry {
  state: TrackState;
  engine: LiveSynthEngine;
}

export class JamSession {
  readonly sessionId: string;
  readonly createdAt: number;
  private config: JamSessionConfig;

  // Transport
  private transport: TransportState;

  // Tracks
  private tracks: Map<string, TrackEntry> = new Map();
  private nextTrackNum: number = 1;

  // Participants
  private participants: Map<WebSocket, Participant> = new Map();

  // Render loop
  private renderLoopInterval: ReturnType<typeof setInterval> | null = null;
  private audioSeq: number = 0;
  private audioFrameBuf: Buffer | null = null;
  private blocksSinceLastTick: number = 0;

  // Telemetry
  private telemetryInterval: ReturnType<typeof setInterval> | null = null;

  // Stuck-note watchdog
  private stuckNoteInterval: ReturnType<typeof setInterval> | null = null;

  // Pre-allocated master mix buffer
  private masterMixBuf: Float32Array;

  constructor(config: JamSessionConfig) {
    this.sessionId = config.sessionId;
    this.createdAt = Date.now();
    this.config = config;

    this.transport = {
      playing: false,
      bpm: config.bpm,
      timeSig: config.timeSig,
      currentSample: 0,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 0,
    };

    this.masterMixBuf = new Float32Array(config.blockSize);
  }

  // ── Participant Management ──────────────────────────────────────

  addParticipant(ws: WebSocket, participantId: string, displayName: string): Participant {
    const participant: Participant = {
      participantId,
      displayName,
      joinedAt: Date.now(),
    };
    this.participants.set(ws, participant);

    // Notify others (not the new participant)
    for (const [otherWs] of this.participants) {
      if (otherWs !== ws && otherWs.readyState === 1) {
        otherWs.send(JSON.stringify({
          type: 'participant_joined',
          participant,
        }));
      }
    }

    return participant;
  }

  removeParticipant(ws: WebSocket): void {
    const participant = this.participants.get(ws);
    if (!participant) return;
    this.participants.delete(ws);

    // Notify remaining
    this.broadcast({
      type: 'participant_left',
      participantId: participant.participantId,
    });
  }

  get participantCount(): number {
    return this.participants.size;
  }

  isEmpty(): boolean {
    return this.participants.size === 0;
  }

  // ── Transport Control ──────────────────────────────────────────

  play(): void {
    if (this.transport.playing) return;
    this.transport.playing = true;

    // Start all track engines
    for (const [, entry] of this.tracks) {
      entry.engine.play();
    }

    this.startRenderLoop();
    this.startTelemetry();
    this.startStuckNoteWatchdog();

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  stop(): void {
    if (!this.transport.playing) return;
    this.transport.playing = false;

    this.stopRenderLoop();
    this.stopTelemetry();
    this.stopStuckNoteWatchdog();

    // Panic all track engines
    for (const [, entry] of this.tracks) {
      entry.engine.stop();
    }

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  seek(positionSec: number): void {
    const sample = Math.max(0, Math.round(positionSec * this.config.sampleRateHz));
    this.transport.currentSample = sample;

    // Panic all tracks to release active notes
    for (const [, entry] of this.tracks) {
      entry.engine.panic();
    }

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  setTransportParams(msg: JamTransportSetMessage): void {
    if (msg.bpm !== undefined) this.transport.bpm = msg.bpm;
    if (msg.timeSig !== undefined) this.transport.timeSig = msg.timeSig;
    if (msg.loopEnabled !== undefined) this.transport.loopEnabled = msg.loopEnabled;
    if (msg.loopStartSec !== undefined) this.transport.loopStartSec = msg.loopStartSec;
    if (msg.loopEndSec !== undefined) this.transport.loopEndSec = msg.loopEndSec;

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  // ── Track Management ────────────────────────────────────────────

  async addTrack(msg: TrackAddMessage): Promise<TrackState> {
    const trackId = `track-${this.nextTrackNum++}`;

    const manifestPath = resolvePresetPath(msg.presetId);
    const preset = await loadVoicePreset(manifestPath);

    const timbres = Object.keys(preset.timbres);
    const defaultTimbre = msg.defaultTimbre || timbres[0] || 'AH';
    const polyphony = msg.polyphonyLimit ?? 4;

    const engineConfig: LiveEngineConfig = {
      sampleRateHz: this.config.sampleRateHz,
      blockSize: this.config.blockSize,
      maxPolyphony: polyphony,
      defaultTimbre,
      rngSeed: this.config.seed + this.nextTrackNum,
    };

    const engine = new LiveSynthEngine(engineConfig, preset);
    // Disable per-track limiter — we apply master limiter in the mixer
    engine.setLimiter(false);

    if (this.transport.playing) {
      engine.play();
    }

    const state: TrackState = {
      trackId,
      name: msg.name || `Track ${this.nextTrackNum - 1}`,
      presetId: msg.presetId,
      defaultTimbre,
      polyphonyLimit: polyphony,
      gain: msg.gain ?? 1.0,
      pan: 0,
      mute: false,
      solo: false,
      inputMode: msg.inputMode || 'live',
    };

    this.tracks.set(trackId, { state, engine });
    this.broadcast({ type: 'track_added', track: state });

    return state;
  }

  removeTrack(trackId: string): boolean {
    const entry = this.tracks.get(trackId);
    if (!entry) return false;

    entry.engine.panic();
    this.tracks.delete(trackId);
    this.broadcast({ type: 'track_removed', trackId });

    return true;
  }

  updateTrack(msg: TrackUpdateMessage): TrackState | null {
    const entry = this.tracks.get(msg.trackId);
    if (!entry) return null;

    const s = entry.state;
    if (msg.name !== undefined) s.name = msg.name;
    if (msg.gain !== undefined) s.gain = msg.gain;
    if (msg.pan !== undefined) s.pan = msg.pan;
    if (msg.mute !== undefined) s.mute = msg.mute;
    if (msg.solo !== undefined) s.solo = msg.solo;
    if (msg.inputMode !== undefined) s.inputMode = msg.inputMode;
    if (msg.defaultTimbre !== undefined) {
      s.defaultTimbre = msg.defaultTimbre;
      entry.engine.updateConfig({ defaultTimbre: msg.defaultTimbre });
    }
    if (msg.polyphonyLimit !== undefined) {
      s.polyphonyLimit = msg.polyphonyLimit;
      entry.engine.updateConfig({ maxPolyphony: msg.polyphonyLimit });
    }

    this.broadcast({ type: 'track_updated', track: { ...s } });
    return s;
  }

  // ── Note Events (track-scoped) ──────────────────────────────────

  noteOn(msg: TrackNoteOnMessage): { voiceIndex: number; stolen: boolean } | null {
    const entry = this.tracks.get(msg.trackId);
    if (!entry) return null;

    // Auto-play if not already playing
    if (!this.transport.playing) {
      this.play();
    }

    return entry.engine.noteOn({
      noteId: msg.noteId,
      midi: msg.midi,
      velocity: msg.velocity,
      timbre: msg.timbre,
      breathiness: msg.breathiness,
      vibrato: msg.vibrato,
      portamentoMs: msg.portamentoMs,
    });
  }

  noteOff(msg: TrackNoteOffMessage): void {
    const entry = this.tracks.get(msg.trackId);
    if (!entry) return;
    entry.engine.noteOff(msg.noteId, msg.releaseMs);
  }

  // ── Render Loop + Mixer ─────────────────────────────────────────

  private startRenderLoop(): void {
    this.stopRenderLoop();

    const blockSize = this.config.blockSize;
    const sampleRate = this.config.sampleRateHz;
    const blockMs = (blockSize / sampleRate) * 1000;

    // Pre-allocate binary audio frame
    this.audioSeq = 0;
    this.audioFrameBuf = Buffer.alloc(AUDIO_HEADER_SIZE + blockSize * 4);
    // Static header fields
    this.audioFrameBuf.writeUInt16LE(1, 4);          // channels = 1 (mono)
    this.audioFrameBuf.writeUInt16LE(0, 6);           // reserved
    this.audioFrameBuf.writeUInt32LE(sampleRate, 8);
    this.audioFrameBuf.writeUInt32LE(blockSize, 12);

    this.renderLoopInterval = setInterval(() => {
      if (!this.transport.playing) return;
      this.renderAndBroadcast();
    }, blockMs);
  }

  private stopRenderLoop(): void {
    if (this.renderLoopInterval !== null) {
      clearInterval(this.renderLoopInterval);
      this.renderLoopInterval = null;
    }
  }

  private renderAndBroadcast(): void {
    const blockSize = this.config.blockSize;
    const mix = this.mixTracks();

    // Advance transport clock
    this.transport.currentSample += blockSize;

    // Loop handling
    if (this.transport.loopEnabled && this.transport.loopEndSec > 0) {
      const currentSec = this.transport.currentSample / this.config.sampleRateHz;
      if (currentSec >= this.transport.loopEndSec) {
        const sample = Math.round(this.transport.loopStartSec * this.config.sampleRateHz);
        this.transport.currentSample = sample;
        // Panic all engines to clear active notes at loop boundary
        for (const [, entry] of this.tracks) {
          entry.engine.panic();
        }
      }
    }

    // Transport tick
    this.blocksSinceLastTick++;
    if (this.blocksSinceLastTick >= TRANSPORT_TICK_INTERVAL_BLOCKS) {
      this.sendTransportTick();
      this.blocksSinceLastTick = 0;
    }

    // Broadcast binary PCM to all participants
    if (this.audioFrameBuf && this.participants.size > 0) {
      this.audioFrameBuf.writeUInt32LE(this.audioSeq++, 0);
      const pcmBytes = Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength);
      pcmBytes.copy(this.audioFrameBuf, AUDIO_HEADER_SIZE);
      this.broadcastBinary(this.audioFrameBuf);
    }
  }

  private mixTracks(): Float32Array {
    const blockSize = this.config.blockSize;
    const mix = this.masterMixBuf;
    mix.fill(0);

    // Check if any track is soloed
    let anySolo = false;
    for (const [, entry] of this.tracks) {
      if (entry.state.solo) { anySolo = true; break; }
    }

    for (const [, entry] of this.tracks) {
      const { state, engine } = entry;

      // Solo/mute logic: if any solo, only play soloed tracks
      if (anySolo && !state.solo) continue;
      if (!anySolo && state.mute) continue;

      const trackBlock = engine.render();
      const gain = state.gain;
      for (let i = 0; i < blockSize; i++) {
        mix[i] += trackBlock[i] * gain;
      }
    }

    // Master limiter (tanh soft clip)
    for (let i = 0; i < blockSize; i++) {
      mix[i] = Math.tanh(mix[i]);
    }

    return mix;
  }

  // ── Transport Tick ──────────────────────────────────────────────

  private sendTransportTick(): void {
    const sampleRate = this.config.sampleRateHz;
    const currentSec = this.transport.currentSample / sampleRate;

    const beatsPerSec = this.transport.bpm / 60;
    const totalBeats = currentSec * beatsPerSec;
    const beatsPerMeasure = this.transport.timeSig.num;
    const currentMeasure = Math.floor(totalBeats / beatsPerMeasure);
    const currentBeat = totalBeats % beatsPerMeasure;

    const tick: TransportTickMessage = {
      type: 'transport_tick',
      currentSec,
      currentBeat,
      currentMeasure,
      playing: this.transport.playing,
    };
    this.broadcast(tick);
  }

  // ── Telemetry ───────────────────────────────────────────────────

  private startTelemetry(): void {
    this.stopTelemetry();
    this.telemetryInterval = setInterval(() => {
      const trackTelemetry: JamTelemetryMessage['tracks'] = [];
      let masterPeakLinear = 0;

      for (const [, entry] of this.tracks) {
        const t = entry.engine.getTelemetryAndReset();
        trackTelemetry.push({
          trackId: entry.state.trackId,
          voicesActive: t.voicesActive,
          peakDbfs: t.peakDbfs,
        });
        const linearPeak = t.peakDbfs > -120 ? Math.pow(10, t.peakDbfs / 20) : 0;
        if (linearPeak > masterPeakLinear) masterPeakLinear = linearPeak;
      }

      const msg: JamTelemetryMessage = {
        type: 'jam_telemetry',
        tracks: trackTelemetry,
        masterPeakDbfs: masterPeakLinear > 0 ? 20 * Math.log10(masterPeakLinear) : -Infinity,
        participantCount: this.participants.size,
        uptimeSec: (Date.now() - this.createdAt) / 1000,
      };
      this.broadcast(msg);
    }, TELEMETRY_INTERVAL_MS);
  }

  private stopTelemetry(): void {
    if (this.telemetryInterval !== null) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  // ── Stuck-Note Watchdog ─────────────────────────────────────────

  private startStuckNoteWatchdog(): void {
    this.stopStuckNoteWatchdog();
    this.stuckNoteInterval = setInterval(() => {
      for (const [, entry] of this.tracks) {
        (entry.engine as any).releaseStuckNotes?.(120);
      }
    }, STUCK_NOTE_CHECK_MS);
  }

  private stopStuckNoteWatchdog(): void {
    if (this.stuckNoteInterval !== null) {
      clearInterval(this.stuckNoteInterval);
      this.stuckNoteInterval = null;
    }
  }

  // ── Broadcast ───────────────────────────────────────────────────

  private broadcast(msg: JamServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.participants) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }

  sendTo(ws: WebSocket, msg: JamServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastBinary(frame: Buffer): void {
    for (const [ws] of this.participants) {
      if (ws.readyState === 1 && (ws as any).bufferedAmount <= MAX_SEND_QUEUE_BYTES) {
        ws.send(frame);
      }
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────

  getSnapshot(): JamSessionSnapshot {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      sampleRateHz: this.config.sampleRateHz,
      blockSize: this.config.blockSize,
      seed: this.config.seed,
      transport: { ...this.transport },
      tracks: Array.from(this.tracks.values()).map(e => ({ ...e.state })),
      participants: Array.from(this.participants.values()),
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  destroy(): void {
    this.stopRenderLoop();
    this.stopTelemetry();
    this.stopStuckNoteWatchdog();

    for (const [, entry] of this.tracks) {
      entry.engine.panic();
    }
    this.tracks.clear();

    for (const [ws] of this.participants) {
      if (ws.readyState === 1) {
        ws.close(4003, 'Session destroyed');
      }
    }
    this.participants.clear();

    this.audioFrameBuf = null;
  }
}
