import { VocalScore, VocalNote, TimbreId } from '../types/score.js';
import { LoadedVoicePreset } from '../preset/schema.js';
import { BlockRenderer, MonophonicRenderer, RenderParams } from './renderer.js';
import { midiToHz, centsToRatio, calculateVibrato, calculateAdsr, interpAutomation } from './curves.js';

export interface StreamingVocalSynthConfig {
  sampleRateHz: number;
  blockSize: number;
  presetPath: string;
  deterministic: "exact" | "fast";
  rngSeed: number;
  defaultTimbre: TimbreId;
  maxPolyphony: number;
}

interface VoiceState {
  renderer: BlockRenderer;
  activeNote: VocalNote | null;
  noteStartTime: number;
  releaseEndTime: number;
}

export class StreamingVocalSynthEngine {
  private config: StreamingVocalSynthConfig;
  private preset: LoadedVoicePreset;
  private score: VocalScore;
  private voices: VoiceState[];
  
  private currentSample: number = 0;
  private smoothedTimbreWeights: Record<TimbreId, number> = {};
  
  constructor(config: StreamingVocalSynthConfig, preset: LoadedVoicePreset, score: VocalScore) {
    this.config = config;
    this.preset = preset;
    this.score = score;
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
  }
  
  public render(numSamples: number): Float32Array {
    const out = new Float32Array(numSamples);
    const sampleRate = this.config.sampleRateHz;
    const releaseSec = 0.1;
    
    // Allocate parameter arrays for each voice
    const voiceParams: RenderParams[] = this.voices.map(() => {
      const p: RenderParams = {
        f0Hz: new Float32Array(numSamples),
        amp: new Float32Array(numSamples),
        timbreWeights: {},
        breathiness: new Float32Array(numSamples)
      };
      for (const timbreId of Object.keys(this.preset.timbres)) {
        p.timbreWeights[timbreId] = new Float32Array(numSamples);
      }
      return p;
    });
    
    for (let i = 0; i < numSamples; i++) {
      const tSec = this.currentSample / sampleRate;
      
      // 1. Update voice assignments
      // Find all notes that should be active at this sample
      const activeNotes = this.score.notes.filter(note => 
        tSec >= note.startSec && tSec < note.startSec + note.durationSec + releaseSec
      );
      
      // Free voices whose notes are no longer active
      for (const voice of this.voices) {
        if (voice.activeNote && !activeNotes.includes(voice.activeNote)) {
          voice.activeNote = null;
        }
      }
      
      // Assign new notes to voices
      for (const note of activeNotes) {
        // Is it already assigned?
        const isAssigned = this.voices.some(v => v.activeNote === note);
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
          freeVoice.releaseEndTime = note.startSec + note.durationSec + releaseSec;
          // Do NOT reset phase here, it causes clicks if stealing an active voice.
          // Let the ADSR envelope handle the fade in/out.
        }
      }
      
      // 2. Calculate global timbre morphing (shared across voices for now)
      const targetWeights: Record<TimbreId, number> = {};
      let sumWeights = 0;
      
      if (this.score.lanes?.timbreMorph) {
        for (const id of Object.keys(this.preset.timbres)) {
          const lane = this.score.lanes.timbreMorph[id];
          let w = lane ? interpAutomation(lane, tSec) : 0.0;
          w = Math.max(0, w);
          targetWeights[id] = w;
          sumWeights += w;
        }
      } else {
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
        const params = voiceParams[vIdx];
        
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
          
          // Portamento
          if (note.portamentoSec && note.portamentoSec > 0) {
            const timeInNote = tSec - note.startSec;
            if (timeInNote < note.portamentoSec) {
              let prevNote: VocalNote | null = null;
              for (const n of this.score.notes) {
                if (n.startSec < note.startSec) {
                  if (!prevNote || n.startSec > prevNote.startSec) {
                    prevNote = n;
                  }
                }
              }
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
          const env = calculateAdsr(tSec, note.startSec, note.startSec + note.durationSec, 0.05, 0.1);
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
          
        } else {
          params.f0Hz[i] = 0;
          params.amp[i] = 0;
          for (const id of Object.keys(this.preset.timbres)) {
            params.timbreWeights[id][i] = 0;
          }
          params.breathiness[i] = 0;
        }
      }
      
      this.currentSample++;
    }
    
    // 4. Render and mix all voices
    const voiceOut = new Float32Array(numSamples);
    for (let vIdx = 0; vIdx < this.voices.length; vIdx++) {
      voiceOut.fill(0);
      this.voices[vIdx].renderer.renderBlock(voiceParams[vIdx], voiceOut);
      for (let i = 0; i < numSamples; i++) {
        out[i] += voiceOut[i];
      }
    }
    
    return out;
  }
}
