/**
 * JamSessionManager — registry of active jam sessions + WS message router.
 *
 * Each WebSocket connection is tracked independently. A connection must
 * send `jam_hello` before any other message, then create or join a session.
 */

import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { JamSession } from './JamSession.js';
import type { JamSessionConfig } from './JamSession.js';
import {
  JAM_PROTOCOL_VERSION,
  type JamClientMessage,
  type JamServerMessage,
  type JamHelloMessage,
  type SessionCreateMessage,
  type SessionJoinMessage,
  type TrackAddMessage,
  type TrackUpdateMessage,
  type TrackNoteOnMessage,
  type TrackNoteOffMessage,
  type JamTransportSetMessage,
  type JamTransportSeekMessage,
  type TrackSetScoreMessage,
  type ParticipantRole,
} from '../../types/jam.js';

const MAX_SESSIONS = Number(process.env.MAX_JAM_SESSIONS) || 8;
const MAX_PARTICIPANTS_PER_SESSION = Number(process.env.MAX_JAM_PARTICIPANTS) || 8;
const DEFAULT_SAMPLE_RATE = 48000;

interface ConnectionState {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  session: JamSession | null;
  authenticated: boolean;  // has sent jam_hello
}

export class JamSessionManager {
  private sessions: Map<string, JamSession> = new Map();
  private connections: Map<WebSocket, ConnectionState> = new Map();

  // ── Connection Lifecycle ────────────────────────────────────────

  onConnect(ws: WebSocket): void {
    this.connections.set(ws, {
      participantId: randomUUID().slice(0, 12),
      displayName: `Player ${this.connections.size + 1}`,
      role: 'guest',
      session: null,
      authenticated: false,
    });
  }

  onDisconnect(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    if (conn.session) {
      conn.session.removeParticipant(ws);

      // Garbage collect empty sessions
      if (conn.session.isEmpty()) {
        const sessionId = conn.session.sessionId;
        conn.session.destroy();
        this.sessions.delete(sessionId);
        console.log(`[jam] Session ${sessionId} destroyed (empty)`);
      }
    }

    this.connections.delete(ws);
  }

  // ── Message Router ──────────────────────────────────────────────

