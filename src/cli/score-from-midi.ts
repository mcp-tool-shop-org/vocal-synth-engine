#!/usr/bin/env node
/**
 * Score-from-MIDI CLI — closes FT-002.
 *
 * Before this CLI shipped, the only way to feed the synth was a hand-written
 * VocalScore JSON (test-score.json / test-score-lyrics.json are 40+-line
 * exemplars maintained by hand). `vse-score-from-midi` parses a standard
 * `.mid` file (format 0 or 1) and produces a VocalScore that play-score.ts
 * can render directly.
 *
 * Mapping rules (locked schema — bump SCORE_FROM_MIDI_OUTPUT_SCHEMA below):
 *   - First Set Tempo meta event chooses bpm; default 120 if none present.
 *   - All tracks are merged; noteOn(velocity=0) is treated as noteOff (the
 *     MIDI Running-status convention).
 *   - Each pairing of noteOn ↔ noteOff/noteOn-vel-0 on the same channel +
 *     noteNumber emits one VocalNote.
 *   - VocalNote.id = `note_<index>` (stable across the same input).
 *   - VocalNote.startSec = absolute time of the noteOn (tick → seconds via
 *     ticksPerBeat * microsecondsPerBeat).
 *   - VocalNote.durationSec = noteOff time − noteOn time (clamped to
 *     >= 0.001s so the VocalScoreSchema `.positive()` refinement holds).
 *   - VocalNote.midi = noteNumber.
 *   - VocalNote.velocity = velocity / 127 (so MIDI vel 100 → 0.787).
 *   - VocalNote.timbre = --default-timbre (optional CLI flag; omitted when
 *     not supplied so the synth engine's defaultTimbre takes over).
 *   - Rests are NOT padded as silence in the score itself (VocalScore is a
 *     sparse note list — rests are simply gaps between startSec/durationSec).
 *     The doc-string at the top of FT-002 calls for "pad rests as silence";
 *     because the engine renders silence in any time-window not covered by
 *     a note, no explicit pad notes are needed and would in fact confuse
 *     the score-render math. We document this clearly in --help.
 *
 * Usage: vse-score-from-midi <input.mid> [--out song.json] [--bpm-override 120]
 *                            [--default-timbre AH] [--default-velocity 1.0]
 *                            [--json]
 *        vse-score-from-midi --help
 *
 * Exits non-zero if the MIDI parse fails or the produced score fails
 * validation against VocalScoreSchema.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseMidi } from 'midi-file';
import { VocalScore, VocalNote, parseVocalScore } from '../types/score.js';
import { runCli, parseCommonFlags, parseFiniteNumber, CliError } from './_runner.js';

/**
 * Output schema version — bump when fields are added/removed/renamed so a
 * downstream pipeline can pin against a known shape.
 */
const SCORE_FROM_MIDI_OUTPUT_SCHEMA = '1.0.0';

const USAGE = `Usage: vse-score-from-midi <input.mid> [--out song.json] [--bpm-override 120]
                          [--default-timbre AH] [--default-velocity 1.0]
                          [--json]

Parses a standard MIDI file and emits a VocalScore JSON the play-score CLI
(and the /api/render server route) can render directly.

Mapping (schema v${SCORE_FROM_MIDI_OUTPUT_SCHEMA}):
  - First Set Tempo meta event chooses bpm; default 120 if none present.
  - All tracks are merged; noteOn(vel=0) is treated as noteOff.
  - Each noteOn ↔ noteOff pair emits one VocalNote with:
      id            = note_<index>
      startSec      = absolute time of noteOn
      durationSec   = noteOff time − noteOn time (clamped >= 0.001s)
      midi          = noteNumber
      velocity      = velocity / 127  (or --default-velocity if vel=0)
      timbre        = --default-timbre, if supplied
  - Rests are NOT padded — VocalScore is sparse, the engine renders
    silence in any time-window not covered by a note.

Arguments:
  <input.mid>            Path to a Type-0 or Type-1 MIDI file.

Options:
  --out <path>           Write the VocalScore JSON to <path>. Default:
                         <input>.score.json next to the MIDI file.
  --bpm-override <bpm>   Override the BPM derived from Set Tempo.
  --default-timbre <id>  Set timbre on every emitted note (default: omit).
  --default-velocity <v> Velocity to use when the MIDI noteOn velocity is 0
                         (default: 1.0). 0 < v <= 1.
  --json                 Emit a single JSON summary object to stdout instead
                         of human banners.
                         Schema (stable):
                           { schema: '${SCORE_FROM_MIDI_OUTPUT_SCHEMA}',
                             input, out, bpm, notes, durationSec,
                             trackCount }
  -h, --help             Show this message and exit.

Examples:
  vse-score-from-midi song.mid --out song.score.json
  vse-score-from-midi song.mid --bpm-override 100 --default-timbre AH
  vse-score-from-midi song.mid --json --out song.score.json`;

