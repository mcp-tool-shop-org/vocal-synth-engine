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
  /** FE-004: number of output channels. Defaults to 1 (mono) for backward
   *  compatibility. When set to 2 the renderer interleaves [L0, R0, L1, R1, ...]
   *  samples in the returned Float32Array (so an N-sample mono render becomes
   *  a 2N-element interleaved stereo render) and applies equal-power panning
   *  per voice using `VocalNote.pan` (-1..1, default 0). Mono renders ignore
   *  pan. WAV writers downstream must read `channels` from the engine and
   *  size the file header accordingly. */
  channels?: 1 | 2;
}

/** FE-003: telemetry surface symmetric with LiveSynthEngine.LiveTelemetry.
 *  Read + reset via {@link StreamingVocalSynthEngine.getTelemetryAndReset}. */
export interface StreamingTelemetry {
  /** Total samples emitted since last reset. For stereo, this counts
   *  *frames* (not interleaved samples), matching {@link getCurrentTime}. */
  samplesRendered: number;
  /** Active voices (activeNote !== null) at the moment of read. */
  voicesActive: number;
  /** Peak amplitude on the output bus since last reset, in dBFS.
   *  -Infinity if the bus stayed silent (no samples > 0). For stereo this
   *  is the per-channel peak max across L and R. */
  peakDbfs: number;
  /** Count of non-finite (NaN/Infinity) samples observed and zeroed on
   *  the output bus since last reset. MUST be 0 in steady state — non-zero
   *  is a defect in the DSP chain that the engine itself caught. */
  outputNaNCount: number;
  /** EB-007: number of times growBuffers() fired since last reset.
   *  Each fire is a one-time GC-pressure event for that render block;
   *  bump `maxBlockSize` at construction to keep this at 0 for steady-state
   *  real-time use. */
  growBuffersEvents: number;
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

/** EB-005: sanity cap on maxPolyphony. Anything beyond this is almost
 *  certainly a unit-conversion bug (e.g. a millisecond value passed as a
 *  voice count). Bump deliberately if you really need more voices. */
const MAX_REASONABLE_POLYPHONY = 256;

/** EB-006: ceiling on render(numSamples). The default is one minute of
 *  audio at the engine sampleRate (sr * 60). Anything bigger likely
 *  indicates a unit-conversion bug — chunk by caller instead. */
const MAX_RENDER_SAMPLES_FACTOR = 60; // seconds at engine sampleRate

export class StreamingVocalSynthEngine {
  private config: StreamingVocalSynthConfig;
  /** FE-004: cached channel count (1 or 2). Always resolved at construction
   *  from `config.channels ?? 1` so the render hot path never re-derives it. */
  private channels: 1 | 2;
  private preset: LoadedVoicePreset;
  private score: VocalScore;
  private voices: VoiceState[];

