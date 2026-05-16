/**
 * Test multi-timbre rendering: render AH → EE → OO and verify
 * spectral differences + determinism + no clicks.
 *
 * Usage: npx tsx scripts/test-multi-timbre.ts [presetId]
 *        npx tsx scripts/test-multi-timbre.ts --help
 *
 * This is a regression script (not a vitest test). Returns exit code 0 on
 * pass, 1 on fail. Slated to migrate to tests/integration/ in a future wave.
 *
 * TB-002 relocation: moved from src/cli/ to scripts/.
 */
import { renderScoreToWav } from '../src/server/services/renderScoreToWav.js';

const USAGE = `Usage: npx tsx scripts/test-multi-timbre.ts [presetId]

Renders a 3-note AH/EE/OO score, then verifies:
  - click test: maxAbsDelta below CLICK_THRESHOLD (post-normalization)
  - determinism: identical wavHash on a second render with the same seed
  - spectral distinction: vowel centroids differ by >100 Hz

Options:
  -h, --help    Show this message and exit.

presetId defaults to 'default-voice'.`;

async function main() {
  const arg0 = process.argv[2];
  if (arg0 === '-h' || arg0 === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  const presetId = arg0 || 'default-voice';

  const score = {
    notes: [
      { midi: 60, startSec: 0.0, durationSec: 0.8, timbre: 'AH', velocity: 0.8 },
      { midi: 60, startSec: 1.0, durationSec: 0.8, timbre: 'EE', velocity: 0.8 },
      { midi: 60, startSec: 2.0, durationSec: 0.8, timbre: 'OO', velocity: 0.8 },
    ],
  };

  const config = {
    presetId,
    blockSize: 1024,
    deterministic: 'exact' as const,
    rngSeed: 123456789,
    maxPolyphony: 4,
  };

  console.log(`Rendering mixed-timbre score with preset '${presetId}'...`);
  const result = await renderScoreToWav({ score, config });
  const { telemetry, provenance } = result;

  console.log(`\nTelemetry:`);
  console.log(`  Duration: ${telemetry.durationSec.toFixed(3)}s`);
  console.log(`  Peak dBFS: ${telemetry.peakDbfs.toFixed(2)}`);
  console.log(`  Max delta: ${telemetry.maxAbsDelta.toFixed(6)} at ${telemetry.maxDeltaTimeSec.toFixed(4)}s`);
  console.log(`  RTF: ${telemetry.rtf.toFixed(4)}`);
  console.log(`  Voices max: ${telemetry.voicesMax}`);

  // --- Click detection ---
  // maxAbsDelta is measured AFTER normalization to peak=1.0. A genuine
  // click would manifest as a near-instantaneous swing to the rails — the
  // companion script test-score-render.ts uses CLICK_THRESHOLD = 0.25 on the
  // same engine path and passes, so 0.25 is the reconciled threshold here too.
  // The previous value (1.95) only fired on full-amplitude swings (max possible
  // delta = 2.0), which made the click check effectively a no-op.
  const CLICK_THRESHOLD = 0.25;
  const clickPass = telemetry.maxAbsDelta < CLICK_THRESHOLD;
  console.log(`\nClick test: maxDelta=${telemetry.maxAbsDelta.toFixed(6)} ${clickPass ? 'PASS' : 'FAIL'} (threshold ${CLICK_THRESHOLD})`);

  // --- Determinism check ---
  // Render again with same seed, verify hash matches
  const result2 = await renderScoreToWav({ score, config });
  const deterministicPass = result2.provenance.wavHash === provenance.wavHash;
  console.log(`Determinism: ${deterministicPass ? 'PASS' : 'FAIL'} (hash1=${provenance.wavHash.slice(0,16)}... hash2=${result2.provenance.wavHash.slice(0,16)}...)`);

  // --- Spectral centroid comparison ---
  // Decode the WAV to get raw PCM, then compute spectral centroid per timbre region
  const wavefile = await import('wavefile');
  const decoded = new wavefile.WaveFile(result.wavBytes);
  let pcm = decoded.getSamples(false, Float32Array as any) as any;
  if (Array.isArray(pcm)) pcm = pcm[0];
  const sr = 48000;

  const regions = [
    { name: 'AH', startSec: 0.15, endSec: 0.65 },
    { name: 'EE', startSec: 1.15, endSec: 1.65 },
    { name: 'OO', startSec: 2.15, endSec: 2.65 },
  ];

  console.log(`\nSpectral centroid per timbre:`);
  const centroids: number[] = [];
  for (const region of regions) {
    const startSamp = Math.round(region.startSec * sr);
    const endSamp = Math.round(region.endSec * sr);
    const segment = pcm.subarray(startSamp, endSamp);

    // Simple spectral centroid via autocorrelation-weighted energy
    // Compute RMS and zero-crossing rate as proxy for spectral content
    let rms = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < segment.length; i++) {
      rms += segment[i] * segment[i];
      if (i > 0 && Math.sign(segment[i]) !== Math.sign(segment[i - 1])) {
        zeroCrossings++;
      }
    }
    rms = Math.sqrt(rms / segment.length);
    const zcRate = zeroCrossings / (segment.length / sr); // crossings per second
    const estCentroidHz = zcRate / 2; // ZCR/2 ≈ dominant frequency

    centroids.push(estCentroidHz);
    console.log(`  ${region.name}: centroid ~${estCentroidHz.toFixed(0)} Hz, RMS ${rms.toFixed(4)}`);
  }

  // Verify timbres are spectrally distinct (centroids should differ)
  const [cAH, cEE, cOO] = centroids;
  const spectrallyDistinct = Math.abs(cAH - cEE) > 100 || Math.abs(cEE - cOO) > 100 || Math.abs(cAH - cOO) > 100;
  console.log(`Spectral distinction: ${spectrallyDistinct ? 'PASS' : 'FAIL'} (centroids differ by >100 Hz)`);

  console.log(`\nWAV size: ${result.wavBytes.length} bytes`);

  // --- Summary ---
  const allPass = clickPass && deterministicPass && spectrallyDistinct;
  console.log(`\n${'='.repeat(40)}`);
  console.log(`RESULT: ${allPass ? 'ALL TESTS PASS' : 'SOME TESTS FAILED'}`);
  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