  async handleMessage(ws: WebSocket, msg: JamClientMessage): Promise<void> {
    const conn = this.connections.get(ws);
    if (!conn) return;

    // jam_hello must come first
    if (msg.type === 'jam_hello') {
      this.handleHello(ws, conn, msg);
      return;
    }

    if (!conn.authenticated) {
      this.sendError(ws, 'NOT_AUTHENTICATED', 'Send jam_hello first');
      return;
    }

    switch (msg.type) {
      case 'session_create':
        await this.handleSessionCreate(ws, conn, msg);
        break;

      case 'session_join':
        this.handleSessionJoin(ws, conn, msg);
        break;

      case 'session_leave':
        this.handleSessionLeave(ws, conn);
        break;

      // Transport (host-only)
      case 'transport_play':
      case 'transport_stop':
      case 'transport_seek':
      case 'transport_set': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'control transport')) return;
        this.handleTransport(conn.session, msg);
        break;
      }

      // Track add (host-only), remove/update (owner-or-host)
      case 'track_add': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'add tracks')) return;
        await this.handleTrack(ws, conn, conn.session, msg);
        break;
      }

      case 'track_remove':
      case 'track_update': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        const trackIdForAuth = (msg as any).trackId;
        if (!this.canModifyTrack(ws, conn, trackIdForAuth, msg.type === 'track_remove' ? 'remove tracks' : 'update tracks')) return;
        await this.handleTrack(ws, conn, conn.session, msg);
        break;
      }

      // Note events (all participants)
      case 'track_note_on':
      case 'track_note_off': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        this.handleNote(ws, conn, conn.session, msg);
        break;
      }

      // Phase 5B: Quantization + Recording (host-only) + Metronome (all)
      case 'session_set_quantize': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'set quantize')) return;
        conn.session.setQuantize(msg.grid);
        break;
      }

      case 'record_start': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'start recording')) return;
        conn.session.startRecording();
        break;
      }

      case 'record_stop': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'stop recording')) return;
        conn.session.stopRecording();
        break;
      }

      case 'record_export': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.requireHost(ws, conn, 'export recording')) return;
        await conn.session.exportRecording(msg.name);
        break;
      }

      case 'metronome_toggle': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        conn.session.toggleMetronome();
        break;
      }

      // Phase 5C: Score input
      case 'track_set_score': {
        if (!conn.session) {
          this.sendError(ws, 'NOT_IN_SESSION', 'Join a session first');
          return;
        }
        if (!this.canModifyTrack(ws, conn, msg.trackId, 'set score')) return;
        const scoreSet = conn.session.setTrackScore(msg.trackId, msg.score);
        if (!scoreSet) {
          this.sendError(ws, 'TRACK_NOT_FOUND', `Track '${msg.trackId}' not found`);
        }
        break;
      }

      case 'jam_ping':
        this.sendTo(ws, {
          type: 'jam_pong',
          clientTimestamp: msg.clientTimestamp,
          serverTimestamp: Date.now(),
        });
        break;

      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${(msg as any).type}`);
    }
  }

  // ── Role Checks (Phase 5C) ─────────────────────────────────────

  private requireHost(ws: WebSocket, conn: ConnectionState, action: string): boolean {
    if (conn.role !== 'host') {
      this.sendError(ws, 'NOT_HOST', `Only the host can ${action}`);
      return false;
    }
    return true;
  }

  private canModifyTrack(ws: WebSocket, conn: ConnectionState, trackId: string, action: string): boolean {
    if (conn.role === 'host') return true;
    const ownerId = conn.session!.getTrackOwnerId(trackId);
    if (ownerId === conn.participantId) return true;
    this.sendError(ws, 'NOT_AUTHORIZED', `Only the track owner or host can ${action}`);
    return false;
  }

  // ── Handlers ────────────────────────────────────────────────────

  private handleHello(ws: WebSocket, conn: ConnectionState, msg: JamHelloMessage): void {
    if (msg.protocolVersion !== JAM_PROTOCOL_VERSION) {
      this.sendError(ws, 'PROTOCOL_MISMATCH',
        `Expected protocol version ${JAM_PROTOCOL_VERSION}, got ${msg.protocolVersion}`);
      ws.close(4001, 'Protocol mismatch');
      return;
    }

    if (msg.displayName) {
      conn.displayName = msg.displayName;
    }
    conn.authenticated = true;

    this.sendTo(ws, {
      type: 'jam_hello_ack',
      protocolVersion: JAM_PROTOCOL_VERSION,
      participantId: conn.participantId,
    });
  }

  private async handleSessionCreate(
    ws: WebSocket, conn: ConnectionState, msg: SessionCreateMessage
  ): Promise<void> {
    if (conn.session) {
      this.sendError(ws, 'ALREADY_IN_SESSION', 'Leave current session first');
      return;
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.sendError(ws, 'MAX_SESSIONS', `Server limit: ${MAX_SESSIONS} concurrent sessions`);
      return;
    }

    const sessionId = randomUUID().slice(0, 8);
    const config: JamSessionConfig = {
      sessionId,
      bpm: msg.bpm ?? 120,
      timeSig: msg.timeSig ?? { num: 4, den: 4 },
      sampleRateHz: DEFAULT_SAMPLE_RATE,
      blockSize: msg.blockSize ?? 512,
      seed: msg.seed ?? Math.floor(Math.random() * 2147483647),
    };

    const session = new JamSession(config);
    this.sessions.set(sessionId, session);

    // Creator auto-joins as host
    conn.role = 'host';
    session.setHost(conn.participantId);
    session.addParticipant(ws, conn.participantId, conn.displayName, 'host');
    conn.session = session;

    this.sendTo(ws, {
      type: 'session_created',
      snapshot: session.getSnapshot(),
    });

    console.log(`[jam] Session ${sessionId} created by ${conn.displayName}`);
  }

  private handleSessionJoin(
    ws: WebSocket, conn: ConnectionState, msg: SessionJoinMessage
  ): void {
    if (conn.session) {
      this.sendError(ws, 'ALREADY_IN_SESSION', 'Leave current session first');
      return;
    }

    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      this.sendError(ws, 'SESSION_NOT_FOUND', `No session with id '${msg.sessionId}'`);
      return;
    }

    if (session.participantCount >= MAX_PARTICIPANTS_PER_SESSION) {
      this.sendError(ws, 'SESSION_FULL', `Session is full (${MAX_PARTICIPANTS_PER_SESSION} max)`);
      return;
    }

    conn.role = 'guest';
    session.addParticipant(ws, conn.participantId, conn.displayName, 'guest');
    conn.session = session;

    this.sendTo(ws, {
      type: 'session_joined',
      snapshot: session.getSnapshot(),
      yourParticipantId: conn.participantId,
    });

    console.log(`[jam] ${conn.displayName} joined session ${msg.sessionId}`);
  }

  private handleSessionLeave(ws: WebSocket, conn: ConnectionState): void {
    if (!conn.session) {
      this.sendError(ws, 'NOT_IN_SESSION', 'Not in any session');
      return;
    }

    const sessionId = conn.session.sessionId;
    conn.session.removeParticipant(ws);

    // Garbage collect empty sessions
    if (conn.session.isEmpty()) {
      conn.session.destroy();
      this.sessions.delete(sessionId);
      console.log(`[jam] Session ${sessionId} destroyed (empty)`);
    }

    conn.session = null;

    this.sendTo(ws, { type: 'session_left', sessionId });
  }

  private handleTransport(
    session: JamSession,
    msg: { type: string } & Record<string, any>
  ): void {
    switch (msg.type) {
      case 'transport_play':
        session.play();
        break;
      case 'transport_stop':
        session.stop();
        break;
      case 'transport_seek':
        session.seek((msg as JamTransportSeekMessage).positionSec);
        break;
      case 'transport_set':
        session.setTransportParams(msg as JamTransportSetMessage);
        break;
    }
  }

  private async handleTrack(
    ws: WebSocket, conn: ConnectionState, session: JamSession,
    msg: TrackAddMessage | { type: 'track_remove'; trackId: string } | TrackUpdateMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'track_add': {
        try {
          await session.addTrack(msg as TrackAddMessage, conn.participantId);
        } catch (err: any) {
          this.sendError(ws, err.code || 'TRACK_ADD_FAILED', err.message);
        }
        break;
      }
      case 'track_remove': {
        const removed = session.removeTrack((msg as { trackId: string }).trackId);
        if (!removed) {
          this.sendError(ws, 'TRACK_NOT_FOUND', `Track not found`);
        }
        break;
      }
      case 'track_update': {
        const updated = session.updateTrack(msg as TrackUpdateMessage);
        if (!updated) {
          this.sendError(ws, 'TRACK_NOT_FOUND', `Track not found`);
        }
        break;
      }
    }
  }

  private handleNote(
    ws: WebSocket, conn: ConnectionState, session: JamSession,
    msg: TrackNoteOnMessage | TrackNoteOffMessage
  ): void {
    if (msg.type === 'track_note_on') {
      const result = session.noteOn(msg, conn.participantId);
      if (result) {
        session.sendTo(ws, {
          type: 'track_note_ack',
          trackId: msg.trackId,
          noteId: msg.noteId,
          voiceIndex: result.voiceIndex,
          stolen: result.stolen,
        });
      } else {
        this.sendError(ws, 'TRACK_NOT_FOUND', `Track '${msg.trackId}' not found`);
      }
    } else {
      session.noteOff(msg, conn.participantId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private sendTo(ws: WebSocket, msg: JamServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendTo(ws, { type: 'jam_error', code, message });
  }

  // ── Accessors ───────────────────────────────────────────────────

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get activeConnectionCount(): number {
    return this.connections.size;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  destroyAll(): void {
    for (const [, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
    this.connections.clear();
  }
}
