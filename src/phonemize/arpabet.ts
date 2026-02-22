/** ARPAbet phoneme inventory, classification, and vowel→timbre mapping. */

export const ARPABET_VOWELS = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AX', 'AXR', 'AY',
  'EH', 'ER', 'EY',
  'IH', 'IX', 'IY',
  'OW', 'OY',
  'UH', 'UW', 'UX',
]);

export const ARPABET_CONSONANTS = new Set([
  'B', 'CH', 'D', 'DH', 'DX', 'EL', 'EM', 'EN',
  'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG',
  'NX', 'P', 'Q', 'R', 'S', 'SH', 'T', 'TH',
  'V', 'W', 'WH', 'Y', 'Z', 'ZH',
]);

export interface ParsedPhoneme {
  symbol: string;        // base ARPAbet (stress stripped)
  kind: 'vowel' | 'consonant';
  stress: number | null; // 0/1/2 for vowels, null for consonants
}

/** Strip stress marker from a CMU dict token. "AH0" → { base: "AH", stress: 0 } */
export function stripStress(token: string): { base: string; stress: number | null } {
  const last = token[token.length - 1];
  if (last === '0' || last === '1' || last === '2') {
    return { base: token.slice(0, -1), stress: Number(last) };
  }
  return { base: token, stress: null };
}

/** Parse a single ARPAbet token into a classified phoneme. */
export function parsePhoneme(token: string): ParsedPhoneme {
  const { base, stress } = stripStress(token);
  const kind = ARPABET_VOWELS.has(base) ? 'vowel' : 'consonant';
  return { symbol: base, kind, stress: kind === 'vowel' ? (stress ?? 0) : null };
}

/** Parse a CMU dict entry string into classified phonemes. "HH AH0 L OW1" → [...] */
export function parsePronunciation(cmuEntry: string): ParsedPhoneme[] {
  return cmuEntry.trim().split(/\s+/).map(parsePhoneme);
}

/**
 * Map ARPAbet vowels to engine timbres (AH, EE, OO).
 *
 * AH group (open/central): AA, AE, AH, AO, AX, AXR, ER, AY
 * EE group (front): EH, EY, IH, IX, IY
 * OO group (back/rounded): OW, OY, UH, UW, UX, AW
 */
export const VOWEL_TO_TIMBRE: Record<string, string> = {
  'AA': 'AH', 'AE': 'AH', 'AH': 'AH', 'AO': 'AH',
  'AX': 'AH', 'AXR': 'AH', 'ER': 'AH', 'AY': 'AH',
  'EH': 'EE', 'EY': 'EE', 'IH': 'EE', 'IX': 'EE', 'IY': 'EE',
  'OW': 'OO', 'OY': 'OO', 'UH': 'OO', 'UW': 'OO', 'UX': 'OO', 'AW': 'OO',
};

/** Get the timbre hint for a vowel phoneme. Returns undefined for consonants. */
export function getTimbreHint(phoneme: ParsedPhoneme): string | undefined {
  if (phoneme.kind !== 'vowel') return undefined;
  return VOWEL_TO_TIMBRE[phoneme.symbol] ?? 'AH';
}

/**
 * Vowel-to-timbre blend weights — positions each ARPAbet vowel
 * in the AH/EE/OO timbre triangle based on acoustic vowel space.
 *
 * AH = open/central, EE = front/close, OO = back/rounded
 * Diphthongs get blended positions reflecting their trajectory.
 */
export interface TimbreBlendWeights {
  AH: number;
  EE: number;
  OO: number;
}

export const VOWEL_BLEND_WEIGHTS: Record<string, TimbreBlendWeights> = {
  // ── Open/central vowels (AH-dominant) ──
  'AA': { AH: 1.0,  EE: 0.0,  OO: 0.0  }, // "father" — pure open
  'AH': { AH: 1.0,  EE: 0.0,  OO: 0.0  }, // "but" — central
  'AX': { AH: 0.8,  EE: 0.1,  OO: 0.1  }, // schwa — neutral central
  'AXR':{ AH: 0.8,  EE: 0.1,  OO: 0.1  }, // r-colored schwa

  // ── Front-open (AH+EE blends) ──
  'AE': { AH: 0.6,  EE: 0.4,  OO: 0.0  }, // "cat" — front-open
  'ER': { AH: 0.7,  EE: 0.2,  OO: 0.1  }, // "bird" — central r-colored

  // ── Front vowels (EE-dominant) ──
  'EH': { AH: 0.3,  EE: 0.7,  OO: 0.0  }, // "bed" — front-mid
  'IH': { AH: 0.15, EE: 0.85, OO: 0.0  }, // "bit" — front-high lax
  'IX': { AH: 0.25, EE: 0.75, OO: 0.0  }, // reduced "roses"
  'IY': { AH: 0.0,  EE: 1.0,  OO: 0.0  }, // "see" — pure front-high
  'EY': { AH: 0.15, EE: 0.85, OO: 0.0  }, // "say" — front diphthong

  // ── Back/rounded vowels (OO-dominant) ──
  'AO': { AH: 0.4,  EE: 0.0,  OO: 0.6  }, // "caught" — back-open rounded
  'OW': { AH: 0.1,  EE: 0.0,  OO: 0.9  }, // "go" — back-mid
  'UH': { AH: 0.1,  EE: 0.0,  OO: 0.9  }, // "book" — back-high lax
  'UW': { AH: 0.0,  EE: 0.0,  OO: 1.0  }, // "food" — pure back-high
  'UX': { AH: 0.0,  EE: 0.1,  OO: 0.9  }, // fronted "dude"

  // ── Diphthongs (blended trajectories) ──
  'AY': { AH: 0.5,  EE: 0.5,  OO: 0.0  }, // "buy" — open→front
  'AW': { AH: 0.35, EE: 0.0,  OO: 0.65 }, // "cow" — open→back
  'OY': { AH: 0.15, EE: 0.35, OO: 0.5  }, // "boy" — back→front
};

/**
 * Get blend weights for a vowel phoneme.
 * Returns null for consonants/unknown symbols.
 */
export function getVowelBlendWeights(symbol: string): TimbreBlendWeights | null {
  return VOWEL_BLEND_WEIGHTS[symbol] ?? null;
}
