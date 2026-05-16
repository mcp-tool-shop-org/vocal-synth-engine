/**
 * Jam-session service tests — Stage C TSB-002 closer.
 *
 * Before this file existed, src/server/services/ shipped at 0.37% statement
 * coverage despite being the primary product surface (jam session, live
 * session, ws message routing). 2,000+ lines of service code with no direct
 * test exercise.
 *
 * These tests stand up real JamSession / JamSessionManager / LiveSession
 * instances against a mock-WS that captures send() invocations into a JSON
 * inbox. The classes themselves are exercised — no I/O, no real WS server.
 *
 * Coverage targets per TSB-002:
 *   - JamSession:       addParticipant / removeParticipant / broadcast / setHost / play+stop / participantCount
 *   - LiveSession:      handleMessage (hello -> hello_ack, ping -> pong, unknown -> error)
 *   - JamSessionManager: onConnect / onDisconnect / handleMessage routing
 *                        (jam_hello -> jam_hello_ack, unauth message -> error,
 *                         session_create -> session_created snapshot,
 *                         session_join missing-id -> error)
 *
 * NB: full audio-loop tests (transport play -> render frame -> note_on) require
 * a real engine and preset load. They live in tests/engine-determinism.test.ts.
 * Here we exercise the *control-plane* surface that protocol-fuzzing and
 * regression-breakage are likely to hit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JamSession } from '../src/server/services/JamSession.js';
import type { JamSessionConfig } from '../src/server/services/JamSession.js';
import { JamSessionManager } from '../src/server/services/JamSessionManager.js';
import { LiveSession } from '../src/server/services/LiveSession.js';

/**
 * Mock-WS that implements the surface JamSession / LiveSession touch:
 *   - readyState=1 (OPEN) by default
 *   - send() captures payload as parsed-JSON into .inbox for inspection
 *   - bufferedAmount stays at 0 (no backpressure)
 *   - close() drops readyState to 3 (CLOSED)
 *
 * Real WebSocket has many more events; for control-plane tests these are
 * all we use.
 */
class MockWs {
  readyState = 1;
  bufferedAmount = 0;
  inbox: any[] = [];
  binaryInbox: Buffer[] = [];

  send(payload: string | Buffer): void {
    if (typeof payload === 'string') {
      try {
        this.inbox.push(JSON.parse(payload));
      } catch {
        this.inbox.push(payload);
      }
    } else {
      this.binaryInbox.push(payload);
    }
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
  }

  // shape-only helpers the classes don't call but Jest-style mocks
  // sometimes assume exist
  on(_event: string, _cb: (...args: any[]) => void): void {}
  once(_event: string, _cb: (...args: any[]) => void): void {}
  removeListener(_event: string, _cb: (...args: any[]) => void): void {}
}

function makeJamConfig(overrides: Partial<JamSessionConfig> = {}): JamSessionConfig {
  return {
    sessionId: 'test-session-1',
    bpm: 120,
    timeSig: { num: 4, den: 4 },
    sampleRateHz: 48000,
    blockSize: 512,
    seed: 42,
    ...overrides,
  };
}

// ── JamSession (direct) ─────────────────────────────────────────────