  // ── Telemetry accumulators (FE-003) ───────────────────────────
  /** Total *frames* (mono samples or stereo frames) emitted since last
   *  getTelemetryAndReset(). For stereo, one frame == one [L, R] pair. */
  private samplesRenderedAccum: number = 0;
  /** Max |sample| observed on output bus since last reset. */
  private peakSampleAccum: number = 0;
  /** Count of NaN/Infinity samples zeroed on output bus since last reset. */
  private outputNaNAccum: number = 0;

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
    // EB-005: validate config up-front. Invalid config caught at construction
    // is a 5-minute debug; invalid config that only surfaces 30 minutes into
    // an offline render is a half-day. We throw with the offending value AND
    // the constraint so the operator can fix it without reading the source.
    if (!config || typeof config !== 'object') {
      throw new TypeError('StreamingVocalSynthEngine: config must be an object');
    }
    if (!Number.isFinite(config.sampleRateHz) || config.sampleRateHz <= 0) {
      throw new RangeError(
        `StreamingVocalSynthEngine: sampleRateHz must be a finite number > 0, got ${config.sampleRateHz}. ` +
        `sampleRateHz=0 makes invSampleRate=Infinity and the first-sample math goes Infinity.`
      );
    }
    if (!Number.isInteger(config.blockSize) || config.blockSize < 1) {
      throw new RangeError(
        `StreamingVocalSynthEngine: blockSize must be an integer >= 1, got ${config.blockSize}.`
      );
    }
    if (!Number.isInteger(config.maxPolyphony) || config.maxPolyphony < 1) {
      throw new RangeError(
        `StreamingVocalSynthEngine: maxPolyphony must be an integer >= 1, got ${config.maxPolyphony}. ` +
        `maxPolyphony=0 leaves voices=[] and render() crashes on the empty-array reduce.`
      );
    }
    if (config.maxPolyphony > MAX_REASONABLE_POLYPHONY) {
      throw new RangeError(
        `StreamingVocalSynthEngine: maxPolyphony ${config.maxPolyphony} exceeds ` +
        `MAX_REASONABLE_POLYPHONY=${MAX_REASONABLE_POLYPHONY}. Bump the cap deliberately if you need more voices.`
      );
    }
    if (config.maxBlockSize !== undefined) {
      if (!Number.isInteger(config.maxBlockSize) || config.maxBlockSize < config.blockSize) {
        throw new RangeError(
          `StreamingVocalSynthEngine: maxBlockSize must be an integer >= blockSize (${config.blockSize}), ` +
          `got ${config.maxBlockSize}. maxBlockSize=0 makes growBuffers's "while (newCap < n) newCap *= 2" loop forever.`
        );
      }
    }
    if (!Number.isFinite(config.rngSeed) || !Number.isInteger(config.rngSeed)) {
      throw new RangeError(
        `StreamingVocalSynthEngine: rngSeed must be a finite integer, got ${config.rngSeed}. ` +
        `NaN/Infinity seeds break xorshift32 — the zero-trap remap only catches seed===0.`
      );
    }
    if (typeof config.defaultTimbre !== 'string' || !(config.defaultTimbre in preset.timbres)) {
      const known = Object.keys(preset.timbres).join(', ');
      throw new Error(
        `StreamingVocalSynthEngine: defaultTimbre "${config.defaultTimbre}" is not in preset.timbres [${known}].`
      );
    }
    if (config.channels !== undefined && config.channels !== 1 && config.channels !== 2) {
      throw new RangeError(
        `StreamingVocalSynthEngine: channels must be 1 or 2, got ${config.channels}. ` +
        `Other channel counts are not supported by the renderer's equal-power pan law.`
      );
    }

    this.config = config;
    this.channels = config.channels ?? 1;
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

  /** EB-007: one-shot warn so growBuffers fires aren't completely invisible.
   *  Real-time callers that hit auto-growth lose RTF predictability for a
   *  block; surfacing the warn at least once tells the operator where the
   *  growth came from. */
  private warnedGrowBuffers: boolean = false;
  /** EB-007: count of growBuffers fires for operators wanting structured
   *  visibility. Exposed via {@link getTelemetryAndReset}. */
  private growBuffersEventsAccum: number = 0;

