/**
 * LiveSynthEngine — imperative real-time voice synth.
 *
 * Unlike StreamingVocalSynthEngine (score-driven), this engine responds to
 * note_on / note_off commands in real-time. It reuses MonophonicRenderer
 * for the actual DSP.
 */

import { LoadedVoicePreset } from '../preset/schema.js';
import { MonophonicRenderer, RenderParams } from './renderer.js';
import { midiToHz, centsToRatio, calculateVibrato } from './curves.js';

export interface LiveVoiceParams {
  noteId: string;
  midi: number;
  velocity: number;
  timbre?: string;
  breathiness?: number;
  vibrato?: { rateHz: number; depthCents: number; onsetSec: number };
  portamentoMs?: number;
}

export interface LiveEngineConfig {
  sampleRateHz: number;
  blockSize: number;
  maxPolyphony: number;
  defaultTimbre: string;
  rngSeed: number;
}

/** Per-voice runtime state */
interface LiveVoice {
  renderer: MonophonicRenderer;
  index: number;

  // Active note (null = free)
  noteId: string | null;
  midi: number;
  velocity: number;
  timbre: string | null;
  breathiness: number;
  vibrato: { rateHz: number; depthCents: number; onsetSec: number } | null;
  portamentoMs: number;

  // Envelope state
  noteOnSample: number;      // when note started (in samples)
  noteOffSample: number;     // when release began (-1 = still held)
  releaseDurationSec: number; // how long the release lasts

  // Portamento
  prevMidi: number;           // for glide calculation

  // Steal crossfade: fade out residual from stolen voice
  stealFadeSamplesLeft: number;  // countdown for crossfade (0 = inactive)
  stealFadeTotal: number;        // total fade length for gain calc
  stealLastOutput: number;       // last output level of stolen voice
}

export interface LiveTelemetry {
  voicesActive: number;
  voicesMax: number;
  /** Peak amplitude in dBFS measured BEFORE the soft limiter (E-010).
   *  Operators tuning polyphony see the true mix-bus headroom even when
   *  the limiter is doing significant work. */
  peakDbfs: number;
  /** Approximate gain-reduction caused by the soft limiter on this window,
   *  in dB (positive number, 0 = limiter idle). Computed as
   *  20·log10(peakPre / peakPost) when both > 0. */
  limiterReductionDb: number;
  clickDeltaMaxRecent: number;
  rtf: number;
  /** EB-004: voice-steals (noteOn forced to kick another voice out of the
   *  allocation pool) since last reset. Non-zero means your maxPolyphony cap
   *  is biting — bump it or shorten release times. */
  voicesStolenLastWindow: number;
  /** EB-004: voices currently sunset (mid-release after a polyphony shrink,
   *  audibly fading but excluded from new-note allocation). Non-zero is fine
   *  briefly after `updateConfig({maxPolyphony})`; persistent non-zero means
   *  releases are long and you keep shrinking. */
  sunsetVoiceCount: number;
  /** EB-003: number of NaN/Infinity samples observed on the output bus this
   *  window. MUST be 0 in steady state. Non-zero is a defect — find the bug,
   *  do not increase a tolerance. The corrupt samples are zeroed in-place
   *  before being returned to the caller, so the audio path stays clean. */
  outputNaNCount: number;
}

export class LiveSynthEngine {
  private config: LiveEngineConfig;
  private preset: LoadedVoicePreset;
  private voices: LiveVoice[];
  /** E-020: voices excised by a polyphony shrink that were still mid-release.
   *  We keep their releases audible (no abrupt click) but exclude them from
   *  new-note allocation. Pruned at end of render() once a voice's release
   *  fully completes. The original .voices array remains the allocation pool. */
  private sunsetVoices: LiveVoice[] = [];
  private currentSample: number = 0;
  private playing: boolean = false;

  // Pre-allocated render buffers (reused every frame — zero GC pressure)
  private outBuf: Float32Array;
  private voiceOutBuf: Float32Array;
  private paramF0: Float32Array;
  private paramAmp: Float32Array;
  private paramBreath: Float32Array;
  private paramTimbreWeights: Record<string, Float32Array>;
  private paramConsonantAmp: Float32Array;
  private paramConsonantHpfCutoff: Float32Array;
  private paramHarmonicGain: Float32Array;

  // Global timbre morph weights (null = use per-voice timbre string)
  private globalTimbreWeights: Record<string, number> | null = null;

  // Soft limiter (tanh-based, prevents clipping with polyphony)
  private limiterEnabled: boolean = true;

