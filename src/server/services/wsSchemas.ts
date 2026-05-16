/**
 * Zod schemas for every WebSocket client message variant.
 *
 * S-013 — runtime validation BEFORE the message handler switches on
 * msg.type.  Closes the trust-the-cast hole where JSON.parse output was
 * cast straight to ClientMessage / JamClientMessage and every field was
 * implicitly trusted.
 *
 * S-012 — session_create payload is validated against the closed allowed
 * sets for blockSize / bpm / seed / timeSig so an attacker cannot make the
 * server attempt a multi-GB Buffer.alloc.
 */
import { z } from 'zod';

// ── Shared primitives ──────────────────────────────────────────────

const midiSchema = z.number().int().min(0).max(127);
const velocitySchema = z.number().finite().min(0).max(1);
const breathinessSchema = z.number().finite().min(0).max(1);
const portamentoMsSchema = z.number().finite().min(0).max(10_000);

const vibratoSchema = z
  .object({
    rateHz: z.number().finite().min(0).max(50),
    depthCents: z.number().finite().min(0).max(1200),
    onsetSec: z.number().finite().min(0).max(60),
  })
  .strict();

const noteIdSchema = z.string().min(1).max(128);
const trackIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'trackId must be [A-Za-z0-9_-]');

const timbreSchema = z.string().min(1).max(64);
const presetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'presetId must match /^[A-Za-z0-9_-]+$/');

// ── /ws (LiveSession) — ClientMessage ──────────────────────────────

const liveHello = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().min(0).max(1_000),
});

const liveTransport = z.object({
  type: z.literal('transport'),
  command: z.enum(['play', 'stop', 'panic']),
  bpm: z.number().finite().min(20).max(400).optional(),
});

const liveNoteOn = z.object({
  type: z.literal('note_on'),
  noteId: noteIdSchema,
  midi: midiSchema,
  velocity: velocitySchema,
  timbre: timbreSchema.optional(),
  breathiness: breathinessSchema.optional(),
  vibrato: vibratoSchema.optional(),
  portamentoMs: portamentoMsSchema.optional(),
});

const liveNoteOff = z.object({
  type: z.literal('note_off'),
  noteId: noteIdSchema,
  releaseMs: z.number().finite().min(0).max(10_000).optional(),
});

const liveParamUpdate = z.object({
  type: z.literal('param_update'),
  maxPolyphony: z.number().int().min(1).max(64).optional(),
  rngSeed: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  defaultTimbre: timbreSchema.optional(),
  presetId: presetIdSchema.optional(),
  blockSize: z
    .number()
    .int()
    .refine((v) => [128, 256, 512, 1024, 2048].includes(v))
    .optional(),
  limiter: z.boolean().optional(),
});

const liveRecordStart = z.object({ type: z.literal('record_start') });
const liveRecordStop = z.object({
  type: z.literal('record_stop'),
  name: z.string().min(1).max(200).optional(),
});

const liveTimbreMorph = z.object({
  type: z.literal('timbre_morph'),
  weights: z.record(z.string().max(64), z.number().finite()),
});

const livePing = z.object({
  type: z.literal('ping'),
  clientTimestamp: z.number().finite(),
});

export const liveClientMessageSchema = z.discriminatedUnion('type', [
  liveHello,
  liveTransport,
  liveNoteOn,
  liveNoteOff,
  liveParamUpdate,
  liveRecordStart,
  liveRecordStop,
  liveTimbreMorph,
  livePing,
]);

// ── /ws/jam (JamSessionManager) — JamClientMessage ─────────────────

const timeSigSchema = z
  .object({
    num: z.number().int().min(1).max(32),
    den: z.number().int().refine((v) => [1, 2, 4, 8, 16, 32].includes(v)),
  })
  .strict();

const jamHello = z.object({
  type: z.literal('jam_hello'),
  protocolVersion: z.number().int().min(0).max(1_000),
  displayName: z.string().min(1).max(64).optional(),
});

// S-012: blockSize MUST be one of {128,256,512,1024,2048}; bpm in (20,400),
// seed in safe int range; timeSig.num/den bounded.  These bounds are
// applied BEFORE constructing JamSession, which otherwise would try to
// Buffer.alloc(16 + blockSize * 4).
const jamSessionCreate = z.object({
  type: z.literal('session_create'),
  bpm: z.number().finite().min(20).max(400).optional(),
  timeSig: timeSigSchema.optional(),
  blockSize: z
    .number()
    .int()
    .refine((v) => [128, 256, 512, 1024, 2048].includes(v), {
      message: 'blockSize must be one of 128, 256, 512, 1024, 2048',
    })
    .optional(),
  seed: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
});