  /** Grow the pre-allocated buffers to at least `n` samples. One-time cost
   *  per growth — subsequent renders at this size or smaller are alloc-free.
   *
   *  EB-007: emits a one-shot console.warn on first runtime growth so an
   *  operator chasing a "mysteriously missed frame" has a breadcrumb. Also
   *  bumps a telemetry counter (see {@link getTelemetryAndReset}). */
  private growBuffers(n: number): void {
    if (n <= this.capacity) return;
    // Round up to next power of two to amortize growth across multiple renders.
    const prev = this.capacity;
    let newCap = prev;
    while (newCap < n) newCap *= 2;
    this.capacity = newCap;
    this.voiceParams = this.voices.map(() => this.makeRenderParams(newCap));
    this.voiceOut = new Float32Array(newCap);
    this.growBuffersEventsAccum++;
    if (!this.warnedGrowBuffers) {
      this.warnedGrowBuffers = true;
      // eslint-disable-next-line no-console
      console.warn(
        `StreamingVocalSynthEngine.growBuffers: capacity ${prev} -> ${newCap} samples ` +
        `for a render of ${n}. This is a one-time GC-pressure event PER growth; ` +
        `pass maxBlockSize at construction to size the buffers up-front and ` +
        `keep the real-time render path alloc-free. ` +
        `(This warning fires once per engine instance — subsequent growths bump ` +
        `growBuffersEvents in getTelemetryAndReset() telemetry instead.)`
      );
    }
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
    // EB-006: validate numSamples at the boundary. Each bad-input case has a
    // distinct silent-failure mode in the body (numSamples=0 → empty array;
    // negative → RangeError deep in `new Float32Array(-1)`; NaN → silent
    // zero-length array PLUS `currentSample += NaN` breaks time math forever;
    // Infinity → growBuffers infinite loop / OOM). Surface them all explicitly.
    if (!Number.isInteger(numSamples) || numSamples < 0) {
      throw new RangeError(
        `StreamingVocalSynthEngine.render: numSamples must be a non-negative integer, got ${numSamples}. ` +
        `NaN/Infinity/negative values silently corrupt currentSample (breaking all subsequent time math) ` +
        `or attempt unbounded allocation.`
      );
    }
    const maxRender = this.config.sampleRateHz * MAX_RENDER_SAMPLES_FACTOR;
    if (numSamples > maxRender) {
      throw new RangeError(
        `StreamingVocalSynthEngine.render: numSamples ${numSamples} exceeds MAX (${maxRender} = ` +
        `${MAX_RENDER_SAMPLES_FACTOR}s at ${this.config.sampleRateHz}Hz). ` +
        `Chunk the render at the caller — single calls > 1 minute are almost certainly a unit-conversion bug.`
      );
    }

    // E-011: auto-grow pre-allocated buffers if needed (one-time cost). The
    // common-case real-time path is called with a stable blockSize and stays
    // alloc-free; callers that ask for a bigger render (e.g. offline rendering
    // a whole song) pay one growth and then remain alloc-free.
    if (numSamples > this.capacity) this.growBuffers(numSamples);

    // FE-004: when channels === 2, returned buffer holds 2N interleaved
    // samples [L0,R0,L1,R1,...]. `numSamples` is the *frame* count (one frame
    // == one [L,R] pair for stereo, one sample for mono) and matches the
    // caller's existing mental model from mono renders. The internal voice
    // buffer voiceOut[i] remains mono per voice — we apply the per-voice
    // equal-power pan gains while mixing into the interleaved output.
    const out = new Float32Array(numSamples * this.channels);
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
          // FE-002: apply score.lanes.dynamics as a multiplier on the per-voice
          // amplitude bus. Lane values are in [0, 1] per scoreSchema (no upper
          // bound enforced but the convention is 0..1); we clamp the multiplier
          // to [0, 1] so a malformed lane can't push amp above 1.0 and require
          // a post-mix limiter pass. Missing lane → multiplier 1.0 (no change),
          // preserving byte-identical output for legacy scores without lanes.
          let dynMul = 1.0;
          if (this.score.lanes?.dynamics && this.score.lanes.dynamics.length > 0) {
            const raw = interpAutomation(this.score.lanes.dynamics, tSec);
            dynMul = raw < 0 ? 0 : (raw > 1 ? 1 : raw);
          }
          params.amp[i] = env * velocity * dynMul;

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
          // FE-002: when score.lanes.breathiness is provided, the lane value
          // OVERRIDES the timbre-derived breathiness mix for that sample (the
          // operator authored an explicit breathy/clean target — respect it).
          // Lane value is in [0, 1]; we clamp to that range so the parameter
          // stays inside the renderer's expected domain. Missing lane → fall
          // back to the per-timbre default-weighted mix that's always been
          // the legacy behavior, so scores without the lane render byte-
          // identical to pre-FE-002.
          if (this.score.lanes?.breathiness && this.score.lanes.breathiness.length > 0) {
            const raw = interpAutomation(this.score.lanes.breathiness, tSec);
            params.breathiness[i] = raw < 0 ? 0 : (raw > 1 ? 1 : raw);
          } else {
            let currentBreathiness = 0;
            for (const id of Object.keys(this.preset.timbres)) {
              const defaultB = this.preset.timbres[id]?.defaults.breathiness ?? 0.1;
              currentBreathiness += defaultB * params.timbreWeights[id][i];
            }
            params.breathiness[i] = currentBreathiness;
          }

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

      // FE-004: equal-power per-voice pan. For mono, gL == 1.0 (skip the
      // pan math entirely — keeps legacy behavior byte-identical). For
      // stereo, gL = cos((pan+1)·PI/4), gR = sin((pan+1)·PI/4) which gives
      // -3 dB center, 0 dB hard left/right, no level dip at the centre
      // (constant-power law, the standard mixing-console / DAW choice).
      const voiceNote = this.voices[vIdx].activeNote;
      const pan = voiceNote?.pan ?? 0;
      if (this.channels === 2) {
        const theta = (pan + 1) * Math.PI * 0.25;
        const gL = Math.cos(theta);
        const gR = Math.sin(theta);
        for (let i = 0; i < numSamples; i++) {
          const s = view[i];
          out[i * 2] += s * gL;
          out[i * 2 + 1] += s * gR;
        }
      } else {
        for (let i = 0; i < numSamples; i++) {
          out[i] += view[i];
        }
      }
    }

