/**
 * Test G2P pipeline: dictionary lookup, fallback, syllabification,
 * and PhonemeEvent generation.
 *
 * Usage: npx tsx src/cli/test-g2p.ts
 */
import { textToPhonemes, phonemizeLyrics, syllabify, formatSyllables } from '../phonemize/index.js';
import type { VocalNote } from '../types/score.js';

function main() {
  let allPass = true;
  const fail = (msg: string) => { allPass = false; console.log(`  FAIL: ${msg}`); };

  // ── Test 1: Dictionary lookup for "hello" ──
  console.log('Test 1: G2P for "hello"');
  const helloResult = textToPhonemes('hello');
  const helloPhonemes = helloResult[0].phonemes.map(p => p.symbol).join(' ');
  if (helloResult[0].source !== 'dictionary') fail('expected dictionary source');
  if (!helloPhonemes.includes('HH')) fail('expected HH');
  if (!helloPhonemes.includes('OW')) fail('expected OW');
  console.log(`  phonemes: ${helloPhonemes} [${helloResult[0].source}]`);
  console.log(`  ${helloResult[0].source === 'dictionary' ? 'PASS' : 'FAIL'}`);

  // ── Test 2: Syllabification of "hello" ──
  console.log('\nTest 2: Syllabify "hello"');
  const helloSyls = syllabify(helloResult[0].phonemes);
  const helloFmt = formatSyllables(helloSyls);
  if (helloSyls.length !== 2) fail(`expected 2 syllables, got ${helloSyls.length}`);
  console.log(`  syllables: ${helloFmt} (${helloSyls.length})`);
  console.log(`  ${helloSyls.length === 2 ? 'PASS' : 'FAIL'}`);

  // ── Test 3: Multi-word "hello world" ──
  console.log('\nTest 3: G2P for "hello world"');
  const hwResult = textToPhonemes('hello world');
  if (hwResult.length !== 2) fail(`expected 2 words, got ${hwResult.length}`);
  for (const wp of hwResult) {
    console.log(`  ${wp.word}: ${wp.phonemes.map(p => p.symbol).join(' ')} [${wp.source}]`);
    if (wp.source !== 'dictionary') fail(`"${wp.word}" should be in dictionary`);
  }
  console.log(`  ${hwResult.length === 2 && hwResult.every(w => w.source === 'dictionary') ? 'PASS' : 'FAIL'}`);

  // ── Test 4: Fallback G2P for unknown word ──
  console.log('\nTest 4: Fallback for "xyzzyx"');
  const fbResult = textToPhonemes('xyzzyx');
  const hasVowel = fbResult[0].phonemes.some(p => p.kind === 'vowel');
  if (fbResult[0].source !== 'fallback') fail('expected fallback source');
  if (!hasVowel) fail('expected at least one vowel');
  console.log(`  phonemes: ${fbResult[0].phonemes.map(p => p.symbol).join(' ')} [${fbResult[0].source}]`);
  console.log(`  ${fbResult[0].source === 'fallback' && hasVowel ? 'PASS' : 'FAIL'}`);

  // ── Test 5: PhonemeEvent generation (syllable-to-note) ──
  console.log('\nTest 5: phonemizeLyrics with syllable-to-note alignment');
  // "hello" = 2 syllables (HH AH . L OW), "world" = 1 syllable (W ER L D)
  // → 3 syllables total, need 3 notes
  const notes: VocalNote[] = [
    { id: 'n1', startSec: 0.0, durationSec: 0.5, midi: 60 },   // "hel" (HH AH)
    { id: 'n2', startSec: 0.5, durationSec: 0.5, midi: 64 },   // "lo"  (L OW)
    { id: 'n3', startSec: 1.0, durationSec: 0.5, midi: 67 },   // "world" (W ER L D)
  ];
  const result = phonemizeLyrics('hello world', notes);
  const kindsOk = result.events.every(e => e.kind === 'vowel' || e.kind === 'consonant');
  const timbresOk = result.events.filter(e => e.kind === 'vowel').every(e => e.timbreHint !== undefined);
  if (!kindsOk) fail('events have invalid kind');
  if (!timbresOk) fail('vowel events missing timbreHint');
  if (result.events.length === 0) fail('no events generated');
  // Should have 3 vowels (AH, OW, ER) — one per syllable
  const vowelCount = result.events.filter(e => e.kind === 'vowel').length;
  if (vowelCount !== 3) fail(`expected 3 vowels, got ${vowelCount}`);
  for (const e of result.events) {
    console.log(`  t=${e.tSec.toFixed(3)} dur=${e.durSec.toFixed(3)} ${e.phoneme.padEnd(3)} [${e.kind}]`
      + (e.timbreHint ? ` timbre=${e.timbreHint}` : '')
      + (e.strength !== undefined ? ` str=${e.strength}` : ''));
  }
  console.log(`  vowels: ${vowelCount}/3`);
  console.log(`  ${kindsOk && timbresOk && result.events.length > 0 && vowelCount === 3 ? 'PASS' : 'FAIL'}`);

  // ── Test 6: Timing integrity ──
  console.log('\nTest 6: Timing integrity');
  // Each syllable fills exactly one note window
  // Note 1 [0.0, 0.5): "hel" syllable (HH AH)
  const note1Events = result.events.filter(e => e.tSec >= 0.0 && e.tSec < 0.5);
  const note1End = note1Events.reduce((max, e) => Math.max(max, e.tSec + e.durSec), 0);
  const timing1Ok = Math.abs(note1End - 0.5) < 0.001;
  if (!timing1Ok) fail(`note1 end ${note1End.toFixed(4)} != 0.5`);
  console.log(`  note1 span: 0.000 → ${note1End.toFixed(4)} (expected 0.5000)`);

  // Note 2 [0.5, 1.0): "lo" syllable (L OW)
  const note2Events = result.events.filter(e => e.tSec >= 0.5 && e.tSec < 1.0);
  const note2End = note2Events.reduce((max, e) => Math.max(max, e.tSec + e.durSec), 0);
  const timing2Ok = Math.abs(note2End - 1.0) < 0.001;
  if (!timing2Ok) fail(`note2 end ${note2End.toFixed(4)} != 1.0`);
  console.log(`  note2 span: 0.500 → ${note2End.toFixed(4)} (expected 1.0000)`);

  // Note 3 [1.0, 1.5): "world" syllable (W ER L D)
  const note3Events = result.events.filter(e => e.tSec >= 1.0 && e.tSec < 1.5);
  const note3End = note3Events.reduce((max, e) => Math.max(max, e.tSec + e.durSec), 0);
  const timing3Ok = Math.abs(note3End - 1.5) < 0.001;
  if (!timing3Ok) fail(`note3 end ${note3End.toFixed(4)} != 1.5`);
  console.log(`  note3 span: 1.000 → ${note3End.toFixed(4)} (expected 1.5000)`);

  const timingOk = timing1Ok && timing2Ok && timing3Ok;
  console.log(`  ${timingOk ? 'PASS' : 'FAIL'}`);

  // ── Test 7: More syllables than notes → warning ──
  console.log('\nTest 7: Syllable overflow warning');
  const shortNotes: VocalNote[] = [
    { id: 'n1', startSec: 0.0, durationSec: 0.5, midi: 60 },
  ];
  const overflowResult = phonemizeLyrics('hello world', shortNotes);
  // 3 syllables, 1 note → 2 syllables dropped
  const hasWarning = overflowResult.warnings.some(w => w.includes('syllable'));
  if (!hasWarning) fail('expected syllable overflow warning');
  // Only 1 syllable should be assigned (first one)
  const overflowVowels = overflowResult.events.filter(e => e.kind === 'vowel').length;
  if (overflowVowels !== 1) fail(`expected 1 vowel, got ${overflowVowels}`);
  console.log(`  warnings: ${overflowResult.warnings.join('; ')}`);
  console.log(`  events: ${overflowResult.events.length} (${overflowVowels} vowel)`);
  console.log(`  ${hasWarning && overflowVowels === 1 ? 'PASS' : 'FAIL'}`);

  // ── Summary ──
  console.log(`\n${'='.repeat(40)}`);
  console.log(`RESULT: ${allPass ? 'ALL TESTS PASS' : 'SOME TESTS FAILED'}`);
  if (!allPass) process.exit(1);
}

main();
