/**
 * Consonant synthesis profiles — static data mapping ARPAbet consonants
 * to noise burst parameters, harmonic suppression, and frequency shaping.
 *
 * No preset dependency — these are universal phonetic defaults.
 */

export interface ConsonantProfile {
  envelopeKind: ConsonantEnvelopeKind;
  /** Peak noise burst amplitude (0..1). Independent of vowel amp. */
  noiseLevel: number;
  /** Harmonic amplitude multiplier during consonant (0=silent, 1=full). */
  harmonicGain: number;
  /** One-pole HPF cutoff as fraction of sampleRate (0=no filter, 0.38≈18kHz@48kHz). */
  hpfNorm: number;
}

/**
 * EB-008: CONSONANT_PROFILES is `Object.freeze`d at module load, plus every
 * inner profile object is also frozen. Stops a runaway test fixture or
 * caller from mutating the static data (e.g.
 * `CONSONANT_PROFILES.S.noiseLevel = 100`) which would silently corrupt
 * every engine instance in the process for the remainder of the run.
 *
 * Type is `Readonly<Record<string, Readonly<ConsonantProfile>>>` so the
 * compiler also catches direct assignments at type-check time.
 */
export const CONSONANT_PROFILES: Readonly<Record<string, Readonly<ConsonantProfile>>> = Object.freeze({
  // ── Unvoiced fricatives: high-frequency noise, harmonics suppressed ──
  S:  Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.18, harmonicGain: 0.0,  hpfNorm: 0.38 }),
  SH: Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.15, harmonicGain: 0.0,  hpfNorm: 0.28 }),
  F:  Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.10, harmonicGain: 0.0,  hpfNorm: 0.22 }),
  TH: Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.08, harmonicGain: 0.0,  hpfNorm: 0.20 }),
  HH: Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.06, harmonicGain: 0.0,  hpfNorm: 0.10 }),

  // ── Voiced fricatives: noise + partial harmonics ──
  Z:  Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.10, harmonicGain: 0.5,  hpfNorm: 0.38 }),
  ZH: Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.09, harmonicGain: 0.5,  hpfNorm: 0.28 }),
  V:  Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.07, harmonicGain: 0.5,  hpfNorm: 0.22 }),
  DH: Object.freeze({ envelopeKind: 'fricative', noiseLevel: 0.06, harmonicGain: 0.5,  hpfNorm: 0.20 }),

  // ── Unvoiced plosives: closure silence → burst ──
  T:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.20, harmonicGain: 0.0,  hpfNorm: 0.18 }),
  K:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.18, harmonicGain: 0.0,  hpfNorm: 0.12 }),
  P:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.15, harmonicGain: 0.0,  hpfNorm: 0.10 }),
  Q:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.0,  hpfNorm: 0.08 }),

  // ── Voiced plosives: closure → burst + partial harmonics ──
  B:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.08, harmonicGain: 0.3,  hpfNorm: 0.08 }),
  D:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.12, harmonicGain: 0.3,  hpfNorm: 0.12 }),
  G:  Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.3,  hpfNorm: 0.10 }),

  // ── Affricates: stop release → fricative ──
  CH: Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.16, harmonicGain: 0.0,  hpfNorm: 0.25 }),
  JH: Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.10, harmonicGain: 0.4,  hpfNorm: 0.20 }),

  // ── Nasals: mostly voiced, mild harmonic reduction, no noise ──
  M:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  N:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  NG: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),

  // ── Liquids: voiced, slight harmonic reduction ──
  L:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 }),
  R:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 }),

  // ── Glides/semivowels: nearly full harmonics ──
  W:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  WH: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  Y:  Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),

  // ── Flap/tap ──
  DX: Object.freeze({ envelopeKind: 'plosive', noiseLevel: 0.05, harmonicGain: 0.6,  hpfNorm: 0.08 }),

  // ── Syllabic consonants ──
  EL: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.85, hpfNorm: 0.0 }),
  EM: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  EN: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
  NX: Object.freeze({ envelopeKind: 'nasal', noiseLevel: 0.0,  harmonicGain: 0.9,  hpfNorm: 0.0 }),
});