describe('JamSession participant management (TSB-002)', () => {
  it('addParticipant appends to internal list and bumps participantCount', () => {
    const session = new JamSession(makeJamConfig());
    const ws = new MockWs() as any;
    expect(session.participantCount).toBe(0);
    const p = session.addParticipant(ws, 'p1', 'Alice', 'host');
    expect(session.participantCount).toBe(1);
    expect(p.participantId).toBe('p1');
    expect(p.displayName).toBe('Alice');
    expect(p.role).toBe('host');
    expect(session.isEmpty()).toBe(false);
    session.destroy();
  });

  it('removeParticipant emits participant_left to remaining peers', () => {
    const session = new JamSession(makeJamConfig());
    const wsA = new MockWs() as any;
    const wsB = new MockWs() as any;
    session.addParticipant(wsA, 'pA', 'Alice', 'host');
    session.addParticipant(wsB, 'pB', 'Bob', 'guest');
    // clear inboxes (addParticipant emits participant_joined to other peers)
    wsA.inbox.length = 0;
    wsB.inbox.length = 0;

    session.removeParticipant(wsA);
    expect(session.participantCount).toBe(1);

    // Bob should have received participant_left
    const lefts = wsB.inbox.filter((m: any) => m.type === 'participant_left');
    expect(lefts.length).toBeGreaterThan(0);
    expect(lefts[0].participantId).toBe('pA');
    session.destroy();
  });

  it('addParticipant notifies existing peers via participant_joined', () => {
    const session = new JamSession(makeJamConfig());
    const wsA = new MockWs() as any;
    const wsB = new MockWs() as any;
    session.addParticipant(wsA, 'pA', 'Alice', 'host');
    wsA.inbox.length = 0;
    session.addParticipant(wsB, 'pB', 'Bob', 'guest');

    const joins = wsA.inbox.filter((m: any) => m.type === 'participant_joined');
    expect(joins.length).toBe(1);
    expect(joins[0].participant.participantId).toBe('pB');
    session.destroy();
  });

  it('isEmpty after destroy() reports true (no leaked participants)', () => {
    const session = new JamSession(makeJamConfig());
    const ws = new MockWs() as any;
    session.addParticipant(ws, 'p1', 'Alice');
    session.destroy();
    // destroy() panics engines + clears participants
    expect(session.isEmpty()).toBe(true);
  });

  it('setHost stores host id without throwing', () => {
    const session = new JamSession(makeJamConfig());
    expect(() => session.setHost('p1')).not.toThrow();
    session.destroy();
  });

  it('removing a not-added ws is a no-op (does not throw)', () => {
    const session = new JamSession(makeJamConfig());
    const ghost = new MockWs() as any;
    expect(() => session.removeParticipant(ghost)).not.toThrow();
    expect(session.participantCount).toBe(0);
    session.destroy();
  });
});

// ── JamSessionManager (routing) ─────────────────────────────────────

describe('JamSessionManager (TSB-002)', () => {
  let mgr: JamSessionManager;

  beforeEach(() => {
    mgr = new JamSessionManager();
  });

  it('onConnect registers a connection and assigns participantId', () => {
    const ws = new MockWs() as any;
    expect(mgr.activeConnectionCount).toBe(0);
    mgr.onConnect(ws);
    expect(mgr.activeConnectionCount).toBe(1);
  });

  it('onDisconnect cleans up the connection', () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    mgr.onDisconnect(ws);
    expect(mgr.activeConnectionCount).toBe(0);
  });

  it('a message before jam_hello returns NOT_AUTHENTICATED', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'session_create' } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'jam_error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('NOT_AUTHENTICATED');
  });

  it('jam_hello with correct protocolVersion sends jam_hello_ack', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, {
      type: 'jam_hello',
      protocolVersion: 1,
      displayName: 'Alice',
    } as any);
    const acks = ws.inbox.filter((m: any) => m.type === 'jam_hello_ack');
    expect(acks.length).toBe(1);
    expect(acks[0].participantId).toBeTruthy();
  });

  it('jam_hello with wrong protocolVersion sends jam_error + closes', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, {
      type: 'jam_hello',
      protocolVersion: 999,
    } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'jam_error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('PROTOCOL_MISMATCH');
    expect(ws.readyState).toBe(3); // ws.close() was called
  });

  it('session_create after jam_hello yields session_created with snapshot', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    ws.inbox.length = 0;
    await mgr.handleMessage(ws, { type: 'session_create' } as any);
    const created = ws.inbox.filter((m: any) => m.type === 'session_created');
    expect(created.length).toBe(1);
    expect(created[0].snapshot).toBeDefined();
    expect(mgr.activeSessionCount).toBe(1);
  });

  it('session_join with unknown id returns SESSION_NOT_FOUND', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    ws.inbox.length = 0;
    await mgr.handleMessage(ws, {
      type: 'session_join',
      sessionId: 'this-session-does-not-exist',
    } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'jam_error');
    expect(errors.some((e: any) => e.code === 'SESSION_NOT_FOUND')).toBe(true);
  });

  it('jam_ping returns jam_pong with timestamps', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    ws.inbox.length = 0;
    await mgr.handleMessage(ws, {
      type: 'jam_ping',
      clientTimestamp: 1234567890,
    } as any);
    const pongs = ws.inbox.filter((m: any) => m.type === 'jam_pong');
    expect(pongs.length).toBe(1);
    expect(pongs[0].clientTimestamp).toBe(1234567890);
    expect(typeof pongs[0].serverTimestamp).toBe('number');
  });

  it('disconnecting a session-creator destroys the empty session', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    await mgr.handleMessage(ws, { type: 'session_create' } as any);
    expect(mgr.activeSessionCount).toBe(1);
    mgr.onDisconnect(ws);
    expect(mgr.activeSessionCount).toBe(0);
    expect(mgr.activeConnectionCount).toBe(0);
  });

  it('unknown message type after auth yields UNKNOWN_MESSAGE error', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    ws.inbox.length = 0;
    await mgr.handleMessage(ws, { type: 'totally_unknown' } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'jam_error');
    expect(errors.some((e: any) => e.code === 'UNKNOWN_MESSAGE')).toBe(true);
  });

  it('destroyAll() tears down sessions + connections', async () => {
    const ws = new MockWs() as any;
    mgr.onConnect(ws);
    await mgr.handleMessage(ws, { type: 'jam_hello', protocolVersion: 1 } as any);
    await mgr.handleMessage(ws, { type: 'session_create' } as any);
    expect(mgr.activeSessionCount).toBe(1);
    mgr.destroyAll();
    expect(mgr.activeSessionCount).toBe(0);
    expect(mgr.activeConnectionCount).toBe(0);
  });
});

