import { LoadedVoicePreset } from '../preset/schema.js';
import { interpLinear, xorshift32 } from './curves.js';

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
  private phases: Float32Array;
  private rngState: { seed: number };
  private sampleRate: number;
  private preset: LoadedVoicePreset;
  
  constructor(preset: LoadedVoicePreset, rngSeed: number = 123456789) {
    this.preset = preset;
    this.sampleRate = preset.manifest.sampleRateHz;
    this.rngState = { seed: rngSeed };
    
    // Find max harmonics across all timbres to size the phase array
    let maxH = 0;
    for (const timbre of Object.values(preset.timbres)) {
      if (timbre.harmonicsMag.length > maxH) maxH = timbre.harmonicsMag.length;
    }
    this.phases = new Float32Array(maxH);
  }
  
  public resetPhase(): void {
    this.phases.fill(0);
  }

  renderBlock(params: RenderParams, out: Float32Array): void {
    const numSamples = out.length;
    const timbres = Object.keys(params.timbreWeights);
    
    for (let i = 0; i < numSamples; i++) {
      const f0 = params.f0Hz[i];
      const amp = params.amp[i];
      const breathiness = params.breathiness[i];
      
      if (amp <= 0 || f0 <= 0) {
        out[i] = 0;
        continue;
      }
      
      let sample = 0;
      
      // For each timbre, calculate its contribution
      for (const timbreId of timbres) {
        const weight = params.timbreWeights[timbreId][i];
        if (weight <= 0) continue;
        
        const timbre = this.preset.timbres[timbreId];
        if (!timbre) continue;
        
        const H = timbre.harmonicsMag.length;
        let timbreSample = 0;
        
        for (let k = 1; k <= H; k++) {
          const freq = k * f0;
          if (freq >= this.sampleRate / 2) break;
          
          // Advance phase (only once per sample, not per timbre)
          if (timbreId === timbres[0]) {
            this.phases[k - 1] += (2 * Math.PI * freq) / this.sampleRate;
            if (this.phases[k - 1] > 2 * Math.PI) this.phases[k - 1] -= 2 * Math.PI;
          }
          
          const envDb = interpLinear(timbre.freqHz, timbre.envelopeDb, freq);
          const gain = timbre.harmonicsMag[k - 1] * Math.pow(10, envDb / 20);
          
          timbreSample += gain * Math.sin(this.phases[k - 1]);
        }
        
        sample += timbreSample * weight;
      }
      
      // Noise (simplified white noise scaled by breathiness)
      const noiseVal = (xorshift32(this.rngState) * 2 - 1) * 0.01 * breathiness;
      sample += noiseVal;
      
      out[i] = sample * amp;
    }
  }

  getTelemetryAndReset(): unknown {
    return {
      determinismHash: "sha256:mock_renderer_hash"
    };
  }
}
