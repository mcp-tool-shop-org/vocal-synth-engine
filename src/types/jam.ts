// ── Phase 5A/5B/5C: Jam Session Types ────────────────────────────

import type { VocalScore } from './score.js';

export const JAM_PROTOCOL_VERSION = 1;

// ── Core Models ──────────────────────────────────────────────────

export type TrackInputMode = 'live' | 'score' | 'agent';
export type QuantizeGrid = 'none' | '1/4' | '1/8' | '1/16' | '1/32';
export type ParticipantRole = 'host' | 'guest';

// ── EventTape (Phase 5B) ─────────────────────────────────────────

export type EventTapeEventType = 'note_on' | 'note_off' | 'transport_bpm' | 'transport_stop';

export interface EventTapeEntry {
  tSample: number;         // sample offset from recording start
  trackId: string;
  event: EventTapeEventType;
  payload: Record<string, any>;  // midi, velocity, timbre, etc.
  participantId?: string;  // who triggered this event ('_score' for score-scheduled)
}

export interface EventTape {
  sampleRateHz: number;
  blockSize: number;
  bpm: number;
  timeSig: { num: number; den: number };
  seed: number;
  tracks: Array<{ trackId: string; presetId: string; name: string; gain: number }>;
  events: EventTapeEntry[];
}

export interface TrackState {
  trackId: string;
  name: string;
  presetId: string;
  defaultTimbre: string;
  polyphonyLimit: number;
  gain: number;             // linear 0..2 (1.0 = unity)
  pan: number;              // -1..1 (reserved, mono for now)
  mute: boolean;
  solo: boolean;
  inputMode: TrackInputMode;
  ownerId: string;
}

export interface Participant {
  participantId: string;
  displayName: string;
  joinedAt: number;
  role: ParticipantRole;
}

export interface TransportState {
  playing: boolean;
  bpm: number;
  timeSig: { num: number; den: number };
  currentSample: number;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
}

export interface JamSessionSnapshot {
  sessionId: string;
  createdAt: number;
  hostId: string;
  sampleRateHz: number;
  blockSize: number;
  seed: number;
  transport: TransportState;
  tracks: TrackState[];
  participants: Participant[];
}

// ── Client → Server Messages ─────────────────────────────────────

export interface JamHelloMessage {
  type: 'jam_hello';
  protocolVersion: number;
  displayName?: string;
}

export interface SessionCreateMessage {
  type: 'session_create';
  bpm?: number;
  timeSig?: { num: number; den: number };
  blockSize?: number;
  seed?: number;
}

export interface SessionJoinMessage {
  type: 'session_join';
  sessionId: string;
}

export interface SessionLeaveMessage {
  type: 'session_leave';
}

export interface JamTransportSetMessage {
  type: 'transport_set';
  bpm?: number;
  timeSig?: { num: number; den: number };
  loopEnabled?: boolean;
  loopStartSec?: number;
  loopEndSec?: number;
}

export interface JamTransportPlayMessage {
  type: 'transport_play';
}

export interface JamTransportStopMessage {
  type: 'transport_stop';
}

export interface JamTransportSeekMessage {
  type: 'transport_seek';
  positionSec: number;
}

export interface TrackAddMessage {
  type: 'track_add';
  name?: string;
  presetId: string;
  defaultTimbre?: string;
  polyphonyLimit?: number;
  gain?: number;
  inputMode?: TrackInputMode;
}

export interface TrackRemoveMessage {
  type: 'track_remove';
  trackId: string;
}

export interface TrackUpdateMessage {
  type: 'track_update';
  trackId: string;
  name?: string;
  gain?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  polyphonyLimit?: number;
  defaultTimbre?: string;
  inputMode?: TrackInputMode;
}

export interface TrackNoteOnMessage {
  type: 'track_note_on';
  trackId: string;
  noteId: string;
  midi: number;
  velocity: number;
  timbre?: string;
  breathiness?: number;
  vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
  portamentoMs?: number;
}

export interface TrackNoteOffMessage {
  type: 'track_note_off';
  trackId: string;
  noteId: string;
  releaseMs?: number;
}

export interface JamPingMessage {
  type: 'jam_ping';
  clientTimestamp: number;
}

// ── Phase 5B Client Messages ─────────────────────────────────────

export interface SessionSetQuantizeMessage {
  type: 'session_set_quantize';
  grid: QuantizeGrid;
}

export interface RecordStartMessage {
  type: 'record_start';
}

export interface RecordStopMessage {
  type: 'record_stop';
}

