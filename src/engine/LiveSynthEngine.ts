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
}

export interface LiveTelemetry {
  voicesActive: number;
  voicesMax: number;
  peakDbfs: number;
  clickDeltaMaxRecent: number;
  rtf: number;
}

export class LiveSynthEngine {
  private config: LiveEngineConfig;
  private preset: LoadedVoicePreset;
  private voices: LiveVoice[];
  private currentSample: number = 0;
  private playing: boolean = false;

  // Pre-allocated render buffers (reused every frame — zero GC pressure)
  private outBuf: Float32Array;
  private voiceOutBuf: Float32Array;
  private paramF0: Float32Array;
  private paramAmp: Float32Array;
  private paramBreath: Float32Array;
  private paramTimbreWeights: Record<string, Float32Array>;

  // Global timbre morph weights (null = use per-voice timbre string)
  private globalTimbreWeights: Record<string, number> | null = null;

  // Telemetry accumulators (reset on read)
  private peakSample: number = 0;
  private maxDelta: number = 0;
  private lastSample: number = 0;
  private voicesMaxSeen: number = 0;
  private renderTimeAccumMs: number = 0;
  private renderBlocksAccum: number = 0;

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
    // Zero output buffer so next frame starts clean
    this.outBuf.fill(0);
    // Clear morph weights so we fall back to per-voice timbre
    this.globalTimbreWeights = null;
  }

  // ── Note events ──────────────────────────────────────────────

  /** Start a note. Returns voice index and whether a voice was stolen. */
  noteOn(params: LiveVoiceParams): { voiceIndex: number; stolen: boolean } {
    // If a note with the same ID is already playing, retrigger it
    let voice = this.voices.find(v => v.noteId === params.noteId);
    let stolen = false;

    if (!voice) {
      // Find a free voice (noteId === null AND past release)
      voice = this.voices.find(v => v.noteId === null);

      if (!voice) {
        // Steal oldest active voice
        voice = this.voices.reduce((oldest, v) =>
          v.noteOnSample < oldest.noteOnSample ? v : oldest
        );
        stolen = true;
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

  updateConfig(updates: Partial<LiveEngineConfig>) {
    if (updates.defaultTimbre !== undefined) this.config.defaultTimbre = updates.defaultTimbre;
    if (updates.rngSeed !== undefined) this.config.rngSeed = updates.rngSeed;

    // Polyphony change: grow or shrink voice pool
    if (updates.maxPolyphony !== undefined && updates.maxPolyphony !== this.config.maxPolyphony) {
      const newMax = updates.maxPolyphony;
      if (newMax > this.config.maxPolyphony) {
        for (let i = this.config.maxPolyphony; i < newMax; i++) {
          this.voices.push(this.createVoice(i));
        }
      } else {
        // Shrink: keep first N voices, panic extras
        for (let i = newMax; i < this.voices.length; i++) {
          if (this.voices[i].noteId !== null) {
            this.voices[i].noteOffSample = this.currentSample;
            this.voices[i].releaseDurationSec = 0.01;
          }
        }
        this.voices.length = newMax;
      }
      this.config.maxPolyphony = newMax;
    }
  }

  /** Set global timbre morph weights (null = use per-voice timbre string). */
  setTimbreWeights(weights: Record<string, number> | null) {
    this.globalTimbreWeights = weights;
  }

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

      let voiceIsActive = false;

      for (let i = 0; i < blockSize; i++) {
        const sampleIndex = this.currentSample + i;
        const noteAgeSec = (sampleIndex - voice.noteOnSample) / sr;

        // Envelope
        let env = 1.0;
        const attackSec = 0.01; // fast attack for live feel

        // Attack ramp
        if (noteAgeSec < attackSec) {
          env = noteAgeSec / attackSec;
        }

        // Release
        if (voice.noteOffSample >= 0) {
          const releaseAgeSec = (sampleIndex - voice.noteOffSample) / sr;
          if (releaseAgeSec >= voice.releaseDurationSec) {
            env = 0;
          } else {
            env *= 1.0 - (releaseAgeSec / voice.releaseDurationSec);
          }
        }

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
        };
        voice.renderer.renderBlock(params, voiceOut);
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

    // Telemetry
    if (activeCount > this.voicesMaxSeen) this.voicesMaxSeen = activeCount;

    for (let i = 0; i < blockSize; i++) {
      const abs = Math.abs(out[i]);
      if (abs > this.peakSample) this.peakSample = abs;

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
    const activeCount = this.voices.filter(v => v.noteId !== null).length;
    const peak = this.peakSample > 0 ? 20 * Math.log10(this.peakSample) : -Infinity;

    const blockDurationSec = (this.config.blockSize * this.renderBlocksAccum) / this.config.sampleRateHz;
    const rtf = blockDurationSec > 0 ? (this.renderTimeAccumMs / 1000) / blockDurationSec : 0;

    const telemetry: LiveTelemetry = {
      voicesActive: activeCount,
      voicesMax: this.voicesMaxSeen,
      peakDbfs: peak,
      clickDeltaMaxRecent: this.maxDelta,
      rtf,
    };

    // Reset accumulators
    this.peakSample = 0;
    this.maxDelta = 0;
    this.voicesMaxSeen = activeCount;
    this.renderTimeAccumMs = 0;
    this.renderBlocksAccum = 0;

    return telemetry;
  }

  /** Current time in seconds */
  get currentTimeSec(): number {
    return this.currentSample / this.config.sampleRateHz;
  }

  /** Active voices count */
  get activeVoiceCount(): number {
    return this.voices.filter(v => v.noteId !== null).length;
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
