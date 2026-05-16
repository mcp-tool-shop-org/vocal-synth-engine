#!/usr/bin/env node
/**
 * Inspect a voice preset manifest: print metadata, per-timbre shape,
 * and harmonic energy. Loads + validates the preset through the same
 * loader used by the synth server, so a passing inspect run also proves
 * the preset is structurally valid and assets are readable.
 *
 * Usage: npx tsx src/cli/inspect.ts <path-to-voicepreset.json> [--json]
 *        npm run inspect -- <path-to-voicepreset.json>
 *        npx tsx src/cli/inspect.ts --help
 */
import { loadVoicePreset } from '../preset/loader.js';
import { resolve } from 'node:path';
import { runCli, parseCommonFlags, CliError } from './_runner.js';

const USAGE = `Usage: npx tsx src/cli/inspect.ts <path-to-voicepreset.json> [--json]

Loads a voice preset, validates the manifest + assets, and prints:
  - manifest id, version, sample rate, analysis params
  - per-timbre: harmonic count, frequency-axis bounds, harmonic energy
  - per-timbre default HNR / breathiness / vibrato (as declared in manifest)

Example:
  npx tsx src/cli/inspect.ts presets/default-voice/voicepreset.json --json

Options:
  --json        Emit a single JSON object to stdout in lieu of human banners.
                Schema: { manifestPath, id, version, sampleRateHz, analysis,
                          timbres: [{ name, kind, harmonics, freqBins,
                          freqMinHz, freqMaxHz, harmonicEnergy, defaults }] }
  -h, --help    Show this message and exit.

Exits non-zero if the preset cannot be loaded or fails validation.`;

async function main() {
  const { help, json, positionals } = parseCommonFlags(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length === 0) {
    const err: CliError = new Error(`expected a <path-to-voicepreset.json> argument`);
    err.hint = `e.g. npx tsx src/cli/inspect.ts presets/default-voice/voicepreset.json`;
    throw err;
  }

  const manifestPath = resolve(positionals[0]);
  if (!json) console.log(`Loading preset from: ${manifestPath}`);

  const preset = await loadVoicePreset(manifestPath);
  const { manifest, timbres } = preset;

  if (json) {
    // Stable schema — document in CHANGELOG when fields change.
    const out = {
      manifestPath,
      id: manifest.id,
      version: manifest.version,
      sampleRateHz: manifest.sampleRateHz,
      analysis: {
        f0Method: manifest.analysis.f0Method,
        maxHarmonics: manifest.analysis.maxHarmonics,
        frameMs: manifest.analysis.frameMs,
        hopMs: manifest.analysis.hopMs,
      },
      timbres: Object.entries(timbres).map(([name, t]) => {
        let energy = 0;
        for (let i = 0; i < t.harmonicsMag.length; i++) energy += t.harmonicsMag[i] ** 2;
        return {
          name,
          kind: t.kind,
          harmonics: t.harmonicsMag.length,
          freqBins: t.freqHz.length,
          freqMinHz: Number(t.freqHz[0].toFixed(2)),
          freqMaxHz: Number(t.freqHz[t.freqHz.length - 1].toFixed(2)),
          harmonicEnergy: Number(energy.toFixed(6)),
          defaults: {
            hnrDb: t.defaults.hnrDb,
            breathiness: t.defaults.breathiness,
            vibrato: t.defaults.vibrato,
          },
        };
      }),
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

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
  // render) is not implemented in this CLI. T-002 removed the Math.random()
  // fakes; for measured numbers, run play-score.ts (TB-011) which now
  // computes the same determinism hash + max-delta as test-score-render.ts.
  console.log(`\n=== Telemetry: not measured by inspect ===`);
  console.log(`For measured determinism / clicks / RTF, render the preset:`);
  console.log(`  npx tsx src/cli/play-score.ts <preset.json> <score.json> <out.wav>`);
}

runCli('inspect', main);