/** Look up a consonant profile. Returns null for vowels/unknown symbols. */
export function getConsonantProfile(symbol: string): ConsonantProfile | null {
  return CONSONANT_PROFILES[symbol] ?? null;
}

/**
 * EB-009: closed list of envelope kinds, exported so callers loading profile
 * data from JSON / network / user input can validate at the boundary instead
 * of relying on a silent-fallback to 0 inside {@link consonantEnvelope}.
 *
 * To add a new kind:
 *   1. add it to this array (drives the type union below)
 *   2. add a `case` in the switch inside {@link consonantEnvelope}
 *
 * The `never`-assignment in that switch's default branch turns step 2 into a
 * compile-time error if you forget — so this single source of truth keeps the
 * two surfaces in lockstep.
 */
export const KNOWN_CONSONANT_KINDS = ['fricative', 'plosive', 'nasal'] as const;

/** Envelope kinds known to {@link consonantEnvelope}. */
export type ConsonantEnvelopeKind = typeof KNOWN_CONSONANT_KINDS[number];

/**
 * Type guard for {@link ConsonantEnvelopeKind}. Use at JSON-load boundaries to
 * reject bad data with a clear error before it reaches the renderer (where it
 * would silently produce 0 envelope gain and a single console.warn).
 *
 * @example
 * ```ts
 * if (!isKnownConsonantKind(raw.envelopeKind)) {
 *   throw new Error(`bad envelopeKind "${raw.envelopeKind}"; ` +
 *     `expected one of [${KNOWN_CONSONANT_KINDS.join(', ')}]`);
 * }
 * ```
 */
export function isKnownConsonantKind(s: string): s is ConsonantEnvelopeKind {
  return (KNOWN_CONSONANT_KINDS as readonly string[]).includes(s);
}

/** One-shot guard to avoid log spam if a bad kind keeps arriving each block. */
let warnedUnknownConsonantKind = false;

/**
 * Compute consonant envelope gain at relative time within the consonant.
 *
 * @param tRel — normalized time 0..1 (0 = consonant start, 1 = consonant end)
 * @param kind — envelope shape category. Pass a typed enum where possible —
 *               loosely-typed callers (e.g. JSON-loaded data) may slip an
 *               unknown string through despite the union type; the default
 *               branch returns 0 so we never leak NaN into consonantAmp math.
 * @returns amplitude gain 0..1
 */
export function consonantEnvelope(
  tRel: number,
  kind: ConsonantEnvelopeKind
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

    default: {
      // E-016 + EB-009: unreachable under sound TypeScript thanks to the
      // exhaustiveness assertion below, but a JSON-deserialized profile (or
      // a future-added phoneme kind that wasn't wired in here) could land
      // here at runtime. Return 0 so consonantAmp stays valid (not NaN) —
      // silent omission beats poisoning the buffer — and emit a one-shot
      // warn naming the bad kind AND the known set so the operator can fix
      // it instead of guessing.
      //
      // The `_exhaustive` assignment forces a compile-time error if a new
      // ConsonantEnvelopeKind is added to KNOWN_CONSONANT_KINDS without a
      // matching `case` above — single source of truth for the union.
      const _exhaustive: never = kind;
      void _exhaustive;
      if (!warnedUnknownConsonantKind) {
        warnedUnknownConsonantKind = true;
        // eslint-disable-next-line no-console
        console.warn(
          `consonantEnvelope: unknown kind "${String(kind)}" — returning 0. ` +
          `Known kinds: [${KNOWN_CONSONANT_KINDS.join(', ')}]. ` +
          `Validate JSON-loaded profiles with isKnownConsonantKind() at the boundary. ` +
          `(This warning fires once per process.)`
        );
      }
      return 0;
    }
  }
}