    // FE-003: NaN/Infinity scrub on the output bus, mirroring LiveSynthEngine
    // EB-003. A single NaN sample would otherwise poison peakSample (NaN >
    // anything is false) and corrupt every downstream pipeline that hashes
    // or scans the buffer. Zero in place + bump the telemetry counter so
    // operators see "outputNaNCount > 0" and know the engine caught the bug.
    const total = out.length;
    for (let i = 0; i < total; i++) {
      let s = out[i];
      if (!Number.isFinite(s)) {
        this.outputNaNAccum++;
        s = 0;
        out[i] = 0;
      }
      const abs = s < 0 ? -s : s;
      if (abs > this.peakSampleAccum) this.peakSampleAccum = abs;
    }
    this.samplesRenderedAccum += numSamples;

    return out;
  }

  // ── FE-003: Streaming-engine ergonomics surface ─────────────────
  //
  // Pre-FE-003 the only public method was render(). DAW/editor integrations
  // wanting to re-preview after an edit had to discard the engine and rebuild
  // a fresh one — paying score-sorting + voice-allocation cost every time.
  // The methods below mirror LiveSynthEngine's transport+telemetry surface
  // so a streaming engine can be reused across edits.

  /** Current internal render cursor, in seconds. Equal to (samples emitted
   *  so far) / sampleRate. Use this in editors that overlay a playhead. */
  getCurrentTime(): number {
    return this.currentSample / this.config.sampleRateHz;
  }

  /** Fast-forward (or rewind) the render cursor to `timeSec`. Voice state,
   *  phoneme cursor, and note cursor are reset so the next render() picks up
   *  cleanly at the target time. Does NOT emit audio for the skipped span. */
  seek(timeSec: number): void {
    if (!Number.isFinite(timeSec) || timeSec < 0) {
      throw new RangeError(
        `StreamingVocalSynthEngine.seek: timeSec must be a finite non-negative number, got ${timeSec}.`
      );
    }
    this.currentSample = Math.round(timeSec * this.config.sampleRateHz);
    // Reset cursors so the next render's findActiveNotes / findActivePhoneme
    // can re-locate the active window from the new time. Without these
    // resets a backwards seek would silently fall through to "nothing
    // active" until time caught back up to the cursor.
    this.noteCursor = 0;
    this.phonemeCursor = 0;
    // Drop active note assignments — they'll be re-bound on the next render
    // tick from the seek-target time. Phase is preserved per voice so a
    // seek inside a held note doesn't audibly click on first re-render.
    for (const v of this.voices) {
      v.activeNote = null;
      v.noteStartTime = 0;
      v.releaseEndTime = 0;
    }
    // Reset smoothed harmonic-suppression — its slow lerp would otherwise
    // hold a stale consonant target across the seek boundary.
    this.smoothedHarmonicGain = 1.0;
    this.lastVowelTimbre = null;
    this.lastVowelBlend = null;
  }

