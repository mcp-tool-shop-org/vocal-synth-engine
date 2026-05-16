import { AutomationPoint } from '../types/score.js';

// ── Sine lookup table (4096 entries, ~0.09° resolution, ~70 dB SNR) ──
const SINE_TABLE_SIZE = 4096;
const SINE_TABLE_MASK = SINE_TABLE_SIZE - 1;
const SINE_TABLE = new Float32Array(SINE_TABLE_SIZE);
for (let i = 0; i < SINE_TABLE_SIZE; i++) {
  SINE_TABLE[i] = Math.sin(2 * Math.PI * i / SINE_TABLE_SIZE);
}

/** Fast sine from normalized phase [0..1). Uses 4096-entry LUT. */
export function fastSin(phase01: number): number {
  return SINE_TABLE[((phase01 * SINE_TABLE_SIZE) | 0) & SINE_TABLE_MASK];
}

// ── dB → linear conversion ──
const LN10_OVER_20 = Math.LN10 / 20; // ≈ 0.11513

/** Convert dB to linear amplitude. ~2-3× faster than Math.pow(10, db/20). */
export function dbToLinear(db: number): number {
  return Math.exp(db * LN10_OVER_20);
}

/**
 * Convert MIDI note number to frequency in Hz (A4=440 Hz at MIDI 69).
 *
 * **Domain:** any finite `midi` value (negative and >127 are valid in theory,
 * though MIDI spec is [0,127]). Returns `NaN` for non-finite input (NaN/Infinity
 * propagate). EB-010: callers in the live-render path MUST validate at the API
 * boundary — `noteOn()` and similar — to keep NaN out of the audio mix-bus.
 *
 * @returns frequency in Hz, or `NaN` if `midi` is non-finite.
 */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Convert frequency in Hz to MIDI note number (inverse of {@link midiToHz}).
 *
 * **Domain:** `hz` must be strictly positive and finite. Returns `-Infinity`
 * for `hz === 0` and `NaN` for negative or non-finite `hz` (log2 of non-positive
 * is undefined). EB-010: pitch-tracker output should be guarded before calling.
 *
 * @returns MIDI note number, or `-Infinity`/`NaN` outside the positive domain.
 */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * Convert a pitch offset in cents to a frequency ratio (100 cents = 1 semitone).
 *
 * **Domain:** any finite `cents`. Returns `NaN` for non-finite input.
 */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/**
 * Compute the per-sample vibrato offset in cents.
 *
 * **Domain:** all numeric arguments must be finite. `rateHz` should be >= 0
 * (negative just flips the LFO phase), `depthCents` is unbounded but typically
 * 0..200, `onsetSec` >= 0. Returns 0 before `noteStartSec`.
 *
 * EB-010: NaN/Infinity in any argument propagates through `Math.sin` and the
 * multiplication, returning NaN. Caller must validate upstream.
 */
export function calculateVibrato(
  tSec: number,
  noteStartSec: number,
  rateHz: number,
  depthCents: number,
  onsetSec: number
): number {
  const activeTime = tSec - noteStartSec;
  if (activeTime <= 0) return 0;

  // Fade in vibrato over onsetSec
  const fade = onsetSec > 0 ? Math.min(1.0, activeTime / onsetSec) : 1.0;

  // Sine wave LFO
  const lfo = Math.sin(2 * Math.PI * rateHz * activeTime);

  return depthCents * fade * lfo;
}

/**
 * Compute the ADSR envelope amplitude at time `tSec`.
 *
 * **Domain:** all arguments must be finite. `attackSec` and `releaseSec` MUST
 * be > 0 — passing 0 produces a division-by-zero (`Infinity` during attack or
 * release, `NaN` if `activeTime` is also 0). Callers using ADSR with zero
 * attack/release should clamp upstream to a small epsilon (e.g. 1e-4) rather
 * than rely on this function to guard. EB-010.
 *
 * @returns envelope amplitude in [0, 1].
 */
export function calculateAdsr(
  tSec: number,
  noteStartSec: number,
  noteEndSec: number,
  attackSec: number = 0.05,
  releaseSec: number = 0.1
): number {
  if (tSec < noteStartSec) return 0;

  const activeTime = tSec - noteStartSec;
  const timeFromEnd = noteEndSec - tSec;

  if (timeFromEnd <= 0) {
    // In release phase (or past it)
    const releaseTime = tSec - noteEndSec;
    if (releaseTime >= releaseSec) return 0;
    return 1.0 - (releaseTime / releaseSec);
  }

  // In attack phase
  if (activeTime < attackSec) {
    return activeTime / attackSec;
  }

  // Sustain phase
  return 1.0;
}