  // Telemetry accumulators (reset on read)
  private peakSample: number = 0;        // pre-limiter peak (E-010)
  private peakSamplePost: number = 0;    // post-limiter peak (for limiter-reduction calc)
  private maxDelta: number = 0;
  private lastSample: number = 0;
  private voicesMaxSeen: number = 0;
  private renderTimeAccumMs: number = 0;
  private renderBlocksAccum: number = 0;
  /** EB-004: counts noteOn() calls that had to steal a voice since last
   *  telemetry read. Reset to 0 by getTelemetryAndReset(). */
  private voicesStolenAccum: number = 0;
  /** EB-003: counts NaN/Infinity samples observed on the output bus since
   *  last telemetry read. MUST be 0 in steady state. */
  private outputNaNAccum: number = 0;

  constructor(config: LiveEngineConfig, preset: LoadedVoicePreset) {
    this.config = config;
    this.preset = preset;
    this.voices = Array.from({ length: config.maxPolyphony }, (_, i) => this.createVoice(i));

    // Allocate render buffers once
    const bs = config.blockSize;
    this.outBuf = new Float32Array(bs);
    this.voiceOutBuf = new Float32Array(bs);
    this.paramF0 = new Float32Array(bs);
    this.paramAmp = new Float32Array(bs);
    this.paramBreath = new Float32Array(bs);
    this.paramTimbreWeights = {};
    for (const t of Object.keys(preset.timbres)) {
      this.paramTimbreWeights[t] = new Float32Array(bs);
    }
    this.paramConsonantAmp = new Float32Array(bs);
    this.paramConsonantHpfCutoff = new Float32Array(bs);
    this.paramHarmonicGain = new Float32Array(bs);
  }

  private createVoice(index: number): LiveVoice {
    return {
      renderer: new MonophonicRenderer(this.preset, this.config.rngSeed + index),
      index,
      noteId: null,
      midi: 60,
      velocity: 0,
      timbre: null,
      breathiness: 0,
      vibrato: null,
      portamentoMs: 0,
      noteOnSample: 0,
      noteOffSample: -1,
      releaseDurationSec: 0.1,
      prevMidi: 60,
      stealFadeSamplesLeft: 0,
      stealFadeTotal: 0,
      stealLastOutput: 0,
    };
  }

  get isPlaying() { return this.playing; }
  get sampleRateHz() { return this.config.sampleRateHz; }
  get blockSize() { return this.config.blockSize; }
  get maxPolyphony() { return this.config.maxPolyphony; }
  get defaultTimbre() { return this.config.defaultTimbre; }

  // ── Transport ────────────────────────────────────────────────

  play() { this.playing = true; }
  stop() { this.playing = false; this.panic(); }

  /** Stop all voices immediately with a fast release, reset all state */
  panic() {
    for (const v of this.voices) {
      if (v.noteId !== null) {
        v.noteOffSample = this.currentSample;
        v.releaseDurationSec = 0.01; // 10ms fast release to avoid clicks
      }
    }
    // E-020: drop any lingering sunset voices outright. Panic is supposed
    // to take us to silence in ~10 ms; trailing them through a longer
    // release would defeat that promise.
    for (const v of this.sunsetVoices) {
      v.noteId = null;
      v.noteOffSample = -1;
    }
    this.sunsetVoices.length = 0;
    // E-019: we deliberately do NOT fill this.outBuf here. render() zeros
    // it unconditionally at entry, so any sample a consumer ever observes
    // is one that render() produced AFTER the panic. The previous explicit
    // fill was dead — it could only ever be read by a caller who read the
    // buffer between panic() and the next render(), and the engine has no
    // documented surface for that (render() returns the same buffer it
    // mutates). If you add such a surface, restore the fill here AND
    // document that consumers must not retain the returned buffer past
    // the next panic()/render() boundary.
    // Clear morph weights so we fall back to per-voice timbre
    this.globalTimbreWeights = null;
    // E-009: reset click-detection reference so the next non-silent sample
    // doesn't register as a fake click delta from a remembered pre-panic value.
    this.lastSample = 0;
  }

  // ── Note events ──────────────────────────────────────────────

