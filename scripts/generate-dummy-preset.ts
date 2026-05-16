import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main() {
  const presetDir = join(process.cwd(), 'test-preset');
  const assetsDir = join(presetDir, 'assets');
  
  await mkdir(assetsDir, { recursive: true });

  const manifest = {
    schema: "mcp-voice-engine.voicepreset",
    version: "0.1.0",
    id: "vp_human_female_001",
    sampleRateHz: 48000,
    analysis: {
      frameMs: 20,
      hopMs: 10,
      f0Method: "yin",
      maxHarmonics: 80,
      envelope: { method: "cepstral_lifter", lifterQ: 30 },
      noise: { method: "residual_stft", fftSize: 2048 }
    },
    timbres: [
      {
        name: "AH",
        kind: "vowel",
        assets: {
          harmonicsMag: "assets/AH_harmonics_mag.f32",
          envelopeDb: "assets/AH_envelope_db.f32",
          noiseDb: "assets/AH_noise_db.f32",
          freqHz: "assets/freq_axis_hz.f32"
        },
        defaults: {
          hnrDb: 18,
          breathiness: 0.12,
          vibrato: { rateHz: 5.8, depthCents: 35, onsetMs: 220 }
        }
      },
      {
        name: "OO",
        kind: "vowel",
        assets: {
          harmonicsMag: "assets/OO_harmonics_mag.f32",
          envelopeDb: "assets/OO_envelope_db.f32",
          noiseDb: "assets/OO_noise_db.f32",
          freqHz: "assets/freq_axis_hz.f32"
        },
        defaults: {
          hnrDb: 20,
          breathiness: 0.08,
          vibrato: { rateHz: 5.5, depthCents: 30, onsetMs: 250 }
        }
      }
    ],
    integrity: {
      assetsHash: "sha256:mock",
      analysisHash: "sha256:mock"
    }
  };

  await writeFile(join(presetDir, 'voicepreset.json'), JSON.stringify(manifest, null, 2));

  // Generate dummy binary data
  const H = 80;
  const M = 1025; // 2048 FFT size -> 1025 bins

  const harmonicsMag = new Float32Array(H);
  for (let i = 0; i < H; i++) harmonicsMag[i] = 1.0 / (i + 1); // 1/f decay

  const envelopeDbAH = new Float32Array(M);
  const noiseDbAH = new Float32Array(M);
  const envelopeDbOO = new Float32Array(M);
  const noiseDbOO = new Float32Array(M);
  const freqHz = new Float32Array(M);

  for (let i = 0; i < M; i++) {
    const f = (i / (M - 1)) * 24000;
    freqHz[i] = f;
    
    // AH formant around 800 Hz
    const formantAH = Math.exp(-Math.pow(f - 800, 2) / 200000);
    envelopeDbAH[i] = -10 * Math.log10(i + 1) + (formantAH * 20);
    noiseDbAH[i] = -40;
    
    // OO formant around 300 Hz
    const formantOO = Math.exp(-Math.pow(f - 300, 2) / 50000);
    envelopeDbOO[i] = -15 * Math.log10(i + 1) + (formantOO * 25);
    noiseDbOO[i] = -45;
  }

  const writeF32 = async (name: string, data: Float32Array) => {
    await writeFile(join(assetsDir, name), Buffer.from(data.buffer));
  };

  await writeF32('AH_harmonics_mag.f32', harmonicsMag);
  await writeF32('AH_envelope_db.f32', envelopeDbAH);
  await writeF32('AH_noise_db.f32', noiseDbAH);
  
  await writeF32('OO_harmonics_mag.f32', harmonicsMag); // Share harmonics mag for simplicity
  await writeF32('OO_envelope_db.f32', envelopeDbOO);
  await writeF32('OO_noise_db.f32', noiseDbOO);
  
  await writeF32('freq_axis_hz.f32', freqHz);

  console.log('Dummy preset generated at:', presetDir);
}

main();
