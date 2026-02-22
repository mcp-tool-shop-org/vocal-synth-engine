/** English grapheme-to-phoneme: CMU dictionary lookup + letter-rule fallback. */

import { dictionary } from 'cmu-pronouncing-dictionary';
import { ParsedPhoneme, parsePronunciation } from './arpabet.js';

/** Tokenize lyrics text into pronounceable words. */
export function tokenizeLyrics(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/** Look up a word in the CMU dictionary. Returns null if not found. */
export function lookupWord(word: string): ParsedPhoneme[] | null {
  const entry = (dictionary as Record<string, string>)[word.toLowerCase()];
  if (!entry) return null;
  return parsePronunciation(entry);
}

// ── Letter-to-Phoneme Fallback ──────────────────────────────────

const CONSONANT_DIGRAPHS: Record<string, string> = {
  'th': 'TH', 'sh': 'SH', 'ch': 'CH', 'ph': 'F',
  'wh': 'W', 'ng': 'NG', 'ck': 'K', 'gh': 'G',
};

const CONSONANT_SINGLES: Record<string, string> = {
  'b': 'B', 'c': 'K', 'd': 'D', 'f': 'F', 'g': 'G',
  'h': 'HH', 'j': 'JH', 'k': 'K', 'l': 'L', 'm': 'M',
  'n': 'N', 'p': 'P', 'r': 'R', 's': 'S', 't': 'T',
  'v': 'V', 'w': 'W', 'x': 'K', 'y': 'Y', 'z': 'Z',
};

const VOWEL_DIGRAPHS: Record<string, string> = {
  'ee': 'IY', 'ea': 'IY', 'oo': 'UW', 'ou': 'AW',
  'ai': 'EY', 'ay': 'EY', 'oi': 'OY', 'oy': 'OY',
  'ow': 'OW', 'au': 'AO',
};

const VOWEL_SINGLES: Record<string, string> = {
  'a': 'AE', 'e': 'EH', 'i': 'IH', 'o': 'AA', 'u': 'AH',
};

/**
 * Naive letter-to-phoneme rules for unknown words.
 * Covers the 80% case; digraph-first scan, silent-e, schwa fallback.
 */
export function fallbackG2P(word: string): ParsedPhoneme[] {
  const result: ParsedPhoneme[] = [];
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  let i = 0;

  const hasSilentE = w.length > 2 && w[w.length - 1] === 'e';
  const end = hasSilentE ? w.length - 1 : w.length;

  while (i < end) {
    if (i + 1 < end) {
      const di = w[i] + w[i + 1];
      if (CONSONANT_DIGRAPHS[di]) {
        result.push({ symbol: CONSONANT_DIGRAPHS[di], kind: 'consonant', stress: null });
        i += 2;
        continue;
      }
      if (VOWEL_DIGRAPHS[di]) {
        result.push({ symbol: VOWEL_DIGRAPHS[di], kind: 'vowel', stress: 0 });
        i += 2;
        continue;
      }
    }

    const ch = w[i];
    if (VOWEL_SINGLES[ch]) {
      result.push({ symbol: VOWEL_SINGLES[ch], kind: 'vowel', stress: 0 });
    } else if (CONSONANT_SINGLES[ch]) {
      result.push({ symbol: CONSONANT_SINGLES[ch], kind: 'consonant', stress: null });
    }
    i++;
  }

  if (!result.some(p => p.kind === 'vowel')) {
    result.push({ symbol: 'AH', kind: 'vowel', stress: 0 });
  }

  return result;
}

// ── Combined G2P ────────────────────────────────────────────────

export interface WordPhonemes {
  word: string;
  phonemes: ParsedPhoneme[];
  source: 'dictionary' | 'fallback';
}

/** Convert a single word to phonemes. Dict first, then fallback. */
export function wordToPhonemes(word: string): WordPhonemes {
  const dictResult = lookupWord(word);
  if (dictResult) return { word, phonemes: dictResult, source: 'dictionary' };
  return { word, phonemes: fallbackG2P(word), source: 'fallback' };
}

/** Convert full lyrics text to a sequence of WordPhonemes. */
export function textToPhonemes(text: string): WordPhonemes[] {
  return tokenizeLyrics(text).map(wordToPhonemes);
}