  /**
   * EB-001: validate noteOn parameters at the API boundary. NaN/Infinity in
   * any numeric field would otherwise propagate through `midiToHz` → `pf0`
   * → mix bus → limiter → telemetry, silently poisoning every subsequent
   * sample until the engine is rebuilt. Throwing here surfaces the upstream
   * bug (misbehaving MIDI controller, bad parser, etc.) at the source.
   */
  private validateNoteOnParams(params: LiveVoiceParams): void {
    if (!params || typeof params !== 'object') {
      throw new TypeError('noteOn: params must be an object');
    }
    if (typeof params.noteId !== 'string' || params.noteId.length === 0) {
      throw new TypeError(`noteOn: noteId must be a non-empty string, got ${String(params.noteId)}`);
    }
    if (!Number.isFinite(params.midi)) {
      throw new RangeError(`noteOn: midi must be a finite number, got ${params.midi} (noteId="${params.noteId}")`);
    }
    // MIDI spec is [0,127] — out-of-range is unusual but technically renderable
    // (midiToHz works for any finite input). Warn-via-error only on egregious
    // values so legitimate edge cases (e.g., MIDI 128 mapped to a control note)
    // don't trip the check.
    if (params.midi < -12 || params.midi > 139) {
      throw new RangeError(`noteOn: midi out of sensible range [-12, 139], got ${params.midi} (noteId="${params.noteId}")`);
    }
    if (!Number.isFinite(params.velocity)) {
      throw new RangeError(`noteOn: velocity must be a finite number, got ${params.velocity} (noteId="${params.noteId}")`);
    }
    if (params.velocity < 0 || params.velocity > 1) {
      throw new RangeError(`noteOn: velocity must be in [0, 1], got ${params.velocity} (noteId="${params.noteId}"). MIDI 0-127 callers should divide by 127.`);
    }
    if (params.breathiness !== undefined) {
      if (!Number.isFinite(params.breathiness)) {
        throw new RangeError(`noteOn: breathiness must be a finite number, got ${params.breathiness} (noteId="${params.noteId}")`);
      }
    }
    if (params.portamentoMs !== undefined) {
      if (!Number.isFinite(params.portamentoMs) || params.portamentoMs < 0) {
        throw new RangeError(`noteOn: portamentoMs must be a finite number >= 0, got ${params.portamentoMs} (noteId="${params.noteId}")`);
      }
    }
    if (params.vibrato) {
      const v = params.vibrato;
      if (!Number.isFinite(v.rateHz) || v.rateHz < 0) {
        throw new RangeError(`noteOn: vibrato.rateHz must be a finite number >= 0, got ${v.rateHz} (noteId="${params.noteId}")`);
      }
      if (!Number.isFinite(v.depthCents)) {
        throw new RangeError(`noteOn: vibrato.depthCents must be a finite number, got ${v.depthCents} (noteId="${params.noteId}")`);
      }
      if (!Number.isFinite(v.onsetSec) || v.onsetSec < 0) {
        throw new RangeError(`noteOn: vibrato.onsetSec must be a finite number >= 0, got ${v.onsetSec} (noteId="${params.noteId}")`);
      }
    }
  }

  /** Start a note. Returns voice index and whether a voice was stolen.
   *
   *  EB-001: throws `RangeError` / `TypeError` if any numeric field is
   *  non-finite or out of range. The audio thread CANNOT recover from NaN
   *  propagation silently — explicit throw at the API boundary is the only
   *  way to point the operator at the actual upstream bug. */
  noteOn(params: LiveVoiceParams): { voiceIndex: number; stolen: boolean } {
    this.validateNoteOnParams(params);
    // If a note with the same ID is already playing, retrigger it
    let voice = this.voices.find(v => v.noteId === params.noteId);
    let stolen = false;

    if (!voice) {
      // Find a free voice (fully released — noteId === null).
      voice = this.voices.find(v => v.noteId === null);

      if (!voice) {
        // E-006: voice-steal cost function. Standard policy is:
        //   1. fully free voices (cost 0) — caught above
        //   2. voices in release-and-near-end (low remaining-fade cost)
        //   3. voices in release-and-recent (higher remaining-fade cost)
        //   4. oldest actively-held voice (worst case — interrupting a real note)
        // Held voices are penalized by HELD_STEAL_PENALTY so any releasing
        // voice (even one that just started its release) is preferred over
        // any held voice. Among held voices, the OLDEST wins.
        const HELD_STEAL_PENALTY = 1e9;
        const sr = this.config.sampleRateHz;
        let bestVoice = this.voices[0];
        let bestCost = Infinity;
        for (const v of this.voices) {
          let cost: number;
          if (v.noteOffSample >= 0) {
            // In release: cost = remaining release time in samples (the audio
            // we're about to interrupt). Smaller = closer to end = cheaper.
            const relAgeSamples = this.currentSample - v.noteOffSample;
            const totalRelSamples = v.releaseDurationSec * sr;
            const remainingSamples = Math.max(0, totalRelSamples - relAgeSamples);
            cost = remainingSamples;
          } else {
            // Held voice: full penalty + age-favored ordering so OLDEST held
            // voice (smallest noteOnSample) gets the smallest within-bucket cost.
            cost = HELD_STEAL_PENALTY + v.noteOnSample;
          }
          if (cost < bestCost) {
            bestCost = cost;
            bestVoice = v;
          }
        }
        voice = bestVoice;
        stolen = true;
        // EB-004: surface steal count in telemetry so an operator tuning
        // polyphony can see whether their cap is biting without wrapping
        // noteOn themselves with a counter.
        this.voicesStolenAccum++;
        // Capture last output for crossfade (estimated from envelope * velocity)
        const ageSec = (this.currentSample - voice.noteOnSample) / sr;
        let env = ageSec < 0.01 ? ageSec / 0.01 : 1.0;
        if (voice.noteOffSample >= 0) {
          const relAge = (this.currentSample - voice.noteOffSample) / sr;
          env *= Math.max(0, 1.0 - relAge / voice.releaseDurationSec);
        }
        voice.stealLastOutput = env * voice.velocity;
        const fadeSamples = Math.round(0.01 * sr); // 10ms
        voice.stealFadeSamplesLeft = fadeSamples;
        voice.stealFadeTotal = fadeSamples;
      }
    }

    const prevMidi = voice.midi;
    voice.noteId = params.noteId;
    voice.midi = params.midi;
    voice.velocity = params.velocity;
    voice.timbre = params.timbre ?? null;
    voice.breathiness = params.breathiness ?? this.getDefaultBreathiness(params.timbre);
    voice.vibrato = params.vibrato ?? null;
    voice.portamentoMs = params.portamentoMs ?? 0;
    voice.noteOnSample = this.currentSample;
    voice.noteOffSample = -1;
    voice.releaseDurationSec = 0.1;
    voice.prevMidi = prevMidi;

    return { voiceIndex: voice.index, stolen };
  }

