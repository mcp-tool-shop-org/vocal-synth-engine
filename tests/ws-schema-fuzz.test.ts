/**
 * WebSocket Zod schema fuzz tests — Stage C TSB-002 + TSB-007 closer.
 *
 * src/server/services/wsSchemas.ts ships 287 lines of discriminated-union
 * zod schemas covering every WS message type (hello / transport / note_on /
 * note_off / param_update / timbre_morph / ping for /ws; jam_hello /
 * session_create / session_join / track_add / etc for /ws/jam). Pre-Stage-C
 * these had ZERO direct test coverage — the schemas are load-bearing
 * (S-013 closed the trust-the-cast hole at the routing layer) yet a
 * regression that loosened a refine or dropped a `.strict()` would ship
 * silently green.
 *
 * Each describe block: one positive (valid payload parses) + a parametrized
 * boundary table (NaN / Infinity / out-of-range / empty / oversized
 * strings / wrong types / discriminator absent / unknown discriminator).
 *
 * The test contract is the schema's CURRENT behaviour, not a future
 * tightening; loosening any of these bounds is a deliberate change that
 * the operator must surface in the commit message.
 */

import { describe, it, expect } from 'vitest';
import {
  liveClientMessageSchema,
  jamClientMessageSchema,
} from '../src/server/services/wsSchemas.js';

// ── /ws (LiveSession) ──────────────────────────────────────────────

