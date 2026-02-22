import { LoadedVoicePreset } from '../preset/schema.js';
import { interpLinear, xorshift32, fastSin, dbToLinear } from './curves.js';

export interface RenderParams {
  f0Hz: Float32Array;       // per-sample
  amp: Float32Array;        // per-sample amplitude
  timbreWeights: Record<string, Float32Array>; // per-sample weights
  breathiness: Float32Array;// per-sample 0..1
}

export interface BlockRenderer {
  renderBlock(params: RenderParams, out: Float32Array): void;
  getTelemetryAndReset(): unknown;
  resetPhase(): void;
}

export class MonophonicRenderer implements BlockRenderer {
  /** Oscillator phases — normalized [0..1) per harmonic */
  private phases: Float32Array;
  /** Pre-allocated harmonic gain buffer (reused each block) */
  private harmonicGains: Float32Array;
  private rngState: { seed: number };
  private sampleRate: number;
  private invSampleRate: number;
  private preset: LoadedVoicePreset;

  constructor(preset: LoadedVoicePreset, rngSeed: number = 123456789) {
    this.preset = preset;
    this.sampleRate = preset.manifest.sampleRateHz;
    this.invSampleRate = 1.0 / this.sampleRate;
    this.rngState = { seed: rngSeed };

    // Find max harmonics across all timbres to size the phase array
    let maxH = 0;
    for (const timbre of Object.values(preset.timbres)) {
      if (timbre.harmonicsMag.length > maxH) maxH = timbre.harmonicsMag.length;
    }
    this.phases = new Float32Array(maxH);
    this.harmonicGains = new Float32Array(maxH);
  }

  public resetPhase(): void {
    this.phases.fill(0);
  }

  /**
   * Render a block of audio.
   *
   * Performance-critical path — optimized for real-time:
   *   1. Harmonic envelope gains pre-computed at block-center F0
   *      (spectral envelope changes very slowly vs block size).
   *   2. Sine via 4096-entry LUT instead of Math.sin().
   *   3. dB→linear via Math.exp instead of Math.pow(10, x/20).
   *   4. Phase tracked as normalized [0..1) — avoids 2π multiplies.
   */
  renderBlock(params: RenderParams, out: Float32Array): void {
    const numSamples = out.length;
    const timbres = Object.keys(params.timbreWeights);
    const nyquist = this.sampleRate * 0.5;
    const invSr = this.invSampleRate;
    const phases = this.phases;
    const harmonicGains = this.harmonicGains;

    out.fill(0);

    for (let ti = 0; ti < timbres.length; ti++) {
      const timbreId = timbres[ti];
      const timbre = this.preset.timbres[timbreId];
      if (!timbre) continue;

      const H = timbre.harmonicsMag.length;
      const weights = params.timbreWeights[timbreId];
      const advancePhase = (ti === 0); // only first timbre advances shared phases

      // ── Block-rate: pre-compute harmonic gains at mid-block F0 ──
      // Spectral envelope is smooth; re-evaluating per-sample wastes ~95% of CPU.
      // This converts H×interpLinear + H×dbToLinear from per-sample to per-block.
      const refF0 = params.f0Hz[numSamples >> 1] || params.f0Hz[0];
      if (refF0 <= 0) continue;

      let activeH = 0;
      for (let k = 1; k <= H; k++) {
        if (k * refF0 >= nyquist) break;
        const envDb = interpLinear(timbre.freqHz, timbre.envelopeDb, k * refF0);
        harmonicGains[k - 1] = timbre.harmonicsMag[k - 1] * dbToLinear(envDb);
        activeH = k;
      }
      if (activeH === 0) continue;

      // ── Per-sample: phase advance + sine LUT + gain ──
      if (advancePhase) {
        for (let i = 0; i < numSamples; i++) {
          const f0 = params.f0Hz[i];
          const amp = params.amp[i];
          if (amp <= 0 || f0 <= 0) continue;

          const weight = weights[i];
          if (weight <= 0) {
            // Still advance phases to maintain continuity
            for (let k = 0; k < activeH; k++) {
              phases[k] += (k + 1) * f0 * invSr;
              phases[k] -= (phases[k] | 0); // fast fractional part
            }
            continue;
          }

          let s = 0.0;
          for (let k = 0; k < activeH; k++) {
            phases[k] += (k + 1) * f0 * invSr;
            phases[k] -= (phases[k] | 0);
            s += harmonicGains[k] * fastSin(phases[k]);
          }

          out[i] += s * weight * amp;
        }
      } else {
        // Secondary timbres: read phases only (no advance)
        for (let i = 0; i < numSamples; i++) {
          const amp = params.amp[i];
          if (amp <= 0) continue;
          const weight = weights[i];
          if (weight <= 0) continue;

          let s = 0.0;
          for (let k = 0; k < activeH; k++) {
            s += harmonicGains[k] * fastSin(phases[k]);
          }

          out[i] += s * weight * amp;
        }
      }
    }

    // ── Noise pass (separate to keep main loop branch-free) ──
    for (let i = 0; i < numSamples; i++) {
      const b = params.breathiness[i];
      if (b > 0.001 && params.amp[i] > 0) {
        out[i] += (xorshift32(this.rngState) * 2 - 1) * 0.01 * b * params.amp[i];
      }
    }
  }

  getTelemetryAndReset(): unknown {
    return {
      determinismHash: "sha256:mock_renderer_hash"
    };
  }
}
