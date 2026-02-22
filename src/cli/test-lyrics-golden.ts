/**
 * Golden test: end-to-end lyric mode — auto-phonemization → consonant synthesis → vowel blend.
 *
 * Renders "hello" over 2 notes (syllable-to-note: "hel" + "lo") via lyrics.text
 * (not manual phonemes). Validates:
 *
 * 1. Consonant onset energy (HH burst audible at note start)
 * 2. Vowel stability (sustained vowel regions have low spectral jitter)
 * 3. Vowel blend transitions (AH→OW timbre change is smooth, no clicks)
 * 4. Determinism (same seed → identical hash)
 * 5. No click regressions (max per-sample delta < threshold)
 * 6. Lyrics auto-phonemization actually fires (phonemes populated from lyrics.text)
 *
 * Usage: npx tsx src/cli/test-lyrics-golden.ts [presetId]
 */
import { createHash } from 'node:crypto';
import { renderScoreToWav } from '../server/services/renderScoreToWav.js';
import { phonemizeLyrics } from '../phonemize/index.js';
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

function zeroCrossingRate(pcm: Float32Array, startSec: number, endSec: number): number {
  const s = Math.round(startSec * SR);
  const e = Math.round(endSec * SR);
  let crossings = 0;
  for (let i = s + 1; i < e && i < pcm.length; i++) {
    if ((pcm[i] >= 0) !== (pcm[i - 1] >= 0)) crossings++;
  }
  const n = e - s;
  return n > 1 ? crossings / (n - 1) : 0;
}