  /** Return to t=0 with no voice state, no telemetry. Equivalent to a fresh
   *  engine but without re-paying the score-sort + buffer-allocation cost. */
  reset(): void {
    this.currentSample = 0;
    this.noteCursor = 0;
    this.phonemeCursor = 0;
    for (const v of this.voices) {
      v.activeNote = null;
      v.noteStartTime = 0;
      v.releaseEndTime = 0;
      // Reset oscillator phase so the next note's first sample is at phase 0
      // — without this, a reset() that lands inside a held note would carry
      // accumulated phase from the previous render run.
      v.renderer.resetPhase();
    }
    this.smoothedHarmonicGain = 1.0;
    this.lastVowelTimbre = null;
    this.lastVowelBlend = null;
    // Re-seed smoothed timbre weights to the default timbre, mirroring the
    // constructor's initial state — without this a previous render's blend
    // would persist as the starting point for the new playback.
    for (const timbreId of Object.keys(this.preset.timbres)) {
      this.smoothedTimbreWeights[timbreId] =
        timbreId === this.config.defaultTimbre ? 1.0 : 0.0;
    }
    // Telemetry accumulators are PER-PLAY-RANGE, not engine-lifetime, so
    // reset() clears them too. (Operators wanting to keep cross-reset
    // counters should snapshot via getTelemetryAndReset() first.)
    this.samplesRenderedAccum = 0;
    this.peakSampleAccum = 0;
    this.outputNaNAccum = 0;
    this.growBuffersEventsAccum = 0;
  }

  /** Stop every voice immediately, reset render state. Symmetric with
   *  LiveSynthEngine.panic(). Like reset() but explicit semantics for
   *  emergency-stop scenarios (stuck note, runaway voice). */
  panic(): void {
    for (const v of this.voices) {
      v.activeNote = null;
      v.noteStartTime = 0;
      v.releaseEndTime = 0;
      v.renderer.resetPhase();
    }
    this.smoothedHarmonicGain = 1.0;
    this.lastVowelTimbre = null;
    this.lastVowelBlend = null;
    // Note: panic() does NOT rewind the render cursor — the operator may
    // want to keep playing forward after silencing the stuck voices. Use
    // reset() to rewind to t=0.
  }

  /** Swap the automation lanes on the underlying score in place. Useful for
   *  DAW workflows where the user is dragging a dynamics or breathiness
   *  envelope and wants to re-preview without rebuilding the engine. The
   *  notes themselves are unchanged — call setScore() to swap notes too. */
  setLanes(lanes: VocalScore['lanes']): void {
    this.score = { ...this.score, lanes };
  }

  /** Swap the entire score and rewind to t=0. Re-sorts notes and re-caches
   *  prevNote pointers — cost is O(N log N) on note count, same as the
   *  constructor. Use this for edit-loop workflows where the score has
   *  structural changes (notes added/removed/moved) that setLanes() can't
   *  express. */
  setScore(score: VocalScore): void {
    this.score = score;
    // Re-sort + re-annotate notes (mirrors constructor logic).
    const sorted = [...score.notes].sort((a, b) => a.startSec - b.startSec);
    this.notesSorted = sorted.map((note, idx) => ({
      note,
      noteEndSec: note.startSec + note.durationSec,
      activeEndSec: note.startSec + note.durationSec + RELEASE_TAIL_SEC,
      prevNote: this.findPrevNote(sorted, idx),
    }));
    // Re-sort phonemes too (the score might have come with a new lyric track).
    this.phonemes = [...(score.phonemes || [])].sort((a, b) => a.tSec - b.tSec);
    // Rewind to t=0 with no carryover state — semantics match a fresh
    // engine for the new score.
    this.reset();
  }

  /** Read + reset telemetry counters. Mirrors LiveSynthEngine.getTelemetryAndReset(). */
  getTelemetryAndReset(): StreamingTelemetry {
    const voicesActive = this.voices.filter(v => v.activeNote !== null).length;
    const peakDbfs =
      this.peakSampleAccum > 0 ? 20 * Math.log10(this.peakSampleAccum) : -Infinity;
    const telemetry: StreamingTelemetry = {
      samplesRendered: this.samplesRenderedAccum,
      voicesActive,
      peakDbfs,
      outputNaNCount: this.outputNaNAccum,
      growBuffersEvents: this.growBuffersEventsAccum,
    };
    this.samplesRenderedAccum = 0;
    this.peakSampleAccum = 0;
    this.outputNaNAccum = 0;
    this.growBuffersEventsAccum = 0;
    return telemetry;
  }

  /** FE-004: number of output channels (1 or 2). Public read so WAV writers
   *  and other downstream consumers can read the channel count from the
   *  engine instead of from the original config. */
  get outputChannels(): 1 | 2 {
    return this.channels;
  }
}
