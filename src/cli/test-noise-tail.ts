/**
 * Regression test: verify noise dies cleanly during note release.
 *
 * Renders EE and OO notes (the worst offenders for static tails),
 * measures RMS energy in the last 200ms of each note's release region,
 * and asserts it drops below a threshold relative to sustain energy.
 *
 * Usage: npx tsx src/cli/test-noise-tail.ts [presetId]
 */
import { renderScoreToWav } from '../server/services/renderScoreToWav.js';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;

const SR = 48000;

function rms(pcm: Float32Array, startSec: number, endSec: number): number {
  const s = Math.round(startSec * SR);
  const e = Math.round(endSec * SR);
  let sum = 0;
  let n = 0;
  for (let i = s; i < e && i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

async function main() {
  const presetId = process.argv[2] || 'kokoro-am-fenrir';

  // Render notes to stress-test noise tail during ADSR release.
  // ADSR: attack=0.05s, release=0.1s. So for a 1.0s note at offset T:
  //   sustain: T+0.05 to T+1.0 (amp=1.0)
  //   release: T+1.0  to T+1.1 (amp ramps 1.0 → 0.0 linearly)
  //   silence: T+1.1+ (amp=0, gate should kill noise)
  const NOTE_DUR = 1.0;
  const SPACING = 2.0;
  const timbres = ['AH', 'EE', 'OO'];
  const notes = timbres.map((t, i) => ({
    id: `tail-${t}`,
    midi: 60,
    startSec: i * SPACING,
    durationSec: NOTE_DUR,
    timbre: t,
    velocity: 0.8,
  }));

  const score = { bpm: 120, notes };
  const config = {
    presetId,
    blockSize: 1024,
    deterministic: 'exact' as const,
    rngSeed: 42,
    maxPolyphony: 4,
  };

  console.log(`Noise tail regression test — preset '${presetId}'`);
  console.log(`Rendering ${timbres.length} notes (${NOTE_DUR}s each)...\n`);

  const result = await renderScoreToWav({ score, config });

  // Decode WAV to raw PCM (pre-normalization changes absolute values,
  // but ratios between regions are preserved)
  const decoded = new WaveFile(result.wavBytes);
  let pcm = decoded.getSamples(false, Float32Array as any) as any;
  if (Array.isArray(pcm)) pcm = pcm[0];

  let allPass = true;

  for (let i = 0; i < timbres.length; i++) {
    const t = timbres[i];
    const ns = i * SPACING; // note start

    // Sustain: well past attack, before note end
    const sustainRms = rms(pcm, ns + 0.2, ns + 0.8);

    // Release region: ADSR ramps amplitude from 1→0 over 0.1s
    const releaseRms = rms(pcm, ns + NOTE_DUR, ns + NOTE_DUR + 0.1);

    // Post-note silence: after release completes + gate closes
    const silenceRms = rms(pcm, ns + NOTE_DUR + 0.15, ns + NOTE_DUR + 0.5);

    const releaseRatio = sustainRms > 0 ? releaseRms / sustainRms : 0;
    const silenceOk = silenceRms < 1e-5;

    // Release energy should be well below sustain. Linear 1→0 ramp over 0.1s
    // gives theoretical RMS ratio of 1/√3 ≈ 57.7%. Different timbres vary
    // (spectral envelope effects); OO/EE typically run 63-70%. Noise component
    // scales as amp^1.6 with gate, so it decays faster than harmonics.
    // Threshold 0.72 catches regression if gamma/gate is removed.
    const RELEASE_RATIO_THRESHOLD = 0.72;
    const releasePass = releaseRatio < RELEASE_RATIO_THRESHOLD;

    const status = (releasePass && silenceOk) ? 'PASS' : 'FAIL';
    if (!releasePass || !silenceOk) allPass = false;

    console.log(`  ${t}: sustain=${sustainRms.toFixed(6)} release=${releaseRms.toFixed(6)} `
      + `ratio=${(releaseRatio * 100).toFixed(1)}% silence=${silenceRms.toExponential(2)} → ${status}`);
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`RESULT: ${allPass ? 'ALL TESTS PASS' : 'SOME TESTS FAILED'}`);
  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