export interface RecordExportMessage {
  type: 'record_export';
  name?: string;
}

export interface MetronomeToggleMessage {
  type: 'metronome_toggle';
}

// ── Phase 5C Client Messages ─────────────────────────────────────

export interface TrackSetScoreMessage {
  type: 'track_set_score';
  trackId: string;
  score: VocalScore;
}

export type JamClientMessage =
  | JamHelloMessage
  | SessionCreateMessage
  | SessionJoinMessage
  | SessionLeaveMessage
  | JamTransportSetMessage
  | JamTransportPlayMessage
  | JamTransportStopMessage
  | JamTransportSeekMessage
  | TrackAddMessage
  | TrackRemoveMessage
  | TrackUpdateMessage
  | TrackNoteOnMessage
  | TrackNoteOffMessage
  | JamPingMessage
  | SessionSetQuantizeMessage
  | RecordStartMessage
  | RecordStopMessage
  | RecordExportMessage
  | MetronomeToggleMessage
  | TrackSetScoreMessage;

// ── Server → Client Messages ─────────────────────────────────────

export interface JamHelloAckMessage {
  type: 'jam_hello_ack';
  protocolVersion: number;
  participantId: string;
}

export interface SessionCreatedMessage {
  type: 'session_created';
  snapshot: JamSessionSnapshot;
}

export interface SessionJoinedMessage {
  type: 'session_joined';
  snapshot: JamSessionSnapshot;
  yourParticipantId: string;
}

export interface SessionLeftMessage {
  type: 'session_left';
  sessionId: string;
}

export interface ParticipantJoinedMessage {
  type: 'participant_joined';
  participant: Participant;
}

export interface ParticipantLeftMessage {
  type: 'participant_left';
  participantId: string;
}

export interface JamTransportAckMessage {
  type: 'transport_ack';
  transport: TransportState;
}

export interface TransportTickMessage {
  type: 'transport_tick';
  currentSec: number;
  currentBeat: number;
  currentMeasure: number;
  playing: boolean;
}

export interface TrackAddedMessage {
  type: 'track_added';
  track: TrackState;
}

export interface TrackRemovedMessage {
  type: 'track_removed';
  trackId: string;
}

export interface TrackUpdatedMessage {
  type: 'track_updated';
  track: TrackState;
}

export interface TrackNoteAckMessage {
  type: 'track_note_ack';
  trackId: string;
  noteId: string;
  voiceIndex: number;
  stolen: boolean;
}

export interface JamTelemetryMessage {
  type: 'jam_telemetry';
  tracks: Array<{
    trackId: string;
    voicesActive: number;
    peakDbfs: number;
  }>;
  masterPeakDbfs: number;
  participantCount: number;
  uptimeSec: number;
}

export interface JamErrorMessage {
  type: 'jam_error';
  code: string;
  message: string;
}

export interface JamPongMessage {
  type: 'jam_pong';
  clientTimestamp: number;
  serverTimestamp: number;
}

// ── Phase 5B Server Messages ─────────────────────────────────────

export interface QuantizeAckMessage {
  type: 'quantize_ack';
  grid: QuantizeGrid;
}

export interface RecordStatusMessage {
  type: 'record_status';
  recording: boolean;
  durationSec: number;
  eventCount: number;
}

export interface RecordExportedMessage {
  type: 'record_exported';
  renderId: string;
  durationSec: number;
  wavHash: string;
}

export interface MetronomeTickMessage {
  type: 'metronome_tick';
  beat: number;
  measure: number;
  downbeat: boolean;
}

export interface MetronomeAckMessage {
  type: 'metronome_ack';
  enabled: boolean;
}

// ── Phase 5C Server Messages ─────────────────────────────────────

export interface ScoreStatusMessage {
  type: 'score_status';
  trackId: string;
  noteCount: number;
  durationSec: number;
  playing: boolean;
}

export type JamServerMessage =
  | JamHelloAckMessage
  | SessionCreatedMessage
  | SessionJoinedMessage
  | SessionLeftMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | JamTransportAckMessage
  | TransportTickMessage
  | TrackAddedMessage
  | TrackRemovedMessage
  | TrackUpdatedMessage
  | TrackNoteAckMessage
  | JamTelemetryMessage
  | JamErrorMessage
  | JamPongMessage
  | QuantizeAckMessage
  | RecordStatusMessage
  | RecordExportedMessage
  | MetronomeTickMessage
  | MetronomeAckMessage
  | ScoreStatusMessage;