export function interpLinear(x: Float32Array, y: Float32Array, targetX: number): number {
  if (targetX <= x[0]) return y[0];
  if (targetX >= x[x.length - 1]) return y[y.length - 1];

  let i = 0;
  while (i < x.length - 1 && x[i + 1] < targetX) i++;

  // Guard against duplicate adjacent x values (denom == 0 → NaN poisoning).
  // A malformed preset with two identical frequency entries would otherwise
  // silently NaN-poison the entire output buffer.
  const denom = x[i + 1] - x[i];
  if (denom === 0) return y[i];

  const t = (targetX - x[i]) / denom;
  return y[i] + t * (y[i + 1] - y[i]);
}

/**
 * Fallback seed used when state.seed lands at xorshift32's fixed point (0).
 * The constant is the golden-ratio integer (2^32 / phi) — a well-mixed,
 * non-zero, non-trivial bit pattern commonly used to escape the xorshift
 * trap. Documented invariant: xorshift32 NEVER returns identical output
 * for two identical input seeds when seed=0 — both are silently remapped
 * to this constant. Callers should avoid seed=0 (and the renderer's
 * `rngSeed + index` arithmetic should not land voice 0 at seed 0).
 */
const XORSHIFT32_SEED_ZERO_REMAP = 0x9E3779B9 | 0;

export function xorshift32(state: { seed: number }) {
  // xorshift32 has a fixed point at 0: 0 XOR (0<<n) = 0 forever.
  // Remap silently to a non-trivial seed to avoid a permanent-zero output
  // stream (which would silence breath/consonant noise).
  if (state.seed === 0) state.seed = XORSHIFT32_SEED_ZERO_REMAP;
  let x = state.seed;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  state.seed = x;
  return (x >>> 0) / 4294967296.0;
}

/**
 * Linear interpolation across an automation lane.
 *
 * **Precondition (load-bearing):** `points` MUST be sorted by `tSec` in
 * monotonically non-decreasing order. The find-segment loop scans forward
 * assuming order — a lane authored or de-serialized in arbitrary order
 * would return garbage interpolated values silently (no crash). The CLI
 * loader (`src/preset/loader.ts`) and score validator should enforce this
 * at load time; this helper runs in the per-sample hot path and cannot
 * afford a re-sort.
 *
 * For defensive robustness in dev/test builds (NODE_ENV !== 'production')
 * we cheaply assert monotonicity on the FIRST call only and log once if
 * the precondition is violated — the lane is then used as-is (garbage out)
 * so the operator sees the warning rather than the function masking the bug.
 *
 * If `p1.tSec === p0.tSec` (duplicate breakpoint) we return `p0.value`
 * to avoid 0/0 = NaN poisoning the entire output buffer.
 */
export function interpAutomation(points: AutomationPoint[], tSec: number): number {
  if (!points || points.length === 0) return 0;
  if (points.length === 1) return points[0].value;
  assertAutomationSortedDev(points);
  if (tSec <= points[0].tSec) return points[0].value;
  if (tSec >= points[points.length - 1].tSec) return points[points.length - 1].value;

  let i = 0;
  while (i < points.length - 1 && points[i + 1].tSec < tSec) i++;

  const p0 = points[i];
  const p1 = points[i + 1];
  // E-018: same denom-zero guard as interpLinear — duplicate adjacent tSec
  // (allowed by non-decreasing ordering) would otherwise produce NaN.
  const denom = p1.tSec - p0.tSec;
  if (denom === 0) return p0.value;
  const t = (tSec - p0.tSec) / denom;
  return p0.value + t * (p1.value - p0.value);
}

/** Module-level set of lane references already validated this process. We
 *  cache by reference to keep the per-call cost a single Set.has() check,
 *  not an O(N) re-scan, even though the precondition is meant to be
 *  enforced at load time. */
const automationSortedChecked: WeakSet<AutomationPoint[]> = new WeakSet();
let warnedAutomationOutOfOrder = false;

function assertAutomationSortedDev(points: AutomationPoint[]): void {
  // Cheap escape on the hot path: skip in production and on already-seen lanes.
  // The cost in dev is one WeakSet.has() per call after the first.
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') {
    return;
  }
  if (automationSortedChecked.has(points)) return;
  for (let i = 1; i < points.length; i++) {
    if (points[i].tSec < points[i - 1].tSec) {
      if (!warnedAutomationOutOfOrder) {
        warnedAutomationOutOfOrder = true;
        // eslint-disable-next-line no-console
        console.warn(
          `interpAutomation: lane is not sorted by tSec ` +
          `(points[${i - 1}].tSec=${points[i - 1].tSec}, ` +
          `points[${i}].tSec=${points[i].tSec}). ` +
          `Sort at load time. (This warning fires once per process.)`
        );
      }
      break;
    }
  }
  automationSortedChecked.add(points);
}
