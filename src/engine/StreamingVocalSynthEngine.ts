import { VocalScore, VocalNote, PhonemeEvent, TimbreId } from '../types/score.js';
import { LoadedVoicePreset } from '../preset/schema.js';
import { BlockRenderer, MonophonicRenderer, RenderParams } from './renderer.js';
import { midiToHz, centsToRatio, calculateVibrato, calculateAdsr, interpAutomation } from './curves.js';
import { getConsonantProfile, consonantEnvelope, ConsonantProfile } from './consonantProfiles.js';
import { getVowelBlendWeights, TimbreBlendWeights } from '../phonemize/arpabet.js';

export interface StreamingVocalSynthConfig {
  sampleRateHz: number;
  blockSize: number;
  presetPath: string;
  deterministic: "exact" | "fast";
  rngSeed: number;
  defaultTimbre: TimbreId;
  maxPolyphony: number;
  /** Optional max samples per render() call. Allocations are sized to this.
   *  Defaults to blockSize. render() calls with numSamples > this throw. */
  maxBlockSize?: number;
}

interface VoiceState {
  renderer: BlockRenderer;
  activeNote: VocalNote | null;
  noteStartTime: number;
  releaseEndTime: number;
}

/** Score-load-time annotation: cached "previous note" pointer per note,
 *  used for portamento. Computed once in the constructor so we don't
 *  rescan score.notes per sample (E-012). */
interface AnnotatedNote {
  note: VocalNote;
  /** noteEnd = startSec + durationSec (precomputed). */
  noteEndSec: number;
  /** activeEnd = startSec + durationSec + RELEASE_TAIL_SEC. */
  activeEndSec: number;
  /** Previous note in time order (for portamento glide), or null. */
  prevNote: VocalNote | null;
}

/** Per-sample-loop release-tail seconds — must match the value used at
 *  note-activation check inside render() so the cursor advances correctly. */
const RELEASE_TAIL_SEC = 0.1;

export class StreamingVocalSynthEngine {
  private config: StreamingVocalSynthConfig;
  private preset: LoadedVoicePreset;
  private score: VocalScore;
  private voices: VoiceState[];

  /** Notes sorted by startSec with cached prev-note + precomputed bounds. */
  private notesSorted: AnnotatedNote[];
  /** Forward cursor into notesSorted (advances as time progresses). */
  private noteCursor: number = 0;

  private currentSample: number = 0;
  private smoothedTimbreWeights: Record<TimbreId, number> = {};
  /** Sorted phoneme events for timbre-driven rendering */
  private phonemes: PhonemeEvent[];
  /** Cursor for O(1) amortized phoneme lookup */
  private phonemeCursor: number = 0;
  /** Last vowel timbre hint (consonants inherit surrounding vowel context) */
  private lastVowelTimbre: string | null = null;
  /** Last vowel blend weights (consonants/gaps hold these) */
  private lastVowelBlend: TimbreBlendWeights | null = null;
  /** Smoothed harmonic suppression gain (prevents clicks on consonant→vowel) */
  private smoothedHarmonicGain: number = 1.0;

  // ── Pre-allocated render buffers (E-011) ──
  // Per-render allocation was generating ~37 KB/block of garbage every ~5 ms
  // (Float32Array × 7 params × maxPolyphony + voiceOut). Hoisting these into
  // the constructor eliminates RT-thread GC pressure.
  //
  // capacity = the current allocated size; render() auto-grows the buffers
  // (one-time cost) if a caller asks for more samples than we hold. The
  // common-case real-time path still hits zero allocation when called with
  // a stable block size.
  private capacity: number;
  private voiceParams: RenderParams[];
  private voiceOut: Float32Array;
  /** Scratch for activeNotes membership check (reset per sample). */
  private readonly activeNoteSet: Set<VocalNote> = new Set();