  /** Release a note. releaseMs overrides the default 100ms. */
  noteOff(noteId: string, releaseMs?: number) {
    const voice = this.voices.find(v => v.noteId === noteId && v.noteOffSample === -1);
    if (!voice) return; // already released or not found

    voice.noteOffSample = this.currentSample;
    voice.releaseDurationSec = releaseMs !== undefined ? releaseMs / 1000 : 0.1;
  }

  // ── Config updates ───────────────────────────────────────────

  /** EB-002: maxPolyphony sanity cap. Anything beyond this is almost certainly
   *  a unit-conversion bug or a stuck-key bug, NOT a real operator intent. The
   *  cap is high enough that legitimate large-ensemble work passes, but low
   *  enough that `1e6` (bad parse) trips it before we allocate gigabytes. */
  static readonly MAX_REASONABLE_POLYPHONY = 256;

  updateConfig(updates: Partial<LiveEngineConfig>) {
    // EB-002: validate the entire update set BEFORE applying any of it, so a
    // bad rngSeed doesn't get committed while we then throw on maxPolyphony.
    // Silent degradation here is exactly the bug class that surfaces 4 hours
    // into a live session as 'why are my notes glitching'.
    if (updates.defaultTimbre !== undefined) {
      if (typeof updates.defaultTimbre !== 'string') {
        throw new TypeError(`updateConfig: defaultTimbre must be a string, got ${typeof updates.defaultTimbre}`);
      }
      if (!(updates.defaultTimbre in this.preset.timbres)) {
        const known = Object.keys(this.preset.timbres).join(', ');
        throw new Error(
          `updateConfig: defaultTimbre "${updates.defaultTimbre}" is not in preset.timbres [${known}]. ` +
          `Misspelled timbre IDs silently fall back at render time — fail at the boundary instead.`
        );
      }
    }
    if (updates.rngSeed !== undefined) {
      if (!Number.isFinite(updates.rngSeed) || !Number.isInteger(updates.rngSeed)) {
        throw new RangeError(
          `updateConfig: rngSeed must be a finite integer, got ${updates.rngSeed}. ` +
          `NaN/Infinity seeds break xorshift32 (the zero-trap remap only catches seed===0).`
        );
      }
    }
    if (updates.maxPolyphony !== undefined) {
      const m = updates.maxPolyphony;
      if (!Number.isFinite(m) || !Number.isInteger(m)) {
        throw new RangeError(`updateConfig: maxPolyphony must be a finite integer, got ${m}`);
      }
      if (m < 1) {
        throw new RangeError(
          `updateConfig: maxPolyphony must be >= 1, got ${m}. ` +
          `maxPolyphony=0 leaves an empty allocation pool and the next noteOn() will throw.`
        );
      }
      if (m > LiveSynthEngine.MAX_REASONABLE_POLYPHONY) {
        throw new RangeError(
          `updateConfig: maxPolyphony ${m} exceeds MAX_REASONABLE_POLYPHONY=${LiveSynthEngine.MAX_REASONABLE_POLYPHONY}. ` +
          `Bump the cap deliberately if you need more voices.`
        );
      }
    }
    if (updates.sampleRateHz !== undefined && updates.sampleRateHz !== this.config.sampleRateHz) {
      throw new Error(
        `updateConfig: sampleRateHz is fixed at construction (currently ${this.config.sampleRateHz}). ` +
        `Build a new engine to change sample rate — voice renderers cache it as 1/sr.`
      );
    }
    if (updates.blockSize !== undefined && updates.blockSize !== this.config.blockSize) {
      throw new Error(
        `updateConfig: blockSize is fixed at construction (currently ${this.config.blockSize}). ` +
        `Render buffers are sized at construction; build a new engine to change blockSize.`
      );
    }

    if (updates.defaultTimbre !== undefined) this.config.defaultTimbre = updates.defaultTimbre;

    if (updates.rngSeed !== undefined) {
      this.config.rngSeed = updates.rngSeed;
      // E-007: propagate the new seed to every existing voice's renderer.
      // Previously the seed was stored on this.config but never applied to
      // the voices, so the documented "deterministic seed handling" contract
      // was silently broken — callers couldn't actually re-roll randomness.
      // We use renderer.reseed() (does NOT reset phase) so callers can update
      // noise behavior without disrupting a held vowel's harmonic continuity.
      for (const v of this.voices) {
        v.renderer.reseed(updates.rngSeed + v.index);
      }
    }

    // Polyphony change: grow or shrink voice pool
    if (updates.maxPolyphony !== undefined && updates.maxPolyphony !== this.config.maxPolyphony) {
      const newMax = updates.maxPolyphony;
      if (newMax > this.config.maxPolyphony) {
        for (let i = this.config.maxPolyphony; i < newMax; i++) {
          this.voices.push(this.createVoice(i));
        }
      } else {
        // E-020: shrink without dropping audible release tails. Voices being
        // excised that are still sounding are kicked into release (10ms) AND
        // moved to the sunset list, where render() continues to mix them
        // until their release naturally completes. Without this, a voice in
        // mid-release was silently truncated, producing an audible click.
        for (let i = newMax; i < this.voices.length; i++) {
          const v = this.voices[i];
          if (v.noteId !== null) {
            // Force release if it hasn't started yet so the sunset reaches 0.
            if (v.noteOffSample < 0) {
              v.noteOffSample = this.currentSample;
              v.releaseDurationSec = 0.01;
            }
            this.sunsetVoices.push(v);
          }
        }
        this.voices.length = newMax;
      }
      this.config.maxPolyphony = newMax;
    }
  }

