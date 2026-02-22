/**
 * Consonant synthesis profiles — static data mapping ARPAbet consonants
 * to noise burst parameters, harmonic suppression, and frequency shaping.
 *
 * No preset dependency — these are universal phonetic defaults.
 */

export interface ConsonantProfile {
  envelopeKind: 'fricative' | 'plosive' | 'nasal';
  /** Peak noise burst amplitude (0..1). Independent of vowel amp. */
  noiseLevel: number;
  /** Harmonic amplitude multiplier during consonant (0=silent, 1=full). */
  harmonicGain: number;
  /** One-pole HPF cutoff as fraction of sampleRate (0=no filter, 0.38≈18kHz@48kHz). */
  hpfNorm: number;
}

export const CONSONANT_PROFILES: Record<string, ConsonantProfile> = {
  // ── Unvoiced fricatives: high-frequency noise, harmonics suppressed ──
  S:  { envelopeKind: 'fricative', noiseLevel: 0.18, harmonicGain: 0.0,  hpfNorm: 0.38 },
  SH: { envelopeKind: 'fricative', noiseLevel: 0.15, harmonicGain: 0.0,  hpfNorm: 0.28 },
  F:  { envelopeKind: 'fricative', noiseLevel: 0.10, harmonicGain: 0.0,  hpfNorm: 0.22 },
  TH: { envelopeKind: 'fricative', noiseLevel: 0.08, harmonicGain: 0.0,  hpfNorm: 0.20 },
  HH: { envelopeKind: 'fricative', noiseLevel: 0.06, harmonicGain: 0.0,  hpfNorm: 0.10 },

  // ── Voiced fricatives: noise + partial harmonics ──
  Z:  { envelopeKind: 'fricative', noiseLevel: 0.10, harmonicGain: 0.5,  hpfNorm: 0.38 },
  ZH: { envelopeKind: 'fricative', noiseLevel: 0.09, harmonicGain: 0.5,  hpfNorm: 0.28 },
  V:  { envelopeKind: 'fricative', noiseLevel: 0.07, harmonicGain: 0.5,  hpfNorm: 0.22 },
  DH: { envelopeKind: 'fricative', noiseLevel: 0.06, harmonicGain: 0.5,  hpfNorm: 0.20 },

  // ── Unvoiced plosives: closure silence → burst ──
  T:  { envelopeKind: 'plosive', noiseLevel: 0.20, harmonicGain: 0.0,  hpfNorm: 0.18 },
  K:  { envelopeKind: 'plosive', noiseLevel: 0.18, harmonicGain: 0.0,  hpfNorm: 0.12 },
  P:  { envelopeKind: 'plosive', noiseLevel: 0.15, harmonicGain: 0.0,  hpfNorm: 0.10 },
  Q:  { envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.0,  hpfNorm: 0.08 },

  // ── Voiced plosives: closure → burst + partial harmonics ──
  B:  { envelopeKind: 'plosive', noiseLevel: 0.08, harmonicGain: 0.3,  hpfNorm: 0.08 },
  D:  { envelopeKind: 'plosive', noiseLevel: 0.12, harmonicGain: 0.3,  hpfNorm: 0.12 },
  G:  { envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.3,  hpfNorm: 0.10 },

  // ── Affricates: stop release → fricative ──
  CH: { envelopeKind: 'plosive', noiseLevel: 0.16, harmonicGain: 0.0,  hpfNorm: 0.25 },
  JH: { envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.4,  hpfNorm: 0.20 },

  // ── Nasals: mostly voiced, mild harmonic reduction, no noise ──
  M:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  N:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  NG: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },

  // ── Liquids: voiced, slight harmonic reduction ──
  L:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 },
  R:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 },

  // ── Glides/semivowels: nearly full harmonics ──
  W:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  WH: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  Y:  { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },

  // ── Flap/tap ──
  DX: { envelopeKind: 'plosive', noiseLevel: 0.05, harmonicGain: 0.6,  hpfNorm: 0.08 },

  // ── Syllabic consonants ──
  EL: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 },
  EM: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  EN: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
  NX: { envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 },
};

/** Look up a consonant profile. Returns null for vowels/unknown symbols. */
export function getConsonantProfile(symbol: string): ConsonantProfile | null {
  return CONSONANT_PROFILES[symbol] ?? null;
}

/**
 * Compute consonant envelope gain at relative time within the consonant.
 *
 * @param tRel — normalized time 0..1 (0 = consonant start, 1 = consonant end)
 * @param kind — envelope shape category
 * @returns amplitude gain 0..1
 */
export function consonantEnvelope(
  tRel: number,
  kind: 'fricative' | 'plosive' | 'nasal'
): number {
  if (tRel < 0 || tRel > 1) return 0;

  switch (kind) {
    case 'fricative':
      // Fast attack (0→15%), sustain (15→80%), release (80→100%)
      if (tRel < 0.15) return tRel / 0.15;
      if (tRel < 0.80) return 1.0;
      return (1.0 - tRel) / 0.20;

    case 'plosive':
      // Closure silence (0→70%), burst ramp (70→85%), decay (85→100%)
      if (tRel < 0.70) return 0.0;
      if (tRel < 0.85) return (tRel - 0.70) / 0.15;
      return Math.max(0, 1.0 - (tRel - 0.85) / 0.15);

    case 'nasal':
      // Smooth trapezoid: ramp (0→10%), sustain (10→90%), ramp (90→100%)
      if (tRel < 0.10) return tRel / 0.10;
      if (tRel < 0.90) return 1.0;
      return (1.0 - tRel) / 0.10;
  }
}