  constructor(config: StreamingVocalSynthConfig, preset: LoadedVoicePreset, score: VocalScore) {
    this.config = config;
    this.preset = preset;
    this.score = score;
    this.capacity = config.maxBlockSize ?? config.blockSize;
    this.voices = Array.from({ length: config.maxPolyphony }, (_, i) => ({
      renderer: new MonophonicRenderer(preset, config.rngSeed + i),
      activeNote: null,
      noteStartTime: 0,
      releaseEndTime: 0
    }));

    // Initialize smoothing state
    for (const timbreId of Object.keys(this.preset.timbres)) {
      this.smoothedTimbreWeights[timbreId] = timbreId === config.defaultTimbre ? 1.0 : 0.0;
    }

    // Phoneme events (sorted by tSec for cursor-based lookup)
    this.phonemes = [...(score.phonemes || [])].sort((a, b) => a.tSec - b.tSec);

    // E-012: pre-sort score.notes and cache prev-note for each. The render
    // loop previously did a full O(notes) `.filter` + `.includes` + `.some`
    // per SAMPLE, plus a full O(notes) `for` scan for portamento per sample
    // — that's ~38B per-sample comparisons on a 4-minute / 200-note score.
    // Sort once, scan once with a cursor.
    const sorted = [...this.score.notes].sort((a, b) => a.startSec - b.startSec);
    this.notesSorted = sorted.map((note, idx) => ({
      note,
      noteEndSec: note.startSec + note.durationSec,
      activeEndSec: note.startSec + note.durationSec + RELEASE_TAIL_SEC,
      // prevNote = closest previous note by start time. Since `sorted` is
      // sorted by startSec, the immediate predecessor is at idx-1 unless the
      // current note shares a start time with its predecessor (in which case
      // we walk back until we find a strictly earlier note).
      prevNote: this.findPrevNote(sorted, idx),
    }));

    // Allocate reusable per-voice render param buffers (E-011)
    this.voiceParams = this.voices.map(() => this.makeRenderParams(this.capacity));
    this.voiceOut = new Float32Array(this.capacity);
  }

  /** Grow the pre-allocated buffers to at least `n` samples. One-time cost
   *  per growth — subsequent renders at this size or smaller are alloc-free. */
  private growBuffers(n: number): void {
    if (n <= this.capacity) return;
    // Round up to next power of two to amortize growth across multiple renders.
    let newCap = this.capacity;
    while (newCap < n) newCap *= 2;
    this.capacity = newCap;
    this.voiceParams = this.voices.map(() => this.makeRenderParams(newCap));
    this.voiceOut = new Float32Array(newCap);
  }

  /** Walk back from idx-1 until we find a strictly earlier note. */
  private findPrevNote(sorted: VocalNote[], idx: number): VocalNote | null {
    const current = sorted[idx];
    for (let j = idx - 1; j >= 0; j--) {
      if (sorted[j].startSec < current.startSec) return sorted[j];
    }
    return null;
  }

  /** Build a RenderParams with all buffers pre-allocated to size N. */
  private makeRenderParams(numSamples: number): RenderParams {
    const p: RenderParams = {
      f0Hz: new Float32Array(numSamples),
      amp: new Float32Array(numSamples),
      timbreWeights: {},
      breathiness: new Float32Array(numSamples),
      consonantAmp: new Float32Array(numSamples),
      consonantHpfCutoff: new Float32Array(numSamples),
      harmonicGain: new Float32Array(numSamples),
    };
    p.harmonicGain.fill(1.0);
    for (const timbreId of Object.keys(this.preset.timbres)) {
      p.timbreWeights[timbreId] = new Float32Array(numSamples);
    }
    return p;
  }

  /** Find the active phoneme at a given time. O(1) amortized via forward cursor. */
  private findActivePhoneme(tSec: number): PhonemeEvent | null {
    if (this.phonemes.length === 0) return null;

    // Reset cursor if time jumped backward (e.g., seek)
    if (this.phonemeCursor > 0 && tSec < this.phonemes[this.phonemeCursor - 1].tSec) {
      this.phonemeCursor = 0;
    }

    // Advance cursor past expired phonemes
    while (this.phonemeCursor < this.phonemes.length) {
      const p = this.phonemes[this.phonemeCursor];
      if (tSec < p.tSec + p.durSec) break; // current or future
      this.phonemeCursor++;
    }

    if (this.phonemeCursor >= this.phonemes.length) return null;
    const p = this.phonemes[this.phonemeCursor];
    if (tSec >= p.tSec && tSec < p.tSec + p.durSec) return p;
    return null; // in a gap between phonemes
  }