  /** Set global timbre morph weights (null = use per-voice timbre string).
   *
   *  E-013: keys must match preset.timbres (unknown keys throw); values
   *  must be finite numbers in [0, 1] (NaN/Infinity throw, out-of-range
   *  values clamp). This prevents a misspelled key from silently degrading
   *  the morph and protects the render path from Infinity/NaN poisoning.
   */
  setTimbreWeights(weights: Record<string, number> | null) {
    if (weights === null) {
      this.globalTimbreWeights = null;
      return;
    }
    const validKeys = new Set(Object.keys(this.preset.timbres));
    const validated: Record<string, number> = {};
    for (const key of Object.keys(weights)) {
      if (!validKeys.has(key)) {
        throw new Error(
          `setTimbreWeights: unknown timbre key "${key}". ` +
          `Preset timbres: [${Array.from(validKeys).join(', ')}].`
        );
      }
      const v = weights[key];
      if (!Number.isFinite(v)) {
        throw new Error(`setTimbreWeights: value for "${key}" must be finite, got ${v}.`);
      }
      // Clamp to [0, 1]. Negative weights silently flip phase contributions
      // and weights > 1 multiply out-of-range volume into the mix bus, which
      // the soft limiter would then have to clean up.
      const clamped = v < 0 ? 0 : (v > 1 ? 1 : v);
      validated[key] = clamped;
    }
    this.globalTimbreWeights = validated;
  }

  /** Enable/disable soft limiter on mix bus. */
  setLimiter(enabled: boolean) { this.limiterEnabled = enabled; }
  get limiter() { return this.limiterEnabled; }

  // ── Render ───────────────────────────────────────────────────

