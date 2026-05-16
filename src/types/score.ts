export type TimbreId = string;

export interface VocalNote {
  id: string;
  startSec: number;
  durationSec: number;
  midi: number;           // pitch target
  velocity?: number;      // 0..1 maps to amplitude
  timbre?: TimbreId;      // default if omitted
  vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
  portamentoSec?: number; // glide into this note
}

/** A single phoneme event on the lyric timeline. */
export interface PhonemeEvent {
  tSec: number;           // absolute start time
  durSec: number;         // duration in seconds
  phoneme: string;        // ARPAbet symbol (e.g. "AH", "IY", "K", "S")
  kind: 'vowel' | 'consonant';
  timbreHint?: TimbreId;  // for vowels: which preset timbre to activate
  strength?: number;      // for consonants: noise burst intensity 0..1
}

export interface AutomationPoint {
  tSec: number;
  value: number;          // normalized unless otherwise specified
}

export interface VocalScore {
  /**
   * Score format version (TB-010). Optional in the runtime schema for
   * backward-compat (missing → '1.0.0' default). Engine refuses any value
   * not in `SUPPORTED_SCORE_VERSIONS` (src/types/scoreSchema.ts) with
   * `UNSUPPORTED_SCORE_VERSION` so a v2 score on a v1 engine fails loud
   * instead of silently dropping new required fields.
   */
  formatVersion?: string;
  bpm: number;
  notes: VocalNote[];
  lyrics?: {
    text: string;         // raw lyric text (e.g. "la la la")
    language?: string;    // BCP-47 tag (default "en-US")
  };
  phonemes?: PhonemeEvent[]; // optional manual override of auto-phonemization
  lanes?: {
    dynamics?: AutomationPoint[];      // 0..1
    breathiness?: AutomationPoint[];   // 0..1
    timbreMorph?: Record<TimbreId, AutomationPoint[]>; // weights
  };
}

// Runtime Zod validation lives in ./scoreSchema. Re-export it from here so
// new callers can pull both the type and the validator from a single import.
// (Closes T-009: parse + validate before JSON.parse-and-pray.)
export { VocalScoreSchema, parseVocalScore, SUPPORTED_SCORE_VERSIONS } from './scoreSchema.js';
export type { VocalScoreParsed } from './scoreSchema.js';