  /** Populate this.activeNoteSet with all annotated notes active at tSec.
   *  Amortized O(activeNotes) thanks to the noteCursor (E-012). */
  private findActiveNotes(tSec: number, out: Set<VocalNote>): void {
    out.clear();

    // Reset cursor if time jumped backward (e.g., seek/replay).
    if (this.noteCursor > 0 &&
        tSec < this.notesSorted[this.noteCursor - 1].activeEndSec) {
      this.noteCursor = 0;
    }

    // Advance cursor past notes whose active window has already ended.
    while (this.noteCursor < this.notesSorted.length &&
           this.notesSorted[this.noteCursor].activeEndSec <= tSec) {
      this.noteCursor++;
    }

    // Walk forward from the cursor and collect every note whose window
    // contains tSec. Stop as soon as we see a note whose startSec > tSec
    // (no later note can have started earlier).
    for (let j = this.noteCursor; j < this.notesSorted.length; j++) {
      const ann = this.notesSorted[j];
      if (tSec < ann.note.startSec) break;
      if (tSec < ann.activeEndSec) out.add(ann.note);
    }
  }

  /** Find the prev-note cached annotation for `note`. O(1) — we look it up
   *  by reference equality on the sorted array. */
  private getPrevNote(note: VocalNote): VocalNote | null {
    // Linear over notesSorted but only on portamento — and portamento only
    // applies during a short window at note start, so the lookup is rare.
    // (Could be a Map<VocalNote, AnnotatedNote> for O(1) at the cost of
    //  more allocation per note; current scoring is fine.)
    for (const ann of this.notesSorted) {
      if (ann.note === note) return ann.prevNote;
    }
    return null;
  }