const jamSessionJoin = z.object({
  type: z.literal('session_join'),
  sessionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

const jamSessionLeave = z.object({ type: z.literal('session_leave') });

const jamTransportSet = z.object({
  type: z.literal('transport_set'),
  bpm: z.number().finite().min(20).max(400).optional(),
  timeSig: timeSigSchema.optional(),
  loopEnabled: z.boolean().optional(),
  loopStartSec: z.number().finite().min(0).max(3600).optional(),
  loopEndSec: z.number().finite().min(0).max(3600).optional(),
});

const jamTransportPlay = z.object({ type: z.literal('transport_play') });
const jamTransportStop = z.object({ type: z.literal('transport_stop') });
const jamTransportSeek = z.object({
  type: z.literal('transport_seek'),
  positionSec: z.number().finite().min(0).max(3600),
});

const jamTrackAdd = z.object({
  type: z.literal('track_add'),
  name: z.string().min(1).max(120).optional(),
  presetId: presetIdSchema,
  defaultTimbre: timbreSchema.optional(),
  polyphonyLimit: z.number().int().min(1).max(64).optional(),
  gain: z.number().finite().min(0).max(2).optional(),
  inputMode: z.enum(['live', 'score', 'agent']).optional(),
});

const jamTrackRemove = z.object({
  type: z.literal('track_remove'),
  trackId: trackIdSchema,
});

const jamTrackUpdate = z.object({
  type: z.literal('track_update'),
  trackId: trackIdSchema,
  name: z.string().min(1).max(120).optional(),
  gain: z.number().finite().min(0).max(2).optional(),
  pan: z.number().finite().min(-1).max(1).optional(),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  polyphonyLimit: z.number().int().min(1).max(64).optional(),
  defaultTimbre: timbreSchema.optional(),
  inputMode: z.enum(['live', 'score', 'agent']).optional(),
});

const jamTrackNoteOn = z.object({
  type: z.literal('track_note_on'),
  trackId: trackIdSchema,
  noteId: noteIdSchema,
  midi: midiSchema,
  velocity: velocitySchema,
  timbre: timbreSchema.optional(),
  breathiness: breathinessSchema.optional(),
  vibrato: vibratoSchema.optional(),
  portamentoMs: portamentoMsSchema.optional(),
});

const jamTrackNoteOff = z.object({
  type: z.literal('track_note_off'),
  trackId: trackIdSchema,
  noteId: noteIdSchema,
  releaseMs: z.number().finite().min(0).max(10_000).optional(),
});

const jamPing = z.object({
  type: z.literal('jam_ping'),
  clientTimestamp: z.number().finite(),
});

const jamSetQuantize = z.object({
  type: z.literal('session_set_quantize'),
  grid: z.enum(['none', '1/4', '1/8', '1/16', '1/32']),
});

const jamRecordStart = z.object({ type: z.literal('record_start') });
const jamRecordStop = z.object({ type: z.literal('record_stop') });
const jamRecordExport = z.object({
  type: z.literal('record_export'),
  name: z.string().min(1).max(200).optional(),
});

const jamMetronomeToggle = z.object({ type: z.literal('metronome_toggle') });

// Score is bounded by the same shape used at /api/render; re-define a
// trimmed version here to keep this module self-contained.
const jamNote = z
  .object({
    id: z.string().min(1).max(128),
    startSec: z.number().finite().min(0).max(3600),
    durationSec: z.number().finite().min(0.001).max(3600),
    midi: midiSchema,
    velocity: velocitySchema.optional(),
    timbre: timbreSchema.optional(),
    vibrato: vibratoSchema.optional(),
    portamentoSec: z.number().finite().min(0).max(10).optional(),
  })
  .passthrough();

const jamScore = z
  .object({
    bpm: z.number().finite().min(20).max(400),
    notes: z.array(jamNote).max(10_000),
  })
  .passthrough();

const jamTrackSetScore = z.object({
  type: z.literal('track_set_score'),
  trackId: trackIdSchema,
  score: jamScore,
});

export const jamClientMessageSchema = z.discriminatedUnion('type', [
  jamHello,
  jamSessionCreate,
  jamSessionJoin,
  jamSessionLeave,
  jamTransportSet,
  jamTransportPlay,
  jamTransportStop,
  jamTransportSeek,
  jamTrackAdd,
  jamTrackRemove,
  jamTrackUpdate,
  jamTrackNoteOn,
  jamTrackNoteOff,
  jamPing,
  jamSetQuantize,
  jamRecordStart,
  jamRecordStop,
  jamRecordExport,
  jamMetronomeToggle,
  jamTrackSetScore,
]);
