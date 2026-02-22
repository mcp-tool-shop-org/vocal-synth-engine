/**
 * WebSocket Live Protocol — VocalSynth Cockpit
 *
 * All messages are JSON. Each has a `type` field for discrimination.
 * Protocol version is exchanged in hello/hello_ack.
 */

export const LIVE_PROTOCOL_VERSION = 1;

// ── Client → Server ──────────────────────────────────────────────

export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
}

export interface TransportMessage {
  type: 'transport';
  command: 'play' | 'stop' | 'panic';
  bpm?: number;
}

export interface NoteOnMessage {
  type: 'note_on';
  noteId: string;
  midi: number;
  velocity: number;          // 0..1
  timbre?: string;
  breathiness?: number;      // 0..1
  vibrato?: {
    rateHz: number;
    depthCents: number;
    onsetSec: number;
  };
  portamentoMs?: number;
}

export interface NoteOffMessage {
  type: 'note_off';
  noteId: string;
  releaseMs?: number;        // override default release time
}

export interface ParamUpdateMessage {
  type: 'param_update';
  maxPolyphony?: number;
  rngSeed?: number;
  defaultTimbre?: string;
  presetId?: string;
  blockSize?: number;
}

export interface RecordStartMessage {
  type: 'record_start';
}

export interface RecordStopMessage {
  type: 'record_stop';
  name?: string;             // name for the saved render
}

export type ClientMessage =
  | HelloMessage
  | TransportMessage
  | NoteOnMessage
  | NoteOffMessage
  | ParamUpdateMessage
  | RecordStartMessage
  | RecordStopMessage;

// ── Server → Client ──────────────────────────────────────────────

export interface HelloAckMessage {
  type: 'hello_ack';
  protocolVersion: number;
  presetId: string;
  timbres: string[];
  sampleRateHz: number;
  maxPolyphony: number;
  blockSize: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface TelemetryMessage {
  type: 'telemetry';
  voicesActive: number;
  voicesMax: number;
  peakDbfs: number;
  clickDeltaMaxRecent: number;
  rtf: number;
  recordingSec: number | null;  // null if not recording
  uptimeSec: number;
}

export interface RecordStatusMessage {
  type: 'record_status';
  recording: boolean;
  durationSec: number;
  samplesRecorded: number;
}

export interface TransportAckMessage {
  type: 'transport_ack';
  state: 'playing' | 'stopped';
}

export interface NoteAckMessage {
  type: 'note_ack';
  noteId: string;
  voiceIndex: number;         // which voice slot got assigned
  stolen: boolean;            // was a voice stolen?
}

export type ServerMessage =
  | HelloAckMessage
  | ErrorMessage
  | TelemetryMessage
  | RecordStatusMessage
  | TransportAckMessage
  | NoteAckMessage;

// ── Combined ─────────────────────────────────────────────────────

export type LiveMessage = ClientMessage | ServerMessage;
