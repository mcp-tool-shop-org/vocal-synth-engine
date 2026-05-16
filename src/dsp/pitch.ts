/** Maximum supported input length for YIN pitch detection.
 *
 * YIN has O(N²) inner work where N = signal.length / 2. With no cap, a
 * malicious or careless 1 MB signal triggers ~250 billion multiplications
 * and blocks the JS thread for minutes — a real DoS surface on any service
 * that exposes pitch detection via an API.
 *
 * 8192 samples is ~170 ms @48 kHz, which is well above the normal YIN
 * frame length (1024–2048) and still bounds worst-case work to ~17M ops.
 * Callers needing pitch detection on longer streams MUST chunk the input.
 */
export const FIND_PITCH_YIN_MAX_LENGTH = 8192;

/**
 * Returns 0 when no valid pitch can be estimated.
 *
 * Reasons this can happen:
 *   - The input is silent (all zeros → cmndf becomes 0/0 = NaN).
 *   - The fallback minimum search couldn't find a candidate.
 *
 * Returning 0 (rather than NaN or a nonsense Hz value like -48000)
 * gives callers a single sentinel to check.
 */
export function findPitchYin(signal: Float32Array, sampleRate: number): number {
  // Input-length cap: protect against O(N²) DoS.
  if (signal.length > FIND_PITCH_YIN_MAX_LENGTH) {
    throw new Error(
      `findPitchYin: signal length ${signal.length} exceeds maximum ` +
      `${FIND_PITCH_YIN_MAX_LENGTH}. Chunk input or raise FIND_PITCH_YIN_MAX_LENGTH.`
    );
  }

  const half = Math.floor(signal.length / 2);
  if (half < 3) return 0; // not enough samples for tau=2 fallback

  const diff = new Float32Array(half);

  for (let tau = 0; tau < half; tau++) {
    for (let i = 0; i < half; i++) {
      const d = signal[i] - signal[i + tau];
      diff[tau] += d * d;
    }
  }

  const cmndf = new Float32Array(half);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < half; tau++) {
    runningSum += diff[tau];
    // Guard against silent input: all-zero signal → runningSum stays 0,
    // 0/0 = NaN poisons the CMNDF and the threshold scan falls through
    // to the fallback with all-NaN values. Treat unestimable bins as 1
    // (the cmndf[0] convention — never a minimum).
    if (runningSum === 0) {
      cmndf[tau] = 1;
      continue;
    }
    cmndf[tau] = diff[tau] * tau / runningSum;
  }

  const threshold = 0.3;
  let tauEstimate = -1;
  for (let tau = 2; tau < half; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 < half && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    // Fallback: find global CMNDF minimum, but constrain to plausible
    // speech F0 range (50-500 Hz) to avoid octave errors
    const minTau = Math.max(2, Math.floor(sampleRate / 500));
    const maxTau = Math.min(half, Math.floor(sampleRate / 50));
    let minVal = Infinity;
    for (let tau = minTau; tau < maxTau; tau++) {
      // NaN comparisons are always false; skip them explicitly so a fully
      // unestimable CMNDF doesn't leave tauEstimate at -1.
      const v = cmndf[tau];
      if (Number.isFinite(v) && v < minVal) {
        minVal = v;
        tauEstimate = tau;
      }
    }
    // If we still have no valid estimate (e.g., silent input with full
    // NaN cmndf, or all-Infinity), return 0 rather than sampleRate / -1
    // (which would be a nonsense negative-Hz value).
    if (tauEstimate === -1) return 0;
  }

  return sampleRate / tauEstimate;
}