interface ParsedArgs {
  input?: string;
  outPath?: string;
  bpmOverride?: number;
  defaultTimbre?: string;
  defaultVelocity: number;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs & { help: boolean } {
  const { help, json, positionals } = parseCommonFlags(args);
  let input: string | undefined;
  let outPath: string | undefined;
  let bpmOverride: number | undefined;
  let defaultTimbre: string | undefined;
  let defaultVelocity = 1.0;
  for (let i = 0; i < positionals.length; i++) {
    const a = positionals[i];
    if (a === '--out') outPath = positionals[++i];
    else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
    else if (a === '--bpm-override') bpmOverride = parseFiniteNumber(positionals[++i], 'bpm-override');
    else if (a.startsWith('--bpm-override=')) bpmOverride = parseFiniteNumber(a.slice('--bpm-override='.length), 'bpm-override');
    else if (a === '--default-timbre') defaultTimbre = positionals[++i];
    else if (a.startsWith('--default-timbre=')) defaultTimbre = a.slice('--default-timbre='.length);
    else if (a === '--default-velocity') defaultVelocity = parseFiniteNumber(positionals[++i], 'default-velocity');
    else if (a.startsWith('--default-velocity=')) defaultVelocity = parseFiniteNumber(a.slice('--default-velocity='.length), 'default-velocity');
    else if (a.startsWith('--')) {
      const err: CliError = new Error(`unknown argument '${a}'`);
      err.hint = `run with --help for the full usage block`;
      throw err;
    } else {
      if (input !== undefined) {
        const err: CliError = new Error(`expected one positional <input.mid>, got '${input}' and '${a}'`);
        err.hint = `run with --help for the full usage block`;
        throw err;
      }
      input = a;
    }
  }
  return { help, json, input, outPath, bpmOverride, defaultTimbre, defaultVelocity };
}

interface AbsEvent {
  /** Absolute tick (post-cumulative-sum). */
  tick: number;
  /** Originating event from midi-file's parsed track. */
  ev: any;
}

/**
 * Walk every track, accumulate deltaTime → absolute tick, flatten into one
 * timeline sorted by tick (stable). midi-file produces relative deltaTime
 * per track event; we need absolute time across all tracks to pair noteOn
 * ↔ noteOff cleanly.
 */
function flattenTracks(tracks: any[]): AbsEvent[] {
  const out: AbsEvent[] = [];
  for (const track of tracks) {
    let absTick = 0;
    for (const ev of track) {
      absTick += ev.deltaTime ?? 0;
      out.push({ tick: absTick, ev });
    }
  }
  // Stable sort by tick ascending.
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

/**
 * Convert a tick offset to seconds.
 * For tempo-based files: seconds = ticks * microsecondsPerBeat / (ticksPerBeat * 1e6)
 * We use a constant tempo (the first Set Tempo) — sufficient for V1.
 */
function ticksToSec(ticks: number, ticksPerBeat: number, microsecondsPerBeat: number): number {
  return (ticks * microsecondsPerBeat) / (ticksPerBeat * 1_000_000);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!parsed.input) {
    const err: CliError = new Error(`expected <input.mid> positional argument`);
    err.hint = `e.g. vse-score-from-midi song.mid --out song.score.json`;
    throw err;
  }
  if (parsed.defaultVelocity <= 0 || parsed.defaultVelocity > 1) {
    const err: CliError = new Error(
      `--default-velocity must be in (0, 1], got ${parsed.defaultVelocity}`
    );
    err.hint = `velocity is a normalised amplitude scalar in VocalScore`;
    throw err;
  }

  const midiPath = resolve(parsed.input);
  let midiBytes: Buffer;
  try {
    midiBytes = await readFile(midiPath);
  } catch (err: any) {
    const cliErr: CliError = new Error(
      `failed to read MIDI file '${parsed.input}': ${err?.message ?? err}`
    );
    cliErr.hint = `verify the path exists and is readable`;
    throw cliErr;
  }

  let midi: ReturnType<typeof parseMidi>;
  try {
    midi = parseMidi(midiBytes);
  } catch (err: any) {
    const cliErr: CliError = new Error(`MIDI parse failed: ${err?.message ?? err}`);
    cliErr.hint = `confirm the input is a standard MIDI file (Type 0 or 1)`;
    throw cliErr;
  }

  // Time-division must be tick-based — SMPTE (frames-per-second) is not
  // currently supported because the synth engine needs second-aligned notes.
  const ticksPerBeat = midi.header.ticksPerBeat;
  if (!ticksPerBeat || ticksPerBeat <= 0) {
    const err: CliError = new Error(
      `MIDI file uses SMPTE time-division (framesPerSecond=${midi.header.framesPerSecond}); only tick-based PPQ timing is supported`
    );
    err.hint = `re-export the MIDI with PPQ (ticks-per-beat) time-division`;
    throw err;
  }

  // Flatten all tracks then locate the first tempo event so bpm conversion
  // is consistent across the file (constant-tempo simplification — V1).
  const events = flattenTracks(midi.tracks);
  let microsecondsPerBeat = 500_000; // 120 bpm default
  for (const e of events) {
    if (e.ev.type === 'setTempo' && typeof e.ev.microsecondsPerBeat === 'number') {
      microsecondsPerBeat = e.ev.microsecondsPerBeat;
      break;
    }
  }
  let bpm = 60_000_000 / microsecondsPerBeat;
  if (parsed.bpmOverride !== undefined) {
    if (parsed.bpmOverride <= 0) {
      const err: CliError = new Error(
        `--bpm-override must be positive, got ${parsed.bpmOverride}`
      );
      err.hint = `pass a real bpm like 120 or 80.5`;
      throw err;
    }
    bpm = parsed.bpmOverride;
    // Re-derive microsecondsPerBeat so tick → second math reflects the override.
    microsecondsPerBeat = 60_000_000 / bpm;
  }

  // Pair noteOn ↔ noteOff. MIDI lets the same noteNumber on the same
  // channel be played simultaneously (chords would normally use different
  // channels but legitimate edge cases exist); pair against the OLDEST
  // open noteOn for that key — first-in-first-out matches DAWs' default.
  const open = new Map<string, AbsEvent[]>();
  const notes: VocalNote[] = [];
  let noteIdx = 0;
  let unmatchedNoteOff = 0;
  let unmatchedNoteOn = 0;
  for (const e of events) {
    const ev = e.ev;
    if (ev.type === 'noteOn' && (ev.velocity ?? 0) > 0) {
      const key = `${ev.channel}:${ev.noteNumber}`;
      const stack = open.get(key) ?? [];
      stack.push(e);
      open.set(key, stack);
    } else if (
      ev.type === 'noteOff' ||
      (ev.type === 'noteOn' && (ev.velocity ?? 0) === 0)
    ) {
      const key = `${ev.channel}:${ev.noteNumber}`;
      const stack = open.get(key);
      if (!stack || stack.length === 0) {
        unmatchedNoteOff++;
        continue;
      }
      const onEv = stack.shift()!;
      const startSec = ticksToSec(onEv.tick, ticksPerBeat, microsecondsPerBeat);
      const endSec = ticksToSec(e.tick, ticksPerBeat, microsecondsPerBeat);
      const durationSec = Math.max(0.001, endSec - startSec);
      const rawVel = onEv.ev.velocity ?? 0;
      // Velocity 0 on a noteOn is a noteOff; if we somehow got here with
      // vel 0 (data corruption) fall back to the operator's default.
      const velocity = rawVel > 0 ? rawVel / 127 : parsed.defaultVelocity;
      const note: VocalNote = {
        id: `note_${noteIdx++}`,
        startSec,
        durationSec,
        midi: ev.noteNumber,
        velocity,
        ...(parsed.defaultTimbre ? { timbre: parsed.defaultTimbre } : {}),
      };
      notes.push(note);
    }
  }
  // Count any noteOns that never got a matching noteOff (file truncation).
  for (const stack of open.values()) {
    unmatchedNoteOn += stack.length;
  }

  if (notes.length === 0) {
    const err: CliError = new Error(
      `MIDI file produced 0 notes — no matched noteOn/noteOff pairs across ${events.length} events on ${midi.tracks.length} tracks`
    );
    err.hint = `verify the MIDI file contains note events (drum maps with only noteOn-vel-0 + no Set Tempo are common offenders)`;
    throw err;
  }

  // Sort notes chronologically (flattened events already were; but pairing
  // order may differ from start order on dense polyphony).
  notes.sort((a, b) => a.startSec - b.startSec);

  const score: VocalScore = {
    bpm,
    notes,
  };

  // Validate the constructed score round-trips through VocalScoreSchema so
  // we don't silently emit something the synth engine will refuse. If THIS
  // throws it's a bug in this CLI, not the operator's input.
  parseVocalScore(JSON.stringify(score));

  const outPath = resolve(parsed.outPath ?? midiPath + '.score.json');
  const scoreText = JSON.stringify(score, null, 2);
  await writeFile(outPath, scoreText, 'utf-8');

  const durationSec = notes.reduce(
    (acc, n) => Math.max(acc, n.startSec + n.durationSec),
    0
  );

  if (parsed.json) {
    const out = {
      schema: SCORE_FROM_MIDI_OUTPUT_SCHEMA,
      input: midiPath,
      out: outPath,
      bpm,
      notes: notes.length,
      durationSec,
      trackCount: midi.tracks.length,
      unmatchedNoteOff,
      unmatchedNoteOn,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  console.log(`\n=== score-from-midi ===`);
  console.log(`Input:        ${midiPath}`);
  console.log(`Output:       ${outPath}`);
  console.log(`Tracks:       ${midi.tracks.length}`);
  console.log(`BPM:          ${bpm.toFixed(2)}${parsed.bpmOverride !== undefined ? ' (overridden)' : ''}`);
  console.log(`Notes:        ${notes.length}`);
  console.log(`Duration:     ${durationSec.toFixed(3)}s`);
  if (unmatchedNoteOff > 0) {
    console.log(`Warning:      ${unmatchedNoteOff} unmatched noteOff event(s) ignored`);
  }
  if (unmatchedNoteOn > 0) {
    console.log(`Warning:      ${unmatchedNoteOn} noteOn(s) without matching noteOff (file may be truncated)`);
  }
}

runCli('score-from-midi', main);