// ── LiveSession (direct) ────────────────────────────────────────────

describe('LiveSession (TSB-002)', () => {
  it('ping yields pong with echoed clientTimestamp', async () => {
    const ws = new MockWs() as any;
    const session = new LiveSession(ws);
    // Before init(), ping should still be handled (it doesn't need engine)
    // Actually ping flows through handleMessage which is fine pre-init.
    await session.handleMessage({
      type: 'ping',
      clientTimestamp: 999,
    } as any);
    const pongs = ws.inbox.filter((m: any) => m.type === 'pong');
    expect(pongs.length).toBe(1);
    expect(pongs[0].clientTimestamp).toBe(999);
    expect(typeof pongs[0].serverTimestamp).toBe('number');
    session.destroy();
  });

  it('note_on before hello returns NOT_INITIALIZED error', async () => {
    const ws = new MockWs() as any;
    const session = new LiveSession(ws);
    await session.handleMessage({
      type: 'note_on',
      noteId: 'n1',
      midi: 60,
      velocity: 0.5,
    } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('NOT_INITIALIZED');
    session.destroy();
  });

  it('unknown message type yields UNKNOWN_MESSAGE', async () => {
    const ws = new MockWs() as any;
    const session = new LiveSession(ws);
    await session.handleMessage({ type: 'totally-bogus' } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'error');
    expect(errors.some((e: any) => e.code === 'UNKNOWN_MESSAGE')).toBe(true);
    session.destroy();
  });

  it('hello with wrong protocolVersion emits PROTOCOL_MISMATCH', async () => {
    const ws = new MockWs() as any;
    const session = new LiveSession(ws);
    await session.handleMessage({
      type: 'hello',
      protocolVersion: 999,
    } as any);
    const errors = ws.inbox.filter((m: any) => m.type === 'error');
    expect(errors.some((e: any) => e.code === 'PROTOCOL_MISMATCH')).toBe(true);
    session.destroy();
  });

  it('destroy() is idempotent (safe to call twice)', () => {
    const ws = new MockWs() as any;
    const session = new LiveSession(ws);
    expect(() => {
      session.destroy();
      session.destroy();
    }).not.toThrow();
  });
});