describe('wsSchemas — liveClientMessageSchema (TSB-007)', () => {
  describe('hello', () => {
    it('valid hello parses', () => {
      const r = liveClientMessageSchema.safeParse({
        type: 'hello',
        protocolVersion: 1,
      });
      expect(r.success).toBe(true);
    });

    it.each([
      { protocolVersion: -1 },
      { protocolVersion: 1001 },
      { protocolVersion: 1.5 },
      { protocolVersion: NaN },
      { protocolVersion: 'one' },
      { protocolVersion: null },
    ])('hello rejects invalid protocolVersion %o', (extra) => {
      const r = liveClientMessageSchema.safeParse({ type: 'hello', ...extra });
      expect(r.success).toBe(false);
    });
  });

  describe('note_on', () => {
    const valid = {
      type: 'note_on',
      noteId: 'n1',
      midi: 60,
      velocity: 0.5,
    };

    it('valid note_on parses', () => {
      const r = liveClientMessageSchema.safeParse(valid);
      expect(r.success).toBe(true);
    });

    it('valid note_on with optional vibrato parses', () => {
      const r = liveClientMessageSchema.safeParse({
        ...valid,
        vibrato: { rateHz: 5, depthCents: 50, onsetSec: 0.1 },
        breathiness: 0.3,
        portamentoMs: 100,
        timbre: 'AH',
      });
      expect(r.success).toBe(true);
    });

    it.each([
      { ...valid, midi: -1 },
      { ...valid, midi: 128 },
      { ...valid, midi: NaN },
      { ...valid, midi: Infinity },
      { ...valid, midi: 60.5 }, // midi must be int
      { ...valid, velocity: NaN },
      { ...valid, velocity: -0.01 },
      { ...valid, velocity: 1.01 },
      { ...valid, velocity: Infinity },
      { ...valid, breathiness: Infinity },
      { ...valid, breathiness: -0.5 },
      { ...valid, breathiness: 1.5 },
      { ...valid, noteId: '' },
      { ...valid, noteId: 'x'.repeat(129) },
      { ...valid, portamentoMs: -1 },
      { ...valid, portamentoMs: 10_001 },
      { ...valid, vibrato: { rateHz: 51, depthCents: 50, onsetSec: 0 } },
      { ...valid, vibrato: { rateHz: 5, depthCents: 1201, onsetSec: 0 } },
      { ...valid, vibrato: { rateHz: -1, depthCents: 50, onsetSec: 0 } },
    ])('note_on rejects %o', (payload) => {
      const r = liveClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('note_off', () => {
    it('valid note_off parses', () => {
      const r = liveClientMessageSchema.safeParse({
        type: 'note_off',
        noteId: 'n1',
      });
      expect(r.success).toBe(true);
    });

    it('valid note_off with releaseMs parses', () => {
      const r = liveClientMessageSchema.safeParse({
        type: 'note_off',
        noteId: 'n1',
        releaseMs: 500,
      });
      expect(r.success).toBe(true);
    });

    it.each([
      { type: 'note_off', noteId: '' },
      { type: 'note_off', noteId: 'x'.repeat(129) },
      { type: 'note_off', noteId: 'n1', releaseMs: -1 },
      { type: 'note_off', noteId: 'n1', releaseMs: 10_001 },
      { type: 'note_off', noteId: 'n1', releaseMs: NaN },
    ])('note_off rejects %o', (payload) => {
      const r = liveClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('transport', () => {
    it('valid transport play parses', () => {
      const r = liveClientMessageSchema.safeParse({
        type: 'transport',
        command: 'play',
      });
      expect(r.success).toBe(true);
    });

    it.each([
      { type: 'transport', command: 'invalid' },
      { type: 'transport' /* missing command */ },
      { type: 'transport', command: 'play', bpm: 19 },
      { type: 'transport', command: 'play', bpm: 401 },
      { type: 'transport', command: 'play', bpm: NaN },
      { type: 'transport', command: 'play', bpm: Infinity },
    ])('transport rejects %o', (payload) => {
      const r = liveClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('discriminator integrity', () => {
    it('rejects missing type field', () => {
      const r = liveClientMessageSchema.safeParse({ noteId: 'n1', midi: 60 });
      expect(r.success).toBe(false);
    });

    it('rejects unknown type value', () => {
      const r = liveClientMessageSchema.safeParse({
        type: 'definitely_not_a_real_message_type',
      });
      expect(r.success).toBe(false);
    });

    it('rejects null payload', () => {
      const r = liveClientMessageSchema.safeParse(null);
      expect(r.success).toBe(false);
    });

    it('rejects non-object payload', () => {
      const r = liveClientMessageSchema.safeParse('hello');
      expect(r.success).toBe(false);
    });
  });
});

// ── /ws/jam (JamSessionManager) ────────────────────────────────────

describe('wsSchemas — jamClientMessageSchema (TSB-002 / S-012 / S-013)', () => {
  describe('jam_hello', () => {
    it('valid jam_hello parses', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'jam_hello',
        protocolVersion: 1,
      });
      expect(r.success).toBe(true);
    });

    it('valid jam_hello with displayName parses', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'jam_hello',
        protocolVersion: 1,
        displayName: 'Player One',
      });
      expect(r.success).toBe(true);
    });

    it('rejects displayName over 64 chars', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'jam_hello',
        protocolVersion: 1,
        displayName: 'x'.repeat(65),
      });
      expect(r.success).toBe(false);
    });
  });

  describe('session_create (S-012 — bounded resource sizes)', () => {
    it('valid session_create with defaults parses', () => {
      const r = jamClientMessageSchema.safeParse({ type: 'session_create' });
      expect(r.success).toBe(true);
    });

    it('valid session_create with all params parses', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'session_create',
        bpm: 120,
        timeSig: { num: 4, den: 4 },
        blockSize: 512,
        seed: 42,
      });
      expect(r.success).toBe(true);
    });

    it.each([
      // S-012: blockSize MUST be one of the closed allow-list. A bogus
      // blockSize=10_000_000 used to make JamSession Buffer.alloc(40 MB).
      { type: 'session_create', blockSize: 10_000_000 },
      { type: 'session_create', blockSize: 100 },
      { type: 'session_create', blockSize: 4096 },
      { type: 'session_create', blockSize: NaN },
      // bpm bounds
      { type: 'session_create', bpm: 19 },
      { type: 'session_create', bpm: 401 },
      { type: 'session_create', bpm: NaN },
      { type: 'session_create', bpm: Infinity },
      // timeSig bounds
      { type: 'session_create', timeSig: { num: 0, den: 4 } },
      { type: 'session_create', timeSig: { num: 33, den: 4 } },
      { type: 'session_create', timeSig: { num: 4, den: 5 } }, // den not in {1,2,4,8,16,32}
      { type: 'session_create', timeSig: { num: 4, den: 0 } },
      // seed bounds (int32 range)
      { type: 'session_create', seed: 2_147_483_648 },
      { type: 'session_create', seed: -2_147_483_649 },
      { type: 'session_create', seed: 1.5 },
      { type: 'session_create', seed: NaN },
    ])('session_create rejects %o', (payload) => {
      const r = jamClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('session_join', () => {
    it('valid session_join parses', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'session_join',
        sessionId: 'abc123',
      });
      expect(r.success).toBe(true);
    });

    it.each([
      { type: 'session_join', sessionId: '' },
      { type: 'session_join', sessionId: 'x'.repeat(65) },
      { type: 'session_join', sessionId: '../traversal' }, // contains /
      { type: 'session_join', sessionId: 'has space' },
      { type: 'session_join', sessionId: 'has.dot' },
      { type: 'session_join' /* missing */ },
    ])('session_join rejects %o', (payload) => {
      const r = jamClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('track_note_on', () => {
    const valid = {
      type: 'track_note_on',
      trackId: 'track1',
      noteId: 'n1',
      midi: 60,
      velocity: 0.7,
    };

    it('valid track_note_on parses', () => {
      const r = jamClientMessageSchema.safeParse(valid);
      expect(r.success).toBe(true);
    });

    it.each([
      { ...valid, trackId: '' },
      { ...valid, trackId: 'x'.repeat(65) },
      { ...valid, trackId: '../path' },
      { ...valid, midi: -1 },
      { ...valid, midi: 128 },
      { ...valid, velocity: 1.01 },
      { ...valid, velocity: NaN },
      { ...valid, noteId: '' },
    ])('track_note_on rejects %o', (payload) => {
      const r = jamClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('session_set_quantize (closed enum)', () => {
    it('accepts each valid grid', () => {
      for (const grid of ['none', '1/4', '1/8', '1/16', '1/32']) {
        const r = jamClientMessageSchema.safeParse({
          type: 'session_set_quantize',
          grid,
        });
        expect(r.success).toBe(true);
      }
    });

    it.each([
      { type: 'session_set_quantize', grid: '1/3' },
      { type: 'session_set_quantize', grid: '1/64' },
      { type: 'session_set_quantize', grid: 'half' },
      { type: 'session_set_quantize', grid: '' },
      { type: 'session_set_quantize' /* missing */ },
    ])('rejects %o', (payload) => {
      const r = jamClientMessageSchema.safeParse(payload);
      expect(r.success).toBe(false);
    });
  });

  describe('discriminator integrity', () => {
    it('rejects unknown type value', () => {
      const r = jamClientMessageSchema.safeParse({
        type: 'definitely_not_a_jam_message',
      });
      expect(r.success).toBe(false);
    });

    it('rejects missing type field', () => {
      const r = jamClientMessageSchema.safeParse({ trackId: 't' });
      expect(r.success).toBe(false);
    });
  });
});