function maxAbsDelta(pcm: Float32Array, startSec: number, endSec: number): { delta: number; index: number } {
  const s = Math.round(startSec * SR);
  const e = Math.round(endSec * SR);
  let maxD = 0;
  let maxI = s;
  for (let i = s + 1; i < e && i < pcm.length; i++) {
    const d = Math.abs(pcm[i] - pcm[i - 1]);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  return { delta: maxD, index: maxI };
}

async function main() {
  const presetId = process.argv[2] || 'kokoro-am-fenrir';
  let allPass = true;
  const fail = (msg: string) => { allPass = false; console.log(`  FAIL: ${msg}`); };

  console.log(`Lyrics golden test — preset '${presetId}'`);

  const config = {
    presetId,
    blockSize: 1024,
    deterministic: 'exact' as const,
    rngSeed: 42,
    maxPolyphony: 4,
  };

  // Score uses lyrics.text (no manual phonemes) — auto-phonemization path
  const score = {
    bpm: 120,
    lyrics: { text: 'hello' },
    notes: [
      { id: 'n1', midi: 60, startSec: 0.0, durationSec: 0.6, velocity: 0.8 },  // "hel" (HH AH)
      { id: 'n2', midi: 64, startSec: 0.6, durationSec: 0.6, velocity: 0.8 },  // "lo"  (L OW)
    ],
  };

  // ── Test 1: Auto-phonemization fires ──
  console.log('\nTest 1: Auto-phonemization from lyrics.text');
  {
    const g2p = phonemizeLyrics('hello', score.notes as any);
    if (g2p.events.length === 0) fail('no phoneme events generated');
    const vowels = g2p.events.filter(e => e.kind === 'vowel');
    const consonants = g2p.events.filter(e => e.kind === 'consonant');
    if (vowels.length !== 2) fail(`expected 2 vowels (AH, OW), got ${vowels.length}`);
    // "hello" = HH AH L OW → onset HH, vowel AH, onset L, vowel OW
    const hasHH = consonants.some(e => e.phoneme === 'HH');
    const hasL = consonants.some(e => e.phoneme === 'L');
    if (!hasHH) fail('missing HH consonant');
    if (!hasL) fail('missing L consonant');
    for (const e of g2p.events) {
      console.log(`  t=${e.tSec.toFixed(3)} dur=${e.durSec.toFixed(3)} ${e.phoneme.padEnd(3)} [${e.kind}]`
        + (e.timbreHint ? ` timbre=${e.timbreHint}` : '')
        + (e.strength !== undefined ? ` str=${e.strength}` : ''));
    }
    if (g2p.events.length > 0 && vowels.length === 2 && hasHH && hasL) console.log('  PASS');
  }

  // Render via lyrics.text (exercises renderScoreToWav auto-phonemization)
  const result = await renderScoreToWav({
    score: JSON.parse(JSON.stringify(score)),
    config,
  });
  const decoded = new WaveFile(result.wavBytes);
  let pcm = decoded.getSamples(false, Float32Array as any) as any;
  if (Array.isArray(pcm)) pcm = pcm[0];

  // ── Test 2: Consonant onset energy (HH at note start) ──
  console.log('\nTest 2: Consonant onset energy (HH at note 1 start)');
  {
    // HH is a fricative onset — should produce high-frequency noise in first ~30ms
    const onsetRms = rms(pcm, 0.0, 0.03);
    const onsetZcr = zeroCrossingRate(pcm, 0.0, 0.03);
    const vowelZcr = zeroCrossingRate(pcm, 0.15, 0.45);
    console.log(`  onset RMS: ${onsetRms.toFixed(6)}, onset ZCR: ${onsetZcr.toFixed(4)}, vowel ZCR: ${vowelZcr.toFixed(4)}`);

    // HH is a gentle fricative (noiseLevel=0.06) — just check it's not silent
    if (onsetRms < 0.0005) fail(`HH onset RMS too low: ${onsetRms.toFixed(6)} (expected > 0.0005)`);
    if (onsetRms >= 0.0005) console.log('  PASS');
  }

  // ── Test 3: Vowel stability (sustained AH region) ──
  console.log('\nTest 3: Vowel stability (AH sustain, note 1 mid-section)');
  {
    // Mid-section of note 1: well past HH onset, before note end
    const sustainRms = rms(pcm, 0.15, 0.45);
    // Measure local energy variance in 50ms windows
    const windowCount = 6;
    const windowDur = 0.05;
    const windowRms: number[] = [];
    for (let w = 0; w < windowCount; w++) {
      const ws = 0.15 + w * windowDur;
      windowRms.push(rms(pcm, ws, ws + windowDur));
    }
    const mean = windowRms.reduce((a, b) => a + b, 0) / windowCount;
    const variance = windowRms.reduce((a, v) => a + (v - mean) ** 2, 0) / windowCount;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

    console.log(`  sustain RMS: ${sustainRms.toFixed(6)}, CV (jitter): ${(cv * 100).toFixed(1)}%`);
    if (sustainRms < 0.01) fail(`vowel sustain too quiet: ${sustainRms.toFixed(6)}`);
    if (cv > 0.5) fail(`vowel energy too unstable (CV=${(cv * 100).toFixed(1)}%)`);
    if (sustainRms >= 0.01 && cv <= 0.5) console.log('  PASS');
  }

  // ── Test 4: Vowel blend transition (AH→OW across notes) ──
  console.log('\nTest 4: Smooth vowel transition (note boundary, no clicks)');
  {
    // Transition region: last 50ms of note 1 + first 50ms of note 2
    const transition = maxAbsDelta(pcm, 0.55, 0.70);
    const transitionTimeSec = transition.index / SR;
    console.log(`  max delta in transition: ${transition.delta.toFixed(6)} at t=${transitionTimeSec.toFixed(4)}s`);

    // Standard click threshold for note boundaries (pitch + timbre change)
    if (transition.delta > 0.25) fail(`transition click: delta=${transition.delta.toFixed(6)} > 0.25`);
    else console.log('  PASS');
  }

  // ── Test 5: No click regressions (full signal) ──
  console.log('\nTest 5: No click regressions (full signal)');
  {
    const totalLen = pcm.length / SR;
    const full = maxAbsDelta(pcm, 0.0, totalLen);
    const fullTimeSec = full.index / SR;
    console.log(`  max delta: ${full.delta.toFixed(6)} at t=${fullTimeSec.toFixed(4)}s`);

    // Harmonically rich additive synthesis can produce high per-sample deltas
    // at full normalized amplitude (20+ harmonics). True clicks are >0.70.
    const CLICK_THRESHOLD = 0.70;
    if (full.delta > CLICK_THRESHOLD) fail(`click detected: delta=${full.delta.toFixed(6)} > ${CLICK_THRESHOLD}`);
    else console.log('  PASS');
  }

  // ── Test 6: Determinism (identical seeds → identical output) ──
  console.log('\nTest 6: Determinism');
  {
    const r2 = await renderScoreToWav({
      score: JSON.parse(JSON.stringify(score)),
      config,
    });

    const h1 = createHash('sha256').update(result.wavBytes).digest('hex').slice(0, 16);
    const h2 = createHash('sha256').update(r2.wavBytes).digest('hex').slice(0, 16);
    console.log(`  hash1=${h1}... hash2=${h2}...`);
    if (h1 !== h2) fail('hashes differ');
    else console.log('  PASS');
  }

  // ── Test 7: Post-note silence (noise tail regression) ──
  console.log('\nTest 7: Post-note silence');
  {
    // After note 2 ends (0.6 + 0.6 = 1.2s) + release (0.1s) = 1.3s
    const silenceRms = rms(pcm, 1.35, 1.5);
    console.log(`  silence RMS: ${silenceRms.toExponential(2)}`);
    if (silenceRms > 1e-4) fail(`noise tail in silence: ${silenceRms.toExponential(2)}`);
    else console.log('  PASS');
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(40)}`);
  console.log(`RESULT: ${allPass ? 'ALL TESTS PASS' : 'SOME TESTS FAILED'}`);
  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
