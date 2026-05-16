import { loadVoicePreset } from '../preset/loader.js';
import { resolve } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx src/cli/inspect.ts <path-to-voicepreset.json>');
    process.exit(1);
  }

  const manifestPath = resolve(args[0]);
  console.log(`Loading preset from: ${manifestPath}`);
  
  try {
    const preset = await loadVoicePreset(manifestPath);
    const { manifest, timbres } = preset;
    
    console.log(`\n=== Preset: ${manifest.id} (v${manifest.version}) ===`);
    console.log(`Sample Rate: ${manifest.sampleRateHz} Hz`);
    console.log(`Analysis: ${manifest.analysis.f0Method}, ${manifest.analysis.maxHarmonics} harmonics`);
    
    for (const [name, timbre] of Object.entries(timbres)) {
      console.log(`\n--- Timbre: ${name} (${timbre.kind}) ---`);
      console.log(`Harmonics (H): ${timbre.harmonicsMag.length}`);
      
      const freqMin = timbre.freqHz[0];
      const freqMax = timbre.freqHz[timbre.freqHz.length - 1];
      console.log(`Freq Axis Bounds: ${freqMin.toFixed(1)} Hz - ${freqMax.toFixed(1)} Hz (${timbre.freqHz.length} bins)`);
      
      // Calculate energy (sum of squared magnitudes)
      let energy = 0;
      for (let i = 0; i < timbre.harmonicsMag.length; i++) {
        energy += timbre.harmonicsMag[i] ** 2;
      }
      console.log(`Harmonic Energy: ${energy.toFixed(4)}`);
      
      console.log(`Defaults:`);
      console.log(`  HNR: ${timbre.defaults.hnrDb} dB`);
      console.log(`  Breathiness: ${timbre.defaults.breathiness}`);
      console.log(`  Vibrato: ${timbre.defaults.vibrato.rateHz} Hz, ${timbre.defaults.vibrato.depthCents} cents, onset ${timbre.defaults.vibrato.onsetMs} ms`);
    }

    // Mock telemetry for a 1-second sustained note
    console.log(`\n=== Telemetry (1-second sustained note simulation) ===`);
    const telemetry = {
      durationMs: 1000,
      targetF0: 220.0,
      meanPitchErrorCents: parseFloat((Math.random() * 2 - 1).toFixed(2)), // Mock error
      actualVibratoRateHz: timbres[Object.keys(timbres)[0]].defaults.vibrato.rateHz,
      actualHnrDb: timbres[Object.keys(timbres)[0]].defaults.hnrDb,
      rtf: 0.045, // Mock Real-Time Factor
      determinismHash: "sha256:mockhash1234567890abcdef"
    };
    console.log(JSON.stringify(telemetry, null, 2));

  } catch (err) {
    console.error('Error loading preset:', err);
    process.exit(1);
  }
}

main();
