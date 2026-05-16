#!/usr/bin/env node
/**
 * Standalone phonemize CLI — closes FT-003.
 *
 * Until this CLI existed the G2P pipeline (lyrics text → ARPAbet phonemes →
 * syllabified events with vowel-to-timbre hints) was reachable only via:
 *   (a) POST /api/phonemize (requires booting the express server), or
 *   (b) `import { phonemizeLyrics } from '@mcptoolshop/vocal-synth-engine/...'`
 *       (requires a Node project + writing code).
 *
 * `vse-phonemize` wraps the same `phonemizeLyrics` and `textToPhonemes`
 * exports the server route uses so a user / CI pipeline / researcher can
 * inspect the pronunciation pipeline without any server scaffolding.
 *
 * Usage: vse-phonemize --text "hello world" [--language en-US] [--json]
 *        vse-phonemize --lyrics-file path/to/lyrics.txt [--json]
 *        vse-phonemize --text "hello" --score path/to/score.json [--json]
 *        vse-phonemize --help
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { phonemizeLyrics, textToPhonemes, syllabify } from '../phonemize/index.js';
import { parseVocalScore, VocalScore } from '../types/score.js';
import { runCli, parseCommonFlags, CliError } from './_runner.js';

const USAGE = `Usage: vse-phonemize --text "hello world" [--language en-US] [--json]
       vse-phonemize --lyrics-file path/to/lyrics.txt [--json]
       vse-phonemize --text "hello" --score path/to/score.json [--json]

Convert lyrics text into ARPAbet phonemes with optional syllabification +
note alignment.

Modes:
  TEXT MODE (no --score):    Tokenises + phonemises the text and prints
                             word-level WordPhonemes + per-word syllables.
                             No note alignment; consonant/vowel timings
                             are not produced (those need a note timeline).

  SCORE MODE (--score path): Reads a VocalScore JSON, distributes the
                             phonemes across the note list using the same
                             algorithm POST /api/phonemize uses (the
                             server's actual G2P), and prints PhonemeEvents
                             aligned to each note's startSec/durationSec.

Options:
  --text "<text>"        Lyrics text to phonemise (TEXT or SCORE mode).
  --lyrics-file <path>   Read lyrics text from a file instead of --text.
  --language <BCP-47>    Language tag (default 'en-US'). Non-English tags
                         produce an explicit warning (see TB-006); only
                         English has a phonemization dictionary today.
  --score <path>         Score JSON to align phonemes against. Switches to
                         SCORE MODE; output is the same shape the server's
                         POST /api/phonemize route returns.
  --json                 Emit a single JSON object to stdout instead of
                         human-readable banners.
                         Schema (TEXT MODE):
                           { mode: 'text', language, words:
                             [{word, source, phonemes:[…], syllables:[…]}],
                             warnings: [] }
                         Schema (SCORE MODE):
                           { mode: 'score', language, phonemes:
                             [{tSec, durSec, phoneme, kind, timbreHint?,
                               strength?}], warnings: [] }
  -h, --help             Show this message and exit.

Exits non-zero if no text source is supplied or the score JSON is invalid.

Examples:
  vse-phonemize --text "hello world" --json
  vse-phonemize --lyrics-file lyrics.txt --json
  vse-phonemize --text "la la la" --score test-score.json --json`;

interface ParsedArgs {
  text?: string;
  lyricsFile?: string;
  language?: string;
  scorePath?: string;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs & { help: boolean } {
  const { help, json, positionals } = parseCommonFlags(args);
  let text: string | undefined;
  let lyricsFile: string | undefined;
  let language: string | undefined;
  let scorePath: string | undefined;
  for (let i = 0; i < positionals.length; i++) {
    const a = positionals[i];
    if (a === '--text') text = positionals[++i];
    else if (a.startsWith('--text=')) text = a.slice('--text='.length);
    else if (a === '--lyrics-file') lyricsFile = positionals[++i];
    else if (a.startsWith('--lyrics-file=')) lyricsFile = a.slice('--lyrics-file='.length);
    else if (a === '--language') language = positionals[++i];
    else if (a.startsWith('--language=')) language = a.slice('--language='.length);
    else if (a === '--score') scorePath = positionals[++i];
    else if (a.startsWith('--score=')) scorePath = a.slice('--score='.length);
    else {
      const err: CliError = new Error(`unknown argument '${a}'`);
      err.hint = `run with --help for the full usage block`;
      throw err;
    }
  }
  return { help, json, text, lyricsFile, language, scorePath };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // Resolve the lyrics text from --text or --lyrics-file.
  let lyrics: string | undefined = parsed.text;
  if (parsed.lyricsFile) {
    if (lyrics !== undefined) {
      const err: CliError = new Error(`--text and --lyrics-file are mutually exclusive`);
      err.hint = `pick one; --lyrics-file reads UTF-8 text from disk, --text takes the string inline`;
      throw err;
    }
    try {
      lyrics = await readFile(resolve(parsed.lyricsFile), 'utf-8');
    } catch (err: any) {
      const cliErr: CliError = new Error(
        `failed to read --lyrics-file '${parsed.lyricsFile}': ${err?.message ?? err}`
      );
      cliErr.hint = `verify the path is correct and readable (UTF-8)`;
      throw cliErr;
    }
  }
  if (lyrics === undefined || lyrics === '') {
    const err: CliError = new Error(`no lyrics provided — supply --text or --lyrics-file`);
    err.hint = `e.g. vse-phonemize --text "hello world"`;
    throw err;
  }

  if (parsed.scorePath) {
    // SCORE MODE — read + validate the score, align phonemes against notes.
    const scorePath = resolve(parsed.scorePath);
    let scoreContent: string;
    try {
      scoreContent = await readFile(scorePath, 'utf-8');
    } catch (err: any) {
      const cliErr: CliError = new Error(
        `failed to read --score '${parsed.scorePath}': ${err?.message ?? err}`
      );
      cliErr.hint = `verify the score path is correct and readable`;
      throw cliErr;
    }
    let score: VocalScore;
    try {
      score = parseVocalScore(scoreContent) as VocalScore;
    } catch (err: any) {
      const cliErr: CliError = new Error(
        `invalid score JSON at ${parsed.scorePath}: ${err?.message ?? err}`
      );
      cliErr.hint = `validate against VocalScoreSchema — see src/types/scoreSchema.ts`;
      throw cliErr;
    }
    const result = phonemizeLyrics(lyrics, score.notes, parsed.language);
    if (parsed.json) {
      // Mirrors the shape POST /api/phonemize returns so downstream tools
      // can swap the HTTP call for a CLI invocation without re-parsing.
      const out = {
        mode: 'score' as const,
        language: parsed.language ?? null,
        phonemes: result.events,
        warnings: result.warnings,
      };
      process.stdout.write(JSON.stringify(out) + '\n');
      return;
    }
    console.log(`\n=== Phonemize (score mode) ===`);
    console.log(`Lyrics: ${lyrics.slice(0, 80)}${lyrics.length > 80 ? '...' : ''}`);
    console.log(`Notes:  ${score.notes.length}`);
    console.log(`Events: ${result.events.length}`);
    if (result.warnings.length) {
      console.log(`\nWarnings:`);
      for (const w of result.warnings) console.log(`  - ${w}`);
    }
    console.log(`\nPhoneme events:`);
    for (const ev of result.events) {
      const hint = ev.timbreHint ? ` [hint=${ev.timbreHint}]` : '';
      const strength = ev.strength !== undefined ? ` [strength=${ev.strength.toFixed(2)}]` : '';
      console.log(
        `  t=${ev.tSec.toFixed(3)}s dur=${ev.durSec.toFixed(3)}s ${ev.phoneme} (${ev.kind})${hint}${strength}`
      );
    }
    return;
  }

  // TEXT MODE — just G2P + syllabify; no note alignment.
  const words = textToPhonemes(lyrics);
  const warnings: string[] = [];
  if (parsed.language) {
    // Re-use the same supported-language guard the events pipeline uses by
    // calling phonemizeLyrics with a synthetic empty notes[]. We only want
    // the warning text, not the events.
    const dryRun = phonemizeLyrics('', [], parsed.language);
    warnings.push(...dryRun.warnings);
  }
  for (const w of words) {
    if (w.source === 'fallback') {
      warnings.push(`"${w.word}" not in dictionary — using fallback`);
    }
  }
  if (lyrics.trim().length > 0 && words.length === 0) {
    warnings.push(
      `lyrics text '${lyrics.slice(0, 40)}${lyrics.length > 40 ? '...' : ''}' produced 0 tokens after tokenization`
    );
  }
  // Compute per-word syllables for both human and JSON output.
  const perWordSyllables = words.map((w) => syllabify(w.phonemes));
  if (parsed.json) {
    const out = {
      mode: 'text' as const,
      language: parsed.language ?? null,
      words: words.map((w, i) => ({
        word: w.word,
        source: w.source,
        phonemes: w.phonemes.map((p) => p.symbol),
        syllables: perWordSyllables[i].map((s) => ({
          onset: s.onset.map((p) => p.symbol),
          nucleus: s.nucleus.symbol,
          coda: s.coda.map((p) => p.symbol),
        })),
      })),
      warnings,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  console.log(`\n=== Phonemize (text mode) ===`);
  console.log(`Lyrics: ${lyrics.slice(0, 80)}${lyrics.length > 80 ? '...' : ''}`);
  console.log(`Words:  ${words.length}`);
  if (warnings.length) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log(`\nPer-word phonemes + syllables:`);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const syls = perWordSyllables[i];
    const phonemeStr = w.phonemes.map((p) => p.symbol).join(' ');
    console.log(`  ${w.word.padEnd(20)} [${w.source.padEnd(8)}] ${phonemeStr}`);
    for (const s of syls) {
      const onset = s.onset.map((p) => p.symbol).join('+') || '∅';
      const coda = s.coda.map((p) => p.symbol).join('+') || '∅';
      console.log(`    syllable: ${onset} - ${s.nucleus.symbol} - ${coda}`);
    }
  }
}

runCli('phonemize', main);
