import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main() {
  const sampleRate = 48000;
  const durationSec = 2;
  const numSamples = sampleRate * durationSec;
  const f0 = 220.0; // A3
  
  const buffer = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    
    // Add harmonics with a simple formant-like envelope
    for (let k = 1; k <= 20; k++) {
      const freq = k * f0;
      // Simple formant around 800 Hz
      const formantGain = Math.exp(-Math.pow(freq - 800, 2) / 200000);
      const baseGain = 1.0 / k;
      sample += (baseGain + formantGain * 2) * Math.sin(2 * Math.PI * freq * t);
    }
    
    // Add some noise
    sample += (Math.random() * 2 - 1) * 0.05;
    
    buffer[i] = sample;
  }
  
  // Normalize
  let maxVal = 0;
  for (let i = 0; i < numSamples; i++) {
    if (Math.abs(buffer[i]) > maxVal) maxVal = Math.abs(buffer[i]);
  }
  for (let i = 0; i < numSamples; i++) buffer[i] /= maxVal;
  
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, '32f', buffer);
  
  await mkdir('ref', { recursive: true });
  await writeFile(join('ref', 'ah_sustain.wav'), wav.toBuffer());
  console.log('Generated ref/ah_sustain.wav');
}

main().catch(console.error);
