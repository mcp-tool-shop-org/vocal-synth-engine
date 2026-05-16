/**
 * Inspect a voice preset manifest: print metadata, per-timbre shape,
 * and harmonic energy. Loads + validates the preset through the same
 * loader used by the synth server, so a passing inspect run also proves
 * the preset is structurally valid and assets are readable.
 *
 * Usage: npx tsx src/cli/inspect.ts <path-to-voicepreset.json>
 *        npm run inspect -- <path-to-voicepreset.json>
 *        npx tsx src/cli/inspect.ts --help
 */
import { loadVoicePreset } from '../preset/loader.js';
import { resolve } from 'node:path';

const USAGE = `Usage: npx tsx src/cli/inspect.ts <path-to-voicepreset.json>

Loads a voice preset, validates the manifest + assets, and prints:
  - manifest id, version, sample rate, analysis params
  - per-timbre: harmonic count, frequency-axis bounds, harmonic energy
  - per-timbre default HNR / breathiness / vibrato (as declared in manifest)

Options:
  -h, --help    Show this message and exit.

Exits non-zero if the preset cannot be loaded or fails validation.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    const isHelpFlag = args[0] === '-h' || args[0] === '--help';
    (isHelpFlag ? console.log : console.error)(USAGE);
    process.exit(isHelpFlag ? 0 : 1);
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

      // Manifest-declared defaults (what the preset says — NOT measured here).
      console.log(`Declared defaults (from manifest, not measured):`);
      console.log(`  HNR: ${timbre.defaults.hnrDb} dB`);
      console.log(`  Breathiness: ${timbre.defaults.breathiness}`);
      console.log(`  Vibrato: ${timbre.defaults.vibrato.rateHz} Hz, ${timbre.defaults.vibrato.depthCents} cents, onset ${timbre.defaults.vibrato.onsetMs} ms`);
    }

    // Real telemetry (mean pitch error / RTF / determinism hash from an actual
    // render) is not implemented in this CLI. The previous version printed
    // Math.random()-driven values and a hardcoded "mock" hash labelled as
    // Telemetry, which was misleading. Use `test-score-render` for measured
    // determinism hashes and click checks instead.
    console.log(`\n=== Telemetry: NOT IMPLEMENTED ===`);
    console.log(`This CLI does not render audio or measure pitch/RTF. To get real`);
    console.log(`determinism + click numbers, run a render via:`);
    console.log(`  npx tsx src/cli/test-score-render.ts <preset.json> <score.json>`);

  } catch (err) {
    console.error('Error loading preset:', err);
    process.exit(1);
  }
}

main();
