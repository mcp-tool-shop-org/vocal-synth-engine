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

const USAGE = `Usage: npx tsx src/cli/compare.ts <ref.wav> <test.wav>

Compares two WAVs by RMS energy, pitch (YIN), HNR, and spectral correlation
of log magnitudes. Prints PASS/FAIL on Pearson correlation > 0.8.

Options:
  -h, --help    Show this message and exit.`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.length < 2) {
    console.error(USAGE);
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

  // T-005: extract a single center-frame slice and use it for BOTH spectrum
  // and pitch detection. Previously getSpectrum() used a center slice while
  // pitch detection used `mono.subarray(0, 2048)` — the first 2048 samples
  // (~43ms at 48kHz) of a recorded WAV often contain silence or attack and
  // produce noisy or wrong F0. HNR was then computed from those bad F0
  // values, partly driving the PASS/FAIL verdict. Same window everywhere.
  // (Also: T-006 — refuse files shorter than one frame so subarray() doesn't
  // walk off the end and produce garbage.)
  if (refMono.length < fftSize) {
    console.error(`Ref WAV too short: ${refMono.length} samples < required ${fftSize}.`);
    process.exit(1);
  }
  if (testMono.length < fftSize) {
    console.error(`Test WAV too short: ${testMono.length} samples < required ${fftSize}.`);
    process.exit(1);
  }

  const getCenterFrame = (mono: Float32Array): Float32Array => {
    const startIdx = Math.floor(mono.length / 2) - Math.floor(fftSize / 2);
    const frame = new Float32Array(fftSize);
    frame.set(mono.subarray(startIdx, startIdx + fftSize));
    return frame;
  };

  const getSpectrum = (centerFrame: Float32Array) => {
    // Hann-windowing mutates in place, so we copy first to keep the raw
    // center frame around for findPitchYin (YIN expects the unwindowed
    // signal — applying a Hann window before pitch detection would attenuate
    // the edges and bias autocorrelation peaks).
    const frame = new Float32Array(centerFrame);
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

  const refFrame = getCenterFrame(refMono);
  const testFrame = getCenterFrame(testMono);

  const refMag = getSpectrum(refFrame);
  const testMag = getSpectrum(testFrame);

  // Pitch Error — SAME center frame as the spectrum. Avoids the silence/
  // attack bias that taking samples 0..2047 used to introduce.
  const refF0 = findPitchYin(refFrame, 48000);
  const testF0 = findPitchYin(testFrame, 48000);
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