  public render(numSamples: number): Float32Array {
    // E-011: auto-grow pre-allocated buffers if needed (one-time cost). The
    // common-case real-time path is called with a stable blockSize and stays
    // alloc-free; callers that ask for a bigger render (e.g. offline rendering
    // a whole song) pay one growth and then remain alloc-free.
    if (numSamples > this.capacity) this.growBuffers(numSamples);

    const out = new Float32Array(numSamples);
    const sampleRate = this.config.sampleRateHz;

    // E-011: reuse pre-allocated voiceParams — zero out only the prefix we'll use.
    for (let v = 0; v < this.voices.length; v++) {
      const vp = this.voiceParams[v];
      vp.f0Hz.fill(0, 0, numSamples);
      vp.amp.fill(0, 0, numSamples);
      vp.breathiness.fill(0, 0, numSamples);
      vp.consonantAmp.fill(0, 0, numSamples);
      vp.consonantHpfCutoff.fill(0, 0, numSamples);
      vp.harmonicGain.fill(1.0, 0, numSamples);
      for (const timbreId of Object.keys(this.preset.timbres)) {
        vp.timbreWeights[timbreId].fill(0, 0, numSamples);
      }
    }

    const activeNotes = this.activeNoteSet;

    for (let i = 0; i < numSamples; i++) {
      const tSec = this.currentSample / sampleRate;

      // 1. Update voice assignments
      // E-012: cursor-based active-note lookup instead of full .filter scan.
      this.findActiveNotes(tSec, activeNotes);

      // Free voices whose notes are no longer active
      for (const voice of this.voices) {
        if (voice.activeNote && !activeNotes.has(voice.activeNote)) {
          voice.activeNote = null;
        }
      }

      // Assign new notes to voices
      for (const note of activeNotes) {
        // Is it already assigned?
        let isAssigned = false;
        for (const v of this.voices) {
          if (v.activeNote === note) { isAssigned = true; break; }
        }
        if (!isAssigned) {
          // Find a free voice
          let freeVoice = this.voices.find(v => v.activeNote === null);
          if (!freeVoice) {
            // Steal oldest voice
            freeVoice = this.voices.reduce((oldest, v) =>
              v.noteStartTime < oldest.noteStartTime ? v : oldest
            );
          }
          freeVoice.activeNote = note;
          freeVoice.noteStartTime = note.startSec;
          freeVoice.releaseEndTime = note.startSec + note.durationSec + RELEASE_TAIL_SEC;
          // Do NOT reset phase here, it causes clicks if stealing an active voice.
          // Let the ADSR envelope handle the fade in/out.
        }
      }

      // 2. Phoneme lookup (shared across timbre + consonant logic)
      const activePhoneme = this.phonemes.length > 0 ? this.findActivePhoneme(tSec) : null;

      // 3. Calculate global timbre weights
      // Priority: lanes.timbreMorph > phoneme timbreHint > defaultTimbre
      const targetWeights: Record<TimbreId, number> = {};
      let sumWeights = 0;

      if (this.score.lanes?.timbreMorph) {
        // Manual automation lanes (highest priority)
        for (const id of Object.keys(this.preset.timbres)) {
          const lane = this.score.lanes.timbreMorph[id];
          let w = lane ? interpAutomation(lane, tSec) : 0.0;
          w = Math.max(0, w);
          targetWeights[id] = w;
          sumWeights += w;
        }
      } else if (this.phonemes.length > 0) {
        // Phoneme-driven timbre with vowel blend weights
        let blend: TimbreBlendWeights | null = null;

        if (activePhoneme) {
          if (activePhoneme.kind === 'vowel') {
            // Look up blend weights for this vowel phoneme
            blend = getVowelBlendWeights(activePhoneme.phoneme);
            if (blend) {
              this.lastVowelBlend = blend;
              this.lastVowelTimbre = activePhoneme.timbreHint ?? null;
            } else {
              // Unknown vowel — fall back to timbreHint hard switch
              if (activePhoneme.timbreHint) {
                this.lastVowelTimbre = activePhoneme.timbreHint;
              }
              blend = this.lastVowelBlend;
            }
          } else {
            // Consonants inherit surrounding vowel blend
            blend = this.lastVowelBlend;
          }
        } else {
          // In gap between phonemes — hold last vowel blend
          blend = this.lastVowelBlend;
        }

        if (blend) {
          // Apply blend weights — map AH/EE/OO keys to preset timbre names
          for (const id of Object.keys(this.preset.timbres)) {
            targetWeights[id] = (blend as any)[id] ?? 0.0;
            sumWeights += targetWeights[id];
          }
        } else {
          // No blend available — use default timbre
          for (const id of Object.keys(this.preset.timbres)) {
            targetWeights[id] = id === this.config.defaultTimbre ? 1.0 : 0.0;
          }
          sumWeights = 1.0;
        }
      } else {
        // No phonemes, no lanes — use default timbre
        for (const id of Object.keys(this.preset.timbres)) {
          targetWeights[id] = id === this.config.defaultTimbre ? 1.0 : 0.0;
        }
        sumWeights = 1.0;
      }

      const alpha = 0.002; // ~10ms smoothing at 48kHz
      for (const id of Object.keys(this.preset.timbres)) {
        const normalizedTarget = sumWeights > 0 ? targetWeights[id] / sumWeights : (id === this.config.defaultTimbre ? 1.0 : 0.0);
        this.smoothedTimbreWeights[id] += alpha * (normalizedTarget - this.smoothedTimbreWeights[id]);
      }

      // 3. Generate parameters for each voice
      for (let vIdx = 0; vIdx < this.voices.length; vIdx++) {
        const voice = this.voices[vIdx];
        const params = this.voiceParams[vIdx];

        if (voice.activeNote) {
          const note = voice.activeNote;

          // Pitch
          let f0 = midiToHz(note.midi);

          // Vibrato
          if (note.vibrato) {
            const vibCents = calculateVibrato(
              tSec,
              note.startSec,
              note.vibrato.rateHz,
              note.vibrato.depthCents,
              note.vibrato.onsetSec
            );
            f0 *= centsToRatio(vibCents);
          }

          // Portamento (E-012: prevNote is pre-cached, no per-sample scan)
          if (note.portamentoSec && note.portamentoSec > 0) {
            const timeInNote = tSec - note.startSec;
            if (timeInNote < note.portamentoSec) {
              const prevNote = this.getPrevNote(note);
              if (prevNote) {
                const prevF0 = midiToHz(prevNote.midi);
                const t = timeInNote / note.portamentoSec;
                f0 = prevF0 * Math.pow(f0 / prevF0, t);
              }
            }
          }

          params.f0Hz[i] = f0;

          // Amplitude (ADSR)
          const velocity = note.velocity ?? 1.0;
          const env = calculateAdsr(tSec, note.startSec, note.startSec + note.durationSec, 0.05, RELEASE_TAIL_SEC);
          params.amp[i] = env * velocity;

          // Timbre (Note override or global)
          if (note.timbre) {
            for (const id of Object.keys(this.preset.timbres)) {
              params.timbreWeights[id][i] = id === note.timbre ? 1.0 : 0.0;
            }
          } else {
            for (const id of Object.keys(this.preset.timbres)) {
              params.timbreWeights[id][i] = this.smoothedTimbreWeights[id];
            }
          }

          // Breathiness
          let currentBreathiness = 0;
          for (const id of Object.keys(this.preset.timbres)) {
            const defaultB = this.preset.timbres[id]?.defaults.breathiness ?? 0.1;
            currentBreathiness += defaultB * params.timbreWeights[id][i];
          }
          params.breathiness[i] = currentBreathiness;

          // Consonant synthesis — use cached activePhoneme from step 2
          if (activePhoneme && activePhoneme.kind === 'consonant') {
            const profile = getConsonantProfile(activePhoneme.phoneme);
            if (profile) {
              const tRel = Math.min(1, Math.max(0,
                (tSec - activePhoneme.tSec) / activePhoneme.durSec));
              const envGain = consonantEnvelope(tRel, profile.envelopeKind);
              const strength = activePhoneme.strength ?? 1.0;
              params.consonantAmp[i] = profile.noiseLevel * envGain * strength;
              params.consonantHpfCutoff[i] = profile.hpfNorm;
              this.smoothedHarmonicGain += alpha * (profile.harmonicGain - this.smoothedHarmonicGain);
            } else {
              params.consonantAmp[i] = 0;
              params.consonantHpfCutoff[i] = 0;
              this.smoothedHarmonicGain += alpha * (1.0 - this.smoothedHarmonicGain);
            }
          } else {
            params.consonantAmp[i] = 0;
            params.consonantHpfCutoff[i] = 0;
            this.smoothedHarmonicGain += alpha * (1.0 - this.smoothedHarmonicGain);
          }
          params.harmonicGain[i] = this.smoothedHarmonicGain;

        } else {
          params.f0Hz[i] = 0;
          params.amp[i] = 0;
          for (const id of Object.keys(this.preset.timbres)) {
            params.timbreWeights[id][i] = 0;
          }
          params.breathiness[i] = 0;
          params.consonantAmp[i] = 0;
          params.consonantHpfCutoff[i] = 0;
          // Relax harmonicGain toward 1.0 during inactive voice
          this.smoothedHarmonicGain += alpha * (1.0 - this.smoothedHarmonicGain);
          params.harmonicGain[i] = this.smoothedHarmonicGain;
        }
      }

      this.currentSample++;
    }

    // 4. Render and mix all voices (E-011: voiceOut is pre-allocated)
    const voiceOut = this.voiceOut;
    for (let vIdx = 0; vIdx < this.voices.length; vIdx++) {
      voiceOut.fill(0, 0, numSamples);
      // The renderer expects the output buffer length to determine block size;
      // pass a subarray view when numSamples < capacity so we don't render
      // beyond the prefix we're consuming.
      const view = numSamples === this.capacity ? voiceOut : voiceOut.subarray(0, numSamples);
      // Build a transient params view if numSamples < capacity, to keep
      // the renderer's loop bound correct. We slice cheaply — TypedArray
      // subarray() does not copy.
      const vp = this.voiceParams[vIdx];
      const params: RenderParams = numSamples === this.capacity ? vp : {
        f0Hz: vp.f0Hz.subarray(0, numSamples),
        amp: vp.amp.subarray(0, numSamples),
        timbreWeights: vp.timbreWeights, // map of full Float32Arrays — renderer reads .length from out
        breathiness: vp.breathiness.subarray(0, numSamples),
        consonantAmp: vp.consonantAmp.subarray(0, numSamples),
        consonantHpfCutoff: vp.consonantHpfCutoff.subarray(0, numSamples),
        harmonicGain: vp.harmonicGain.subarray(0, numSamples),
      };
      // If we passed a partial view, we must also subarray the timbre maps;
      // otherwise the renderer's per-sample loop will read past `out.length`.
      if (numSamples !== this.capacity) {
        const tw: Record<string, Float32Array> = {};
        for (const id of Object.keys(vp.timbreWeights)) {
          tw[id] = vp.timbreWeights[id].subarray(0, numSamples);
        }
        params.timbreWeights = tw;
      }
      this.voices[vIdx].renderer.renderBlock(params, view);
      for (let i = 0; i < numSamples; i++) {
        out[i] += view[i];
      }
    }

    return out;
  }
}
