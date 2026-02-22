/** Public API: lyrics text → PhonemeEvent[] with timbre hints. */

import { VocalNote, PhonemeEvent } from '../types/score.js';
import { ParsedPhoneme, getTimbreHint } from './arpabet.js';
import { textToPhonemes, WordPhonemes } from './g2p.js';
import { syllabify, Syllable, formatSyllables } from './syllabify.js';

export { tokenizeLyrics, lookupWord, fallbackG2P, textToPhonemes } from './g2p.js';
export { syllabify, formatSyllables } from './syllabify.js';
export { stripStress, parsePhoneme, parsePronunciation, getTimbreHint, getVowelBlendWeights, VOWEL_TO_TIMBRE, VOWEL_BLEND_WEIGHTS } from './arpabet.js';
export type { ParsedPhoneme, TimbreBlendWeights } from './arpabet.js';
export type { Syllable } from './syllabify.js';
export type { WordPhonemes } from './g2p.js';

export interface PhonemizeResult {
  events: PhonemeEvent[];
  words: WordPhonemes[];
  syllables: Syllable[][];
  warnings: string[];
}

const MIN_CONSONANT_SEC = 0.005;
const MAX_CONSONANT_SEC = 0.080;
const CONSONANT_FRACTION = 0.06; // per-consonant share of note duration
const MAX_EDGE_FRACTION = 0.30;  // onset+coda can't exceed 30% each

const PLOSIVES = new Set(['P', 'T', 'K', 'B', 'D', 'G', 'Q']);
const AFFRICATES = new Set(['CH', 'JH']);
const FRICATIVES = new Set(['F', 'V', 'S', 'Z', 'SH', 'ZH', 'TH', 'DH', 'HH']);

function getConsonantStrength(symbol: string): number {
  if (PLOSIVES.has(symbol)) return 0.9;
  if (AFFRICATES.has(symbol)) return 0.7;
  if (FRICATIVES.has(symbol)) return 0.5;
  return 0.2; // nasals, liquids, glides
}

function clampConsonantDur(noteDur: number): number {
  return Math.min(MAX_CONSONANT_SEC, Math.max(MIN_CONSONANT_SEC, noteDur * CONSONANT_FRACTION));
}

/**
 * Convert lyrics text into PhonemeEvents aligned to notes.
 *
 * Syllable-to-note alignment: all words are G2P'd and syllabified,
 * then the flat syllable list maps 1:1 to the note list. Within each
 * note, onset consonants cluster at start, vowel holds, coda at end.
 */
export function phonemizeLyrics(lyricsText: string, notes: VocalNote[]): PhonemizeResult {
  const words = textToPhonemes(lyricsText);
  const warnings: string[] = [];
  const allSyllables: Syllable[][] = [];

  // Flatten all syllables across all words
  const flatSyllables: Syllable[] = [];
  for (const wp of words) {
    if (wp.source === 'fallback') {
      warnings.push(`"${wp.word}" not in dictionary — using fallback`);
    }
    const syls = syllabify(wp.phonemes);
    allSyllables.push(syls);
    flatSyllables.push(...syls);
  }

  // Syllable-to-note alignment
  if (flatSyllables.length > notes.length) {
    warnings.push(`More syllables (${flatSyllables.length}) than notes (${notes.length}); ${flatSyllables.length - notes.length} syllable(s) dropped`);
  }

  const allEvents: PhonemeEvent[] = [];
  const count = Math.min(flatSyllables.length, notes.length);

  for (let si = 0; si < count; si++) {
    allEvents.push(...distributeSyllable(flatSyllables[si], notes[si].startSec, notes[si].durationSec));
  }

  return { events: allEvents, words, syllables: allSyllables, warnings };
}

/**
 * Distribute a single syllable within a note's time window.
 *
 * Layout: [onset consonants] [vowel nucleus] [coda consonants]
 * The vowel stretches to fill — this is what "holds" on sustained notes.
 */
function distributeSyllable(syl: Syllable, noteStart: number, noteDur: number): PhonemeEvent[] {
  const events: PhonemeEvent[] = [];
  const consDur = clampConsonantDur(noteDur);

  // Cap onset total at 30% of note
  const onsetCount = syl.onset.length;
  const maxOnsetTime = noteDur * MAX_EDGE_FRACTION;
  const onsetPerCons = onsetCount > 0 ? Math.min(consDur, maxOnsetTime / onsetCount) : 0;
  const totalOnsetTime = onsetPerCons * onsetCount;

  // Cap coda total at 30% of note
  const codaCount = syl.coda.length;
  const maxCodaTime = noteDur * MAX_EDGE_FRACTION;
  const codaPerCons = codaCount > 0 ? Math.min(consDur, maxCodaTime / codaCount) : 0;
  const totalCodaTime = codaPerCons * codaCount;

  // Vowel gets everything in between
  const vowelDur = Math.max(0, noteDur - totalOnsetTime - totalCodaTime);

  let t = noteStart;

  // Onset consonants
  for (const p of syl.onset) {
    events.push({
      tSec: t,
      durSec: onsetPerCons,
      phoneme: p.symbol,
      kind: 'consonant',
      strength: getConsonantStrength(p.symbol),
    });
    t += onsetPerCons;
  }

  // Vowel nucleus
  events.push({
    tSec: t,
    durSec: vowelDur,
    phoneme: syl.nucleus.symbol,
    kind: 'vowel',
    timbreHint: getTimbreHint(syl.nucleus),
  });
  t += vowelDur;

  // Coda consonants
  for (const p of syl.coda) {
    events.push({
      tSec: t,
      durSec: codaPerCons,
      phoneme: p.symbol,
      kind: 'consonant',
      strength: getConsonantStrength(p.symbol),
    });
    t += codaPerCons;
  }

  return events;
}