  /** Render one block of audio. Returns Float32Array of samples. */
  render(): Float32Array {
    const blockSize = this.config.blockSize;
    const sr = this.config.sampleRateHz;
    const out = this.outBuf;
    out.fill(0);

    if (!this.playing) {
      this.currentSample += blockSize;
      return out; // silence
    }

    const t0 = performance.now();
    const timbres = Object.keys(this.preset.timbres);

    // Reuse pre-allocated param buffers
    const pf0 = this.paramF0;
    const pAmp = this.paramAmp;
    const pBreath = this.paramBreath;
    const pTW = this.paramTimbreWeights;
    const voiceOut = this.voiceOutBuf;

    // Track active voices for telemetry
    let activeCount = 0;

    for (const voice of this.voices) {
      if (voice.noteId === null && voice.noteOffSample === -1) continue;

      // Zero the reusable param buffers
      pf0.fill(0);
      pAmp.fill(0);
      pBreath.fill(0);
      for (const t of timbres) pTW[t].fill(0);
      this.paramConsonantAmp.fill(0);
      this.paramConsonantHpfCutoff.fill(0);
      this.paramHarmonicGain.fill(1.0);

      let voiceIsActive = false;

      for (let i = 0; i < blockSize; i++) {
        const sampleIndex = this.currentSample + i;
        const noteAgeSec = (sampleIndex - voice.noteOnSample) / sr;

        // E-005: compute attack and release independently and take min.
        // The old code multiplied them — if a note was released DURING its
        // attack, env = (partialAttack) × (releasing), so the release shape
        // started from a fraction (e.g., 0.3) instead of 1.0, producing a
        // perceived "thump-then-fade" rather than a continuous envelope.
        // min(attack, release) gives an AHDSR-style envelope where the
        // release subtracts from a virtual full-amplitude ceiling, so a
        // mid-attack release sounds continuous from the audible level.
        const attackSec = 0.01; // fast attack for live feel
        const attackEnv = noteAgeSec >= attackSec ? 1.0 :
                          (noteAgeSec <= 0 ? 0 : noteAgeSec / attackSec);

        let releaseEnv = 1.0;
        if (voice.noteOffSample >= 0) {
          const releaseAgeSec = (sampleIndex - voice.noteOffSample) / sr;
          // Surface logic regressions if a refactor lands releaseAgeSec < 0.
          if (releaseAgeSec < 0) {
            // Note-off scheduled in the future of this sample — still in
            // the held phase. Treat as full release env (no fade yet).
            releaseEnv = 1.0;
          } else if (releaseAgeSec >= voice.releaseDurationSec) {
            releaseEnv = 0;
          } else {
            releaseEnv = 1.0 - (releaseAgeSec / voice.releaseDurationSec);
          }
        }

        const env = attackEnv < releaseEnv ? attackEnv : releaseEnv;

        if (env <= 0.0001) continue;

        voiceIsActive = true;

        // Pitch
        let f0 = midiToHz(voice.midi);

        // Portamento
        if (voice.portamentoMs > 0 && noteAgeSec < voice.portamentoMs / 1000) {
          const prevF0 = midiToHz(voice.prevMidi);
          const t = noteAgeSec / (voice.portamentoMs / 1000);
          f0 = prevF0 * Math.pow(f0 / prevF0, t);
        }

        // Vibrato
        if (voice.vibrato) {
          const vibCents = calculateVibrato(
            noteAgeSec + voice.noteOnSample / sr,
            voice.noteOnSample / sr,
            voice.vibrato.rateHz,
            voice.vibrato.depthCents,
            voice.vibrato.onsetSec
          );
          f0 *= centsToRatio(vibCents);
        }

        pf0[i] = f0;
        pAmp[i] = env * voice.velocity;
        pBreath[i] = voice.breathiness;

        // Timbre weights — morphed if XY pad active, else hard switch
        if (this.globalTimbreWeights && !voice.timbre) {
          for (const t of timbres) {
            pTW[t][i] = this.globalTimbreWeights[t] ?? 0;
          }
        } else {
          const activeTimbre = voice.timbre || this.config.defaultTimbre;
          for (const t of timbres) {
            pTW[t][i] = t === activeTimbre ? 1.0 : 0.0;
          }
        }
      }

      if (voiceIsActive) {
        activeCount++;
        // Render into reusable buffer and mix
        const params: RenderParams = {
          f0Hz: pf0,
          amp: pAmp,
          timbreWeights: pTW,
          breathiness: pBreath,
          consonantAmp: this.paramConsonantAmp,
          consonantHpfCutoff: this.paramConsonantHpfCutoff,
          harmonicGain: this.paramHarmonicGain,
        };
        voice.renderer.renderBlock(params, voiceOut);

        // Apply steal crossfade: blend out residual from stolen voice
        if (voice.stealFadeSamplesLeft > 0) {
          for (let i = 0; i < blockSize && voice.stealFadeSamplesLeft > 0; i++) {
            const fadeGain = voice.stealFadeSamplesLeft / voice.stealFadeTotal;
            // Subtract the fading residual (old voice contribution)
            // and scale new voice in (attack ramp already handles this)
            voiceOut[i] *= (1.0 - fadeGain);
            voice.stealFadeSamplesLeft--;
          }
        }

        for (let i = 0; i < blockSize; i++) {
          out[i] += voiceOut[i];
        }
      }

      // Free voice if release is complete
      if (!voiceIsActive && voice.noteOffSample >= 0) {
        voice.noteId = null;
        voice.noteOffSample = -1;
      }
    }

    // E-020: render any sunset voices (excised by a polyphony shrink while
    // still mid-release). Same envelope math + mixing as the main pool, but
    // these voices cannot be re-allocated — once their release completes,
    // they're pruned from sunsetVoices. We track their contribution against
    // activeCount so voicesActive/voicesMaxSeen tell the truth.
    if (this.sunsetVoices.length > 0) {
      for (const voice of this.sunsetVoices) {
        if (voice.noteId === null) continue; // already freed

        pf0.fill(0);
        pAmp.fill(0);
        pBreath.fill(0);
        for (const t of timbres) pTW[t].fill(0);
        this.paramConsonantAmp.fill(0);
        this.paramConsonantHpfCutoff.fill(0);
        this.paramHarmonicGain.fill(1.0);

        let voiceIsActive = false;

        for (let i = 0; i < blockSize; i++) {
          const sampleIndex = this.currentSample + i;
          const noteAgeSec = (sampleIndex - voice.noteOnSample) / sr;

          const attackSec = 0.01;
          const attackEnv = noteAgeSec >= attackSec ? 1.0 :
                            (noteAgeSec <= 0 ? 0 : noteAgeSec / attackSec);

          let releaseEnv = 1.0;
          if (voice.noteOffSample >= 0) {
            const releaseAgeSec = (sampleIndex - voice.noteOffSample) / sr;
            if (releaseAgeSec < 0) {
              releaseEnv = 1.0;
            } else if (releaseAgeSec >= voice.releaseDurationSec) {
              releaseEnv = 0;
            } else {
              releaseEnv = 1.0 - (releaseAgeSec / voice.releaseDurationSec);
            }
          }

          const env = attackEnv < releaseEnv ? attackEnv : releaseEnv;
          if (env <= 0.0001) continue;
          voiceIsActive = true;

          let f0 = midiToHz(voice.midi);
          // Sunset voices don't recompute portamento/vibrato — they're
          // strictly fading out; the held pitch is enough.
          pf0[i] = f0;
          pAmp[i] = env * voice.velocity;
          pBreath[i] = voice.breathiness;

          if (this.globalTimbreWeights && !voice.timbre) {
            for (const t of timbres) {
              pTW[t][i] = this.globalTimbreWeights[t] ?? 0;
            }
          } else {
            const activeTimbre = voice.timbre || this.config.defaultTimbre;
            for (const t of timbres) {
              pTW[t][i] = t === activeTimbre ? 1.0 : 0.0;
            }
          }
        }

        if (voiceIsActive) {
          activeCount++;
          const params: RenderParams = {
            f0Hz: pf0,
            amp: pAmp,
            timbreWeights: pTW,
            breathiness: pBreath,
            consonantAmp: this.paramConsonantAmp,
            consonantHpfCutoff: this.paramConsonantHpfCutoff,
            harmonicGain: this.paramHarmonicGain,
          };
          voice.renderer.renderBlock(params, voiceOut);
          for (let i = 0; i < blockSize; i++) {
            out[i] += voiceOut[i];
          }
        }

        // Mark fully-faded sunset voices for prune (release reached 0).
        if (!voiceIsActive && voice.noteOffSample >= 0) {
          voice.noteId = null;
          voice.noteOffSample = -1;
        }
      }

      // Prune fully-freed sunset voices in-place.
      let writeIdx = 0;
      for (let readIdx = 0; readIdx < this.sunsetVoices.length; readIdx++) {
        if (this.sunsetVoices[readIdx].noteId !== null) {
          if (writeIdx !== readIdx) this.sunsetVoices[writeIdx] = this.sunsetVoices[readIdx];
          writeIdx++;
        }
      }
      this.sunsetVoices.length = writeIdx;
    }

    // E-010: capture PRE-limiter peak so peakDbfs telemetry reflects the
    // true mix-bus level, not the limiter-clipped level. Doing this in a
    // separate loop keeps the limiter loop branch-free.
    //
    // EB-003: NaN/Infinity tripwire. A single NaN sample in the mix bus
    // would otherwise poison peakSample (NaN > anything is false; comparison
    // chains stay NaN), peakDbfs, lastSample, the click-delta detector,
    // and the determinism hash — operators see no signal that the audio bus
    // is corrupted and hunt the bug for days. We scan once per block, zero
    // any non-finite sample IN PLACE (so the audio path stays clean for
    // downstream consumers), and surface the count on telemetry. Operators
    // see `outputNaNCount > 0` and know the engine itself caught it.
    for (let i = 0; i < blockSize; i++) {
      let s = out[i];
      if (!Number.isFinite(s)) {
        this.outputNaNAccum++;
        s = 0;
        out[i] = 0;
      }
      const abs = s < 0 ? -s : s;
      if (abs > this.peakSample) this.peakSample = abs;
    }

    // Soft limiter: tanh-based, transparent below 0.5, soft clips above
    if (this.limiterEnabled) {
      for (let i = 0; i < blockSize; i++) {
        out[i] = Math.tanh(out[i]);
      }
    }

    // Telemetry
    if (activeCount > this.voicesMaxSeen) this.voicesMaxSeen = activeCount;

    // Post-limiter peak and click-delta telemetry. We track post-limiter
    // peak only to compute limiterReductionDb in getTelemetryAndReset().
    for (let i = 0; i < blockSize; i++) {
      const abs = Math.abs(out[i]);
      if (abs > this.peakSamplePost) this.peakSamplePost = abs;

      const delta = Math.abs(out[i] - this.lastSample);
      if (delta > this.maxDelta) this.maxDelta = delta;
      this.lastSample = out[i];
    }

    this.currentSample += blockSize;
    const renderMs = performance.now() - t0;
    this.renderTimeAccumMs += renderMs;
    this.renderBlocksAccum++;

    return out;
  }

