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
import { saveRender } from '../storage/renderStore.js';
import { exportEventTapeToWav } from './jamExport.js';
import type {
  TrackState, Participant, TransportState, JamSessionSnapshot,
  TrackAddMessage, TrackUpdateMessage, TrackNoteOnMessage, TrackNoteOffMessage,
  JamTransportSetMessage, TransportTickMessage, JamTelemetryMessage,
  JamServerMessage, ParticipantRole,
  QuantizeGrid, EventTapeEntry, EventTape,
} from '../../types/jam.js';
import type { VocalScore, VocalNote } from '../../types/score.js';

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

interface ScoreEvent {
  sampleOffset: number;
  type: 'on' | 'off';
  noteId: string;
  midi: number;
  velocity: number;
  timbre?: string;
  vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
  releaseMs?: number;
}

interface TrackEntry {
  state: TrackState;
  engine: LiveSynthEngine;
  scoreEvents?: ScoreEvent[];
  scoreCursor?: number;
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

  // Phase 5C: Host + Score
  private hostParticipantId: string = '';

  // Phase 5B: Quantization + Recording + Metronome
  private quantizeGrid: QuantizeGrid = 'none';
  private recording: boolean = false;
  private eventTape: EventTapeEntry[] = [];
  private recordStartSample: number = 0;
  private metronomeEnabled: boolean = false;
  private lastMetronomeBeat: number = -1;

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

  setHost(participantId: string): void {
    this.hostParticipantId = participantId;
  }

