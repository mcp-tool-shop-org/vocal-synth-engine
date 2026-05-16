import { createHash, Hash } from 'node:crypto';
import { LoadedVoicePreset } from '../preset/schema.js';
import { interpLinear, xorshift32, fastSin, dbToLinear } from './curves.js';

export interface RenderParams {
  f0Hz: Float32Array;       // per-sample
  amp: Float32Array;        // per-sample amplitude
  timbreWeights: Record<string, Float32Array>; // per-sample weights
  breathiness: Float32Array;// per-sample 0..1

  // ── Consonant synthesis (Phase 4.4) ──
  /** Per-sample consonant noise amplitude [0..1]. Independent of amp. */
  consonantAmp: Float32Array;
  /** Per-sample HPF cutoff as fraction of sampleRate (0 = no filter). */
  consonantHpfCutoff: Float32Array;
  /** Per-sample harmonic suppression gain (1.0 = full, 0 = silent). */
  harmonicGain: Float32Array;
}

/** Telemetry returned by BlockRenderer.getTelemetryAndReset(). */
export interface RendererTelemetry {
  /** SHA-256 hex digest of every sample emitted since the last reset.
   *  Format: "sha256:<64-hex-chars>". Used for cross-rig determinism checks. */
  determinismHash: string;
  /** Number of samples included in the hash above. */
  samplesSeen: number;
}

export interface BlockRenderer {
  renderBlock(params: RenderParams, out: Float32Array): void;
  getTelemetryAndReset(): RendererTelemetry;
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

  /** Noise gate gain — ramps to 0 when amp drops below threshold */
  private noiseGateGain: number = 1.0;
  /** Noise amplitude exponent — higher = noise dies faster on release */
  private noiseGamma: number;

  /** One-pole HPF state for consonant noise shaping */
  private hpfLastInput: number = 0;
  private hpfLastOutput: number = 0;

  /** Running SHA-256 over emitted sample bytes (little-endian Float32). */
  private hashState: Hash;
  /** Sample count since last getTelemetryAndReset(). */
  private samplesSeen: number = 0;
  /** Scratch buffer for streaming sample bytes into the hash. */
  private hashScratch: Buffer;

  constructor(preset: LoadedVoicePreset, rngSeed: number = 123456789, noiseGamma: number = 1.6) {
    this.preset = preset;
    this.sampleRate = preset.manifest.sampleRateHz;
    this.invSampleRate = 1.0 / this.sampleRate;
    this.rngState = { seed: rngSeed };
    this.noiseGamma = noiseGamma;

    // Find max harmonics across all timbres to size the phase array
    let maxH = 0;
    for (const timbre of Object.values(preset.timbres)) {
      if (timbre.harmonicsMag.length > maxH) maxH = timbre.harmonicsMag.length;
    }
    this.phases = new Float32Array(maxH);
    this.harmonicGains = new Float32Array(maxH);

    this.hashState = createHash('sha256');
    // Reusable buffer view for hashing — sized at construction since renderer
    // is per-voice and not shared across threads.
    this.hashScratch = Buffer.alloc(0);
  }

  /** Reset rng to a fresh seed. Phases and hash state are NOT reset by this
   *  method — call resetPhase() and/or getTelemetryAndReset() separately if
   *  you also want those cleared. */
  public reseed(seed: number): void {
    this.rngState.seed = seed;
  }

