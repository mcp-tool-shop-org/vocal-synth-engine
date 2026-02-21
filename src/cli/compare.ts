import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fft, applyHannWindow } from '../dsp/fft.js';
import { findPitchYin } from '../dsp/pitch.js';

function computeHnr(mag: Float32Array, f0: number, sampleRate: number, fftSize: number): number {
  let harmonicEnergy = 0;
  let totalEnergy = 0;
  
  for (let i = 0; i < mag.length; i++) {
    const freq = (i / fftSize) * sampleRate;
    const energy = mag[i] * mag[i];
    totalEnergy += energy;
    
    const harmonicIdx = Math.round(freq / f0);
    if (harmonicIdx > 0) {
      const harmonicFreq = harmonicIdx * f0;
      if (Math.abs(freq - harmonicFreq) < f0 * 0.1) {
        harmonicEnergy += energy;
      }
    }
  }
  
  const noiseEnergy = Math.max(1e-10, totalEnergy - harmonicEnergy);
  return 10 * Math.log10(Math.max(1e-10, harmonicEnergy / noiseEnergy));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx src/cli/compare.ts <ref.wav> <test.wav>');
    process.exit(1);
  }

  const [refPath, testPath] = args;
  const refWav = new WaveFile(await readFile(resolve(refPath)));
  const testWav = new WaveFile(await readFile(resolve(testPath)));
  
  refWav.toSampleRate(48000);
  testWav.toSampleRate(48000);
  
  let refSamples: any = refWav.getSamples(false, Float32Array as any);
  if (Array.isArray(refSamples) || (refSamples.length > 0 && refSamples[0] instanceof Float32Array)) {
    refSamples = refSamples[0];
  }
  const refMono = refSamples as Float32Array;
  
  let testSamples: any = testWav.getSamples(false, Float32Array as any);
  if (Array.isArray(testSamples) || (testSamples.length > 0 && testSamples[0] instanceof Float32Array)) {
    testSamples = testSamples[0];
  }
  const testMono = testSamples as Float32Array;
  
  // RMS Energy
  let refRms = 0;
  for (let i = 0; i < refMono.length; i++) refRms += refMono[i] * refMono[i];
  refRms = Math.sqrt(refRms / refMono.length);
  
  let testRms = 0;
  for (let i = 0; i < testMono.length; i++) testRms += testMono[i] * testMono[i];
  testRms = Math.sqrt(testRms / testMono.length);
  
  console.log(`RMS Energy: Ref=${refRms.toFixed(4)}, Test=${testRms.toFixed(4)}`);
  
  // Spectral Correlation (middle frame)
  const fftSize = 2048;
  const halfFft = fftSize / 2 + 1;
  
  const getSpectrum = (mono: Float32Array) => {
    const startIdx = Math.floor(mono.length / 2) - Math.floor(fftSize / 2);
    const frame = new Float32Array(fftSize);
    frame.set(mono.subarray(startIdx, startIdx + fftSize));
    applyHannWindow(frame);
    const real = new Float32Array(frame);
    const imag = new Float32Array(fftSize);
    fft(real, imag);
    const mag = new Float32Array(halfFft);
    for (let i = 0; i < halfFft; i++) {
      mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return mag;
  };
  
  const refMag = getSpectrum(refMono);
  const testMag = getSpectrum(testMono);
  
  // Pitch Error
  const refF0 = findPitchYin(refMono.subarray(0, 2048), 48000);
  const testF0 = findPitchYin(testMono.subarray(0, 2048), 48000);
  const pitchErrorCents = 1200 * Math.log2(testF0 / refF0);
  console.log(`Pitch Error: ${pitchErrorCents.toFixed(2)} cents (Ref: ${refF0.toFixed(2)} Hz, Test: ${testF0.toFixed(2)} Hz)`);

  // HNR
  const refHnr = computeHnr(refMag, refF0, 48000, fftSize);
  const testHnr = computeHnr(testMag, testF0, 48000, fftSize);
  console.log(`HNR: Ref=${refHnr.toFixed(2)} dB, Test=${testHnr.toFixed(2)} dB (Diff: ${Math.abs(refHnr - testHnr).toFixed(2)} dB)`);

  // Pearson correlation of log magnitudes
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < halfFft; i++) {
    const x = Math.log10(Math.max(1e-6, refMag[i]));
    const y = Math.log10(Math.max(1e-6, testMag[i]));
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  
  const n = halfFft;
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  const correlation = numerator / denominator;
  
  console.log(`Spectral Correlation: ${correlation.toFixed(4)}`);
  
  if (correlation > 0.8) {
    console.log('PASS: Spectral correlation is high.');
  } else {
    console.log('FAIL: Spectral correlation is too low.');
  }
}

main().catch(console.error);