  addParticipant(ws: WebSocket, participantId: string, displayName: string, role: ParticipantRole = 'guest'): Participant {
    const participant: Participant = {
      participantId,
      displayName,
      joinedAt: Date.now(),
      role,
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

    // Panic all tracks to release active notes + reset score cursors
    for (const [, entry] of this.tracks) {
      entry.engine.panic();
      if (entry.scoreEvents) {
        entry.scoreCursor = entry.scoreEvents.findIndex(e => e.sampleOffset >= sample);
        if (entry.scoreCursor === -1) entry.scoreCursor = entry.scoreEvents.length;
      }
    }

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  setTransportParams(msg: JamTransportSetMessage): void {
    // Record BPM change if recording
    if (msg.bpm !== undefined && msg.bpm !== this.transport.bpm && this.recording) {
      this.eventTape.push({
        tSample: this.transport.currentSample - this.recordStartSample,
        trackId: '',
        event: 'transport_bpm',
        payload: { bpm: msg.bpm },
      });
    }

    if (msg.bpm !== undefined) this.transport.bpm = msg.bpm;
    if (msg.timeSig !== undefined) this.transport.timeSig = msg.timeSig;
    if (msg.loopEnabled !== undefined) this.transport.loopEnabled = msg.loopEnabled;
    if (msg.loopStartSec !== undefined) this.transport.loopStartSec = msg.loopStartSec;
    if (msg.loopEndSec !== undefined) this.transport.loopEndSec = msg.loopEndSec;

    this.broadcast({ type: 'transport_ack', transport: { ...this.transport } });
  }

  // ── Quantization (Phase 5B) ─────────────────────────────────────

  setQuantize(grid: QuantizeGrid): void {
    this.quantizeGrid = grid;
    this.broadcast({ type: 'quantize_ack', grid });
  }

  /**
   * Snap a sample position to the nearest grid line.
   * Grid divisions: '1/4' = quarter note, '1/8' = eighth, etc.
   */
  private quantizeSample(sample: number): number {
    if (this.quantizeGrid === 'none') return sample;

    const divisor = parseInt(this.quantizeGrid.split('/')[1]);
    const samplesPerBeat = (this.config.sampleRateHz * 60) / this.transport.bpm;
    const gridSamples = samplesPerBeat / (divisor / 4);  // quarter = 1, eighth = 2, etc.

    return Math.round(sample / gridSamples) * gridSamples;
  }

  // ── Recording (Phase 5B) ──────────────────────────────────────

  startRecording(): void {
    this.recording = true;
    this.eventTape = [];
    this.recordStartSample = this.transport.currentSample;
    this.broadcast({
      type: 'record_status',
      recording: true,
      durationSec: 0,
      eventCount: 0,
    });
  }

  stopRecording(): void {
    this.recording = false;
    const durationSec = (this.transport.currentSample - this.recordStartSample) / this.config.sampleRateHz;
    this.broadcast({
      type: 'record_status',
      recording: false,
      durationSec,
      eventCount: this.eventTape.length,
    });
  }

  async exportRecording(name?: string): Promise<void> {
    if (this.eventTape.length === 0) {
      this.broadcast({
        type: 'jam_error',
        code: 'NO_RECORDING',
        message: 'No events recorded. Start and stop recording first.',
      });
      return;
    }

    const tape: EventTape = {
      sampleRateHz: this.config.sampleRateHz,
      blockSize: this.config.blockSize,
      bpm: this.transport.bpm,
      timeSig: { ...this.transport.timeSig },
      seed: this.config.seed,
      tracks: Array.from(this.tracks.values()).map(e => ({
        trackId: e.state.trackId,
        presetId: e.state.presetId,
        name: e.state.name,
        gain: e.state.gain,
      })),
      events: this.eventTape,
    };

    try {
      const result = await exportEventTapeToWav(tape);

      const renderMeta = saveRender({
        name,
        score: { jam: true, eventTape: tape },
        config: {
          sampleRateHz: tape.sampleRateHz,
          blockSize: tape.blockSize,
          bpm: tape.bpm,
          seed: tape.seed,
        },
        telemetry: result.telemetry,
        provenance: result.provenance,
        wavBytes: result.wavBytes,
        durationSec: result.durationSec,
      });

      this.broadcast({
        type: 'record_exported',
        renderId: renderMeta.id,
        durationSec: result.durationSec,
        wavHash: result.provenance.wavHash,
      });
    } catch (err: any) {
      this.broadcast({
        type: 'jam_error',
        code: 'EXPORT_FAILED',
        message: `Export failed: ${err.message}`,
      });
    }
  }

  // ── Metronome (Phase 5B) ──────────────────────────────────────

  toggleMetronome(): void {
    this.metronomeEnabled = !this.metronomeEnabled;
    this.lastMetronomeBeat = -1;
    this.broadcast({ type: 'metronome_ack', enabled: this.metronomeEnabled });
  }

  /**
   * Generate metronome click into buffer at a beat boundary.
   * 880 Hz for downbeat, 440 Hz for other beats.
   * ~10ms sine burst.
   */
  private generateClick(buffer: Float32Array, downbeat: boolean): void {
    const freq = downbeat ? 880 : 440;
    const clickSamples = Math.min(Math.floor(0.01 * this.config.sampleRateHz), buffer.length);
    for (let i = 0; i < clickSamples; i++) {
      const t = i / this.config.sampleRateHz;
      const envelope = 1 - (i / clickSamples);  // linear decay
      buffer[i] += 0.3 * envelope * Math.sin(2 * Math.PI * freq * t);
    }
  }

  // ── Score Scheduler (Phase 5C) ──────────────────────────────────

  /**
   * Compile a VocalScore into sorted ScoreEvents with sample offsets.
   */
  private compileScore(score: VocalScore): ScoreEvent[] {
    const events: ScoreEvent[] = [];
    for (const note of score.notes) {
      events.push({
        sampleOffset: Math.round(note.startSec * this.config.sampleRateHz),
        type: 'on',
        noteId: note.id,
        midi: note.midi,
        velocity: note.velocity ?? 0.8,
        timbre: note.timbre,
        vibrato: note.vibrato,
      });
      events.push({
        sampleOffset: Math.round((note.startSec + note.durationSec) * this.config.sampleRateHz),
        type: 'off',
        noteId: note.id,
        midi: note.midi,
        velocity: 0,
      });
    }
    events.sort((a, b) => a.sampleOffset - b.sampleOffset);
    return events;
  }

  /**
   * Set a VocalScore on a track. Compiles to ScoreEvents and broadcasts status.
   */
  setTrackScore(trackId: string, score: VocalScore): boolean {
    const entry = this.tracks.get(trackId);
    if (!entry) return false;

    entry.state.inputMode = 'score';
    entry.scoreEvents = this.compileScore(score);
    entry.scoreCursor = 0;

    const lastEvent = entry.scoreEvents[entry.scoreEvents.length - 1];
    const durationSec = lastEvent ? lastEvent.sampleOffset / this.config.sampleRateHz : 0;

    this.broadcast({
      type: 'score_status',
      trackId,
      noteCount: score.notes.length,
      durationSec,
      playing: this.transport.playing,
    });

    // Broadcast updated track state
    this.broadcast({ type: 'track_updated', track: { ...entry.state } });

    return true;
  }

  /**
   * Process score events for the current block across all score-mode tracks.
   * Called in renderAndBroadcast() before mixTracks().
   */
  private processScoreEvents(): void {
    const blockStart = this.transport.currentSample;
    const blockEnd = blockStart + this.config.blockSize;

    for (const [, entry] of this.tracks) {
      if (entry.state.inputMode !== 'score' || !entry.scoreEvents) continue;

      const events = entry.scoreEvents;
      let cursor = entry.scoreCursor ?? 0;

      while (cursor < events.length && events[cursor].sampleOffset < blockEnd) {
        const evt = events[cursor];

        if (evt.type === 'on') {
          entry.engine.noteOn({
            noteId: evt.noteId,
            midi: evt.midi,
            velocity: evt.velocity,
            timbre: evt.timbre,
            vibrato: evt.vibrato,
          });

          if (this.recording) {
            this.eventTape.push({
              tSample: evt.sampleOffset - this.recordStartSample,
              trackId: entry.state.trackId,
              event: 'note_on',
              payload: {
                noteId: evt.noteId,
                midi: evt.midi,
                velocity: evt.velocity,
                timbre: evt.timbre,
                vibrato: evt.vibrato,
              },
              participantId: '_score',
            });
          }
        } else {
          entry.engine.noteOff(evt.noteId, evt.releaseMs);

          if (this.recording) {
            this.eventTape.push({
              tSample: evt.sampleOffset - this.recordStartSample,
              trackId: entry.state.trackId,
              event: 'note_off',
              payload: {
                noteId: evt.noteId,
                releaseMs: evt.releaseMs,
              },
              participantId: '_score',
            });
          }
        }

        cursor++;
      }

      entry.scoreCursor = cursor;
    }
  }

  // ── Track Management ────────────────────────────────────────────

  async addTrack(msg: TrackAddMessage, ownerId: string): Promise<TrackState> {
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
      ownerId,
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

  getTrackOwnerId(trackId: string): string | null {
    const entry = this.tracks.get(trackId);
    return entry ? entry.state.ownerId : null;
  }

  // ── Note Events (track-scoped) ──────────────────────────────────

  noteOn(msg: TrackNoteOnMessage, participantId?: string): { voiceIndex: number; stolen: boolean } | null {
    const entry = this.tracks.get(msg.trackId);
    if (!entry) return null;

    // Auto-play if not already playing
    if (!this.transport.playing) {
      this.play();
    }

    // Quantize + record
    const quantizedSample = this.quantizeSample(this.transport.currentSample);
    if (this.recording) {
      this.eventTape.push({
        tSample: quantizedSample - this.recordStartSample,
        trackId: msg.trackId,
        event: 'note_on',
        payload: {
          noteId: msg.noteId,
          midi: msg.midi,
          velocity: msg.velocity,
          timbre: msg.timbre,
          breathiness: msg.breathiness,
          vibrato: msg.vibrato,
          portamentoMs: msg.portamentoMs,
        },
        participantId,
      });
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

  noteOff(msg: TrackNoteOffMessage, participantId?: string): void {
    const entry = this.tracks.get(msg.trackId);
    if (!entry) return;

    // Record note-off
    if (this.recording) {
      this.eventTape.push({
        tSample: this.transport.currentSample - this.recordStartSample,
        trackId: msg.trackId,
        event: 'note_off',
        payload: {
          noteId: msg.noteId,
          releaseMs: msg.releaseMs,
        },
        participantId,
      });
    }

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

    // Fire score events before rendering
    this.processScoreEvents();

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

    // Metronome: mix click AFTER recording capture (clean recordings)
    if (this.metronomeEnabled) {
      this.processMetronome(mix);
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

  /**
   * Check if a new beat boundary falls within the current block.
   * If so, generate a click and broadcast a metronome_tick message.
   */
  private processMetronome(mix: Float32Array): void {
    const sampleRate = this.config.sampleRateHz;
    const beatsPerSec = this.transport.bpm / 60;
    const currentSec = this.transport.currentSample / sampleRate;
    const totalBeats = currentSec * beatsPerSec;
    const currentBeatInt = Math.floor(totalBeats);

    if (currentBeatInt > this.lastMetronomeBeat) {
      this.lastMetronomeBeat = currentBeatInt;

      const beatsPerMeasure = this.transport.timeSig.num;
      const beatInMeasure = currentBeatInt % beatsPerMeasure;
      const downbeat = beatInMeasure === 0;

      this.generateClick(mix, downbeat);

      this.broadcast({
        type: 'metronome_tick',
        beat: beatInMeasure,
        measure: Math.floor(currentBeatInt / beatsPerMeasure),
        downbeat,
      });
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
      hostId: this.hostParticipantId,
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