  public resetPhase(): void {
    this.phases.fill(0);
    this.noiseGateGain = 1.0;
    this.hpfLastInput = 0;
    this.hpfLastOutput = 0;
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

          // E-008: phase MUST advance whenever f0 > 0, regardless of amp.
          // If we skip during silent attack samples, the oscillator phase
          // resumes from the wrong position when amp ramps in — a 1-sample
          // shift in note-on alignment then changes phase at sample 100,
          // breaking byte-identical determinism. We mirror the weight<=0
          // branch which already does the right thing.
          if (f0 <= 0) continue;

          const weight = weights[i];
          if (amp <= 0 || weight <= 0) {
            // Advance phases only — no audio summation.
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

          out[i] += s * weight * amp * params.harmonicGain[i];
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

          out[i] += s * weight * amp * params.harmonicGain[i];
        }
      }
    }

    // ── Noise pass (separate to keep main loop branch-free) ──
    // Steeper amplitude curve (amp^γ, default γ=1.6) so noise dies faster than
    // harmonics during release, plus a gate that fades noise to zero over 20ms
    // once amp drops below -40 dB. Prevents static tail on voiced→unvoiced boundary.
    const gateThreshold = 0.01;        // -40 dB linear
    const gateDecay = 1.0 / (this.sampleRate * 0.020); // 20ms release
    const gamma = this.noiseGamma;
    for (let i = 0; i < numSamples; i++) {
      const a = params.amp[i];

      // Update noise gate: open when amp is above threshold, ramp closed otherwise
      if (a > gateThreshold) {
        this.noiseGateGain = 1.0;
      } else {
        this.noiseGateGain -= gateDecay;
        if (this.noiseGateGain < 0) this.noiseGateGain = 0;
      }

      const b = params.breathiness[i];
      if (b > 0.001 && this.noiseGateGain > 0) {
        const noiseAmp = Math.pow(a, gamma) * this.noiseGateGain;
        out[i] += (xorshift32(this.rngState) * 2 - 1) * 0.01 * b * noiseAmp;
      }
    }

    // ── Consonant noise pass (amplitude-independent, HPF-shaped) ──
    // E-003: clamp cutoff into [HPF_CUTOFF_MIN, HPF_CUTOFF_MAX] (avoid Nyquist
    // pathology and undefined alpha when cutoff > 0.5), and guard the filter
    // state from NaN propagation. A single NaN sample would otherwise be
    // remembered in hpfLastInput/hpfLastOutput and permanently poison every
    // subsequent block until the engine is rebuilt.
    for (let i = 0; i < numSamples; i++) {
      const cAmp = params.consonantAmp[i];
      if (cAmp <= 0.001) continue;

      let raw = xorshift32(this.rngState) * 2 - 1;
      if (!Number.isFinite(raw)) raw = 0;

      let cutoff = params.consonantHpfCutoff[i];
      if (!Number.isFinite(cutoff)) cutoff = 0;
      // Clamp to safe range. The 0.49 upper bound stays below Nyquist (0.5
      // of sampleRate) where the one-pole formula is well-defined; the lower
      // 0.001 floor avoids trivially small cutoffs that round to 0.
      if (cutoff > HPF_CUTOFF_MAX) cutoff = HPF_CUTOFF_MAX;
      else if (cutoff < 0) cutoff = 0;

      if (cutoff > HPF_CUTOFF_MIN) {
        // One-pole HPF: y[n] = α·(y[n-1] + x[n] - x[n-1])
        // α = RC / (RC + T) where RC = 1/(2π·fc), T = 1/sr
        const cutoffHz = cutoff * this.sampleRate;
        const rc = 1.0 / (2 * Math.PI * cutoffHz);
        const alpha = rc / (rc + invSr);
        let filtered = alpha * (this.hpfLastOutput + raw - this.hpfLastInput);
        if (!Number.isFinite(filtered)) {
          // Reset filter state to a clean slate so we never carry a NaN forward.
          filtered = 0;
          this.hpfLastInput = 0;
          this.hpfLastOutput = 0;
        } else {
          this.hpfLastInput = raw;
          this.hpfLastOutput = filtered;
        }
        out[i] += filtered * cAmp;
      } else {
        out[i] += raw * cAmp;
      }
    }

    // ── Determinism telemetry: stream the emitted block into a running SHA-256.
    // We hash the raw Float32 little-endian byte representation so two engines
    // constructed with identical state + inputs produce byte-identical digests.
    // Sized lazily because numSamples can vary per call (rare; usually blockSize).
    if (this.hashScratch.length < numSamples * 4) {
      this.hashScratch = Buffer.alloc(numSamples * 4);
    }
    for (let i = 0; i < numSamples; i++) {
      this.hashScratch.writeFloatLE(out[i], i * 4);
    }
    this.hashState.update(this.hashScratch.subarray(0, numSamples * 4));
    this.samplesSeen += numSamples;
  }

  getTelemetryAndReset(): RendererTelemetry {
    const digest = this.hashState.digest('hex');
    const samples = this.samplesSeen;
    // Reset for next telemetry window.
    this.hashState = createHash('sha256');
    this.samplesSeen = 0;
    return {
      determinismHash: `sha256:${digest}`,
      samplesSeen: samples,
    };
  }
}

/** Lower bound on consonant HPF cutoff (treated as no-filter below this).
 *  Matches the original >0.001 threshold check. */
const HPF_CUTOFF_MIN = 0.001;
/** Upper bound on consonant HPF cutoff (kept below Nyquist=0.5). */
const HPF_CUTOFF_MAX = 0.49;
