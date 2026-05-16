/**
 * Runtime Zod schema for VocalScore — closes T-009.
 *
 * Until this file existed, callers parsed score JSON with JSON.parse and
 * type-asserted to `VocalScore`. Malformed inputs (missing notes, non-numeric
 * startSec, NaN, Infinity, negative durations, MIDI out-of-range) silently
 * propagated into the synth engine, where they produced NaN audio or
 * out-of-bounds writes.
 *
 * The schema mirrors `src/types/score.ts` exactly. Field-level constraints
 * forbid NaN/Infinity on all numerics and enforce non-negative startSec /
 * positive durationSec / MIDI 0..127. Failure messages are intentionally
 * verbose so the calling CLI / server route can surface them to the user.
 */
import { z } from 'zod';

// `z.number()` accepts NaN; the .finite() refinement is the only way to
// reject NaN and ±Infinity through Zod. Use it everywhere a number is parsed
// from JSON. (`z.number().finite()` is short enough we don't bother with a
// helper.)

const FiniteNumber = z.number().finite();

const VibratoSchema = z.object({
  rateHz: FiniteNumber.nonnegative(),
  depthCents: FiniteNumber.nonnegative(),
  onsetSec: FiniteNumber.nonnegative(),
});

const VocalNoteSchema = z.object({
  id: z.string().min(1),
  startSec: FiniteNumber.nonnegative(),
  durationSec: FiniteNumber.positive(),
  midi: FiniteNumber.min(0).max(127),
  velocity: FiniteNumber.min(0).max(1).optional(),
  timbre: z.string().min(1).optional(),
  vibrato: VibratoSchema.optional(),
  portamentoSec: FiniteNumber.nonnegative().optional(),
});

const PhonemeEventSchema = z.object({
  tSec: FiniteNumber.nonnegative(),
  durSec: FiniteNumber.positive(),
  phoneme: z.string().min(1),
  kind: z.enum(['vowel', 'consonant']),
  timbreHint: z.string().min(1).optional(),
  strength: FiniteNumber.min(0).max(1).optional(),
});

const AutomationPointSchema = z.object({
  tSec: FiniteNumber.nonnegative(),
  value: FiniteNumber,
});

const LyricsSchema = z.object({
  text: z.string(),
  language: z.string().min(1).optional(),
});

const LanesSchema = z.object({
  dynamics: z.array(AutomationPointSchema).optional(),
  breathiness: z.array(AutomationPointSchema).optional(),
  // timbreMorph maps timbre IDs to automation curves.
  timbreMorph: z.record(z.string(), z.array(AutomationPointSchema)).optional(),
});

export const VocalScoreSchema = z.object({
  bpm: FiniteNumber.positive(),
  notes: z.array(VocalNoteSchema),
  lyrics: LyricsSchema.optional(),
  phonemes: z.array(PhonemeEventSchema).optional(),
  lanes: LanesSchema.optional(),
});

export type VocalScoreParsed = z.infer<typeof VocalScoreSchema>;

/**
 * Parse + validate a score from raw JSON text. Throws a Zod validation error
 * with a list of field paths + reasons on invalid input. Use this in place of
 * `JSON.parse(content) as VocalScore` at trust boundaries.
 *
 * The thrown error keeps Zod's own message text (no rewrapping) so callers
 * can render either `err.message` (concise) or `err.issues` (structured).
 */
export function parseVocalScore(jsonText: string): VocalScoreParsed {
  const raw = JSON.parse(jsonText);
  return VocalScoreSchema.parse(raw);
}
