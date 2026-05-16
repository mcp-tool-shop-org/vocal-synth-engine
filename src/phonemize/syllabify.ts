/** Syllabification using the Maximal Onset Principle. */

import { ParsedPhoneme } from './arpabet.js';

export interface Syllable {
  onset: ParsedPhoneme[];    // leading consonants
  nucleus: ParsedPhoneme;    // the vowel
  coda: ParsedPhoneme[];     // trailing consonants
}

// Legal 2-consonant onsets in English
const LEGAL_ONSETS_2 = new Set([
  'P L', 'P R', 'B L', 'B R', 'T R', 'D R', 'K L', 'K R',
  'G L', 'G R', 'F L', 'F R', 'TH R', 'SH R',
  'S K', 'S L', 'S M', 'S N', 'S P', 'S T', 'S W',
]);

const LEGAL_ONSETS_3 = new Set([
  'S P L', 'S P R', 'S T R', 'S K R', 'S K W',
]);

function isLegalOnset(consonants: ParsedPhoneme[]): boolean {
  if (consonants.length <= 1) return true;
  const key = consonants.map(c => c.symbol).join(' ');
  if (consonants.length === 2) return LEGAL_ONSETS_2.has(key);
  if (consonants.length === 3) return LEGAL_ONSETS_3.has(key);
  return false;
}

/**
 * Split an intervocalic consonant cluster into [coda, onset].
 * Maximal Onset: give as many consonants to the onset as legal.
 */
export function splitCluster(cluster: ParsedPhoneme[]): [number, number] {
  const n = cluster.length;
  if (n === 0) return [0, 0];

  for (let onsetStart = 0; onsetStart < n; onsetStart++) {
    if (isLegalOnset(cluster.slice(onsetStart))) {
      return [onsetStart, n - onsetStart];
    }
  }
  return [n, 0];
}

/**
 * Syllabify a phoneme sequence.
 *
 * 1. Find all vowel nuclei
 * 2. Split intervocalic consonant clusters using Maximal Onset
 * 3. Leading consonants → first syllable onset
 * 4. Trailing consonants → last syllable coda
 */
export function syllabify(phonemes: ParsedPhoneme[]): Syllable[] {
  const vowelIndices: number[] = [];
  for (let i = 0; i < phonemes.length; i++) {
    if (phonemes[i].kind === 'vowel') vowelIndices.push(i);
  }
  if (vowelIndices.length === 0) return [];

  const syllables: Syllable[] = new Array(vowelIndices.length);

  for (let vi = 0; vi < vowelIndices.length; vi++) {
    const nucleusIdx = vowelIndices[vi];
    let onset: ParsedPhoneme[];
    let coda: ParsedPhoneme[];

    if (vi === 0) {
      // First syllable: all consonants before first vowel
      onset = phonemes.slice(0, nucleusIdx);
    } else {
      // Onset was assigned by previous iteration
      onset = syllables[vi]?.onset ?? [];
    }

    if (vi === vowelIndices.length - 1) {
      // Last syllable: everything after last vowel
      coda = phonemes.slice(nucleusIdx + 1);
    } else {
      const nextVowelIdx = vowelIndices[vi + 1];
      const cluster = phonemes.slice(nucleusIdx + 1, nextVowelIdx);
      const [codaCount] = splitCluster(cluster);
      coda = cluster.slice(0, codaCount);
      const nextOnset = cluster.slice(codaCount);

      // Pre-assign onset for next syllable
      if (!syllables[vi + 1]) {
        syllables[vi + 1] = { onset: nextOnset, nucleus: null!, coda: [] };
      } else {
        syllables[vi + 1].onset = nextOnset;
      }
    }

    if (syllables[vi]) {
      syllables[vi].nucleus = phonemes[nucleusIdx];
      syllables[vi].coda = coda;
    } else {
      syllables[vi] = { onset, nucleus: phonemes[nucleusIdx], coda };
    }
  }

  return syllables;
}

/** Pretty-print syllables: "HH AH . L OW" */
export function formatSyllables(syllables: Syllable[]): string {
  return syllables
    .map(s => [...s.onset, s.nucleus, ...s.coda].map(p => p.symbol).join(' '))
    .join(' . ');
}