  // ── Telemetry ────────────────────────────────────────────────

  /** Read and reset telemetry counters. */
  getTelemetryAndReset(): LiveTelemetry {
    // E-020: include sunset voices (mid-release after a polyphony shrink) so
    // operators see the true sounding-voice count, not just allocation-pool
    // members.
    const activeCount =
      this.voices.filter(v => v.noteId !== null).length +
      this.sunsetVoices.filter(v => v.noteId !== null).length;
    const peak = this.peakSample > 0 ? 20 * Math.log10(this.peakSample) : -Infinity;
    // E-010: limiter reduction = how many dB the limiter pulled the peak
    // down. Positive number; 0 means the limiter was idle (or disabled).
    const limiterReductionDb =
      this.peakSample > 0 && this.peakSamplePost > 0 && this.peakSamplePost < this.peakSample
        ? 20 * Math.log10(this.peakSample / this.peakSamplePost)
        : 0;

    const blockDurationSec = (this.config.blockSize * this.renderBlocksAccum) / this.config.sampleRateHz;
    const rtf = blockDurationSec > 0 ? (this.renderTimeAccumMs / 1000) / blockDurationSec : 0;

    // EB-004: sunset voices are the ones excised by a polyphony shrink that
    // are still audibly fading. The count includes only sunset voices that
    // are still active (noteId !== null) — pruned ones are already gone.
    const sunsetVoiceCount = this.sunsetVoices.filter(v => v.noteId !== null).length;

    const telemetry: LiveTelemetry = {
      voicesActive: activeCount,
      voicesMax: this.voicesMaxSeen,
      peakDbfs: peak,
      limiterReductionDb,
      clickDeltaMaxRecent: this.maxDelta,
      rtf,
      voicesStolenLastWindow: this.voicesStolenAccum,
      sunsetVoiceCount,
      outputNaNCount: this.outputNaNAccum,
    };

    // Reset accumulators
    this.peakSample = 0;
    this.peakSamplePost = 0;
    this.maxDelta = 0;
    this.voicesMaxSeen = activeCount;
    this.renderTimeAccumMs = 0;
    this.renderBlocksAccum = 0;
    this.voicesStolenAccum = 0;
    this.outputNaNAccum = 0;

    return telemetry;
  }

  /** Current time in seconds */
  get currentTimeSec(): number {
    return this.currentSample / this.config.sampleRateHz;
  }

  /** Active voices count (includes sunset voices still in mid-release after
   *  a polyphony shrink — E-020). */
  get activeVoiceCount(): number {
    return (
      this.voices.filter(v => v.noteId !== null).length +
      this.sunsetVoices.filter(v => v.noteId !== null).length
    );
  }

  /** Auto-release notes held longer than maxAgeSec. Returns count released. */
  releaseStuckNotes(maxAgeSec: number): number {
    let released = 0;
    for (const v of this.voices) {
      if (v.noteId !== null && v.noteOffSample === -1) {
        const ageSec = (this.currentSample - v.noteOnSample) / this.config.sampleRateHz;
        if (ageSec > maxAgeSec) {
          v.noteOffSample = this.currentSample;
          v.releaseDurationSec = 0.1;
          released++;
        }
      }
    }
    return released;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private getDefaultBreathiness(timbreName?: string): number {
    const name = timbreName || this.config.defaultTimbre;
    const timbre = this.preset.timbres[name];
    return timbre?.defaults.breathiness ?? 0.1;
  }
}
