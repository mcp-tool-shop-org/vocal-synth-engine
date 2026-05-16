#!/usr/bin/env node
/**
 * vocal-synth-engine MCP server — closes FT-004.
 *
 * Every other tool in mcp-tool-shop-org (research-os, ollama-intern-mcp,
 * repo-knowledge, roll, sdlab, etc.) ships an MCP entry point so Claude
 * agents can invoke them directly. This server wraps the *existing*
 * in-process API (loadVoicePreset, renderScoreToWav-equivalent, the G2P
 * phonemize pipeline, the preset listing/inspection used by /api/presets)
 * with no re-implementation — it's a thin adapter, not a new product
 * surface.
 *
 * Tools exposed (5 total — minimal by design):
 *   - render_score      : Render a VocalScore through a voice preset →
 *                         base64 WAV bytes + telemetry + provenance.
 *   - phonemize_text    : Lyrics text → ARPAbet PhonemeEvents (note-aligned
 *                         when a score is supplied, word-level otherwise).
 *   - list_presets      : Same shape as GET /api/presets — id, timbres,
 *                         sample rate, version, optional meta.json fields.
 *   - validate_score    : Parse + validate VocalScore JSON without
 *                         rendering. Cheap CI affordance.
 *   - inspect_preset    : Load + validate a preset by id, return manifest
 *                         metadata + per-timbre harmonics/energy. Same
 *                         data the inspect CLI emits with --json.
 *
 * Transport: stdio (the MCP convention for local-agent integration).
 * Boot:      `vocal-synth-engine-mcp` (bin entry in package.json).
 *
 * Discipline kept narrow:
 *   - 5 tools, ~300 LOC. We resist adding `build_preset_from_wavs` /
 *     `compare_wavs` here — those are CLI-shaped tools and live behind
 *     the `vse-build-preset` / `vse-compare` bin entries.
 *   - No I/O the existing CLIs don't already perform; the MCP layer is
 *     ONLY a JSON-RPC adapter.
 *   - All schemas are zod (matches every other org MCP server).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { loadVoicePreset } from '../preset/loader.js';
import {
  renderScoreToWav,
  resolvePresetPath,
  listPresets,
  listPresetIds,
} from '../server/services/renderScoreToWav.js';
import { phonemizeLyrics, textToPhonemes, syllabify } from '../phonemize/index.js';
import { parseVocalScore } from '../types/score.js';

/**
 * Version pulled from the package's APP_VERSION env (set in production) or
 * 'dev' when launched from a source checkout. Matches the convention used
 * by /api/health.
 */
const SERVER_VERSION = process.env.APP_VERSION ?? 'dev';

const server = new McpServer({
  name: 'vocal-synth-engine',
  version: SERVER_VERSION,
  description: 'Deterministic vocal instrument engine — additive synthesis with formant control',
});

// ─── render_score ────────────────────────────────────────────────────────────

const renderScoreArgs = {
  score: z
    .unknown()
    .describe(
      'VocalScore JSON object. Required shape: { bpm:number, notes:[{id,startSec,durationSec,midi,velocity?,timbre?,vibrato?,portamentoSec?}], lyrics?, phonemes?, lanes? }. Validated server-side via VocalScoreSchema — invalid scores return a structured error.',
    ),
  preset_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('default-voice')
    .describe(
      "Preset id (directory name under PRESET_DIR, default 'presets/'). Defaults to 'default-voice'. Use list_presets to enumerate.",
    ),
  deterministic: z
    .enum(['exact', 'fast'])
    .default('exact')
    .describe("Render mode. 'exact' uses the SHA-256 sample hash for cross-rig determinism."),
  rng_seed: z
    .number()
    .int()
    .min(-2_147_483_648)
    .max(2_147_483_647)
    .default(123456789)
    .describe('RNG seed for the noise sources. Pinning this gives byte-identical output across rigs.'),
};

server.tool(
  'render_score',
  "Render a VocalScore through a voice preset and return the WAV audio + telemetry. Use list_presets first to see available preset_ids. Returns base64-encoded WAV bytes (so the client doesn't need a binary channel) alongside provenance (commit, score/wav SHA-256) and telemetry (RTF, peak dBFS, sample-graph max delta).",
  renderScoreArgs,
  async ({ score, preset_id, deterministic, rng_seed }) => {
    try {
      const result = await renderScoreToWav({
        score,
        config: {
          presetId: preset_id,
          deterministic,
          rngSeed: rng_seed,
        },
      });
      const payload = {
        ok: true,
        preset_id,
        duration_sec: result.durationSec,
        telemetry: result.telemetry,
        provenance: result.provenance,
        wav_base64: result.wavBytes.toString('base64'),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: {
                code: err?.code ?? 'RENDER_FAILED',
                message: err?.message ?? String(err),
                hint: err?.hint,
                available_presets: err?.available,
              },
            }),
          },
        ],
        isError: true as const,
      };
    }
  },
);

// ─── phonemize_text ──────────────────────────────────────────────────────────

const phonemizeTextArgs = {
  text: z.string().min(1).max(5_000).describe('Lyrics text to phonemise (UTF-8).'),
  language: z
    .string()
    .min(2)
    .max(16)
    .optional()
    .describe(
      "BCP-47 language tag (default 'en-US'). Non-English tags emit an explicit warning — only English has a phonemization dictionary today.",
    ),
  notes: z
    .array(z.unknown())
    .optional()
    .describe(
      'Optional note list (VocalScore.notes shape). When supplied, the events array is time-aligned against these notes (server-route behaviour). When omitted, only word-level + syllable-level results are returned.',
    ),
};

server.tool(
  'phonemize_text',
  'Convert lyrics text into ARPAbet PhonemeEvents. With `notes`, returns the time-aligned event array the synth engine consumes (same shape POST /api/phonemize returns). Without `notes`, returns word + syllable structure only (no per-event timings).',
  phonemizeTextArgs,
  async ({ text, language, notes }) => {
    try {
      if (notes && Array.isArray(notes) && notes.length > 0) {
        const result = phonemizeLyrics(text, notes as any, language);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                mode: 'aligned',
                language: language ?? null,
                events: result.events,
                warnings: result.warnings,
              }),
            },
          ],
        };
      }
      // No notes — word + syllable level only.
      const words = textToPhonemes(text);
      const warnings: string[] = [];
      if (language) {
        const dry = phonemizeLyrics('', [], language);
        warnings.push(...dry.warnings);
      }
      for (const w of words) {
        if (w.source === 'fallback') warnings.push(`"${w.word}" not in dictionary — using fallback`);
      }
      const per = words.map((w) => syllabify(w.phonemes));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'word',
              language: language ?? null,
              words: words.map((w, i) => ({
                word: w.word,
                source: w.source,
                phonemes: w.phonemes.map((p) => p.symbol),
                syllables: per[i].map((s) => ({
                  onset: s.onset.map((p) => p.symbol),
                  nucleus: s.nucleus.symbol,
                  coda: s.coda.map((p) => p.symbol),
                })),
              })),
              warnings,
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: { code: err?.code ?? 'PHONEMIZE_FAILED', message: err?.message ?? String(err) },
            }),
          },
        ],
        isError: true as const,
      };
    }
  },
);

// ─── list_presets ────────────────────────────────────────────────────────────

server.tool(
  'list_presets',
  'List every voice preset available under PRESET_DIR. Returns the same shape GET /api/presets returns (id, name, description, tags, defaultTimbre, timbres, sampleRateHz, version). Use this before calling render_score so you know which preset_ids exist.',
  {},
  async () => {
    try {
      const presets = listPresets();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, count: presets.length, presets }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: { code: 'LIST_PRESETS_FAILED', message: err?.message ?? String(err) },
            }),
          },
        ],
        isError: true as const,
      };
    }
  },
);

// ─── validate_score ──────────────────────────────────────────────────────────

const validateScoreArgs = {
  score: z
    .unknown()
    .describe('VocalScore JSON object (or any value — invalid shapes return a structured error).'),
};

server.tool(
  'validate_score',
  "Validate a VocalScore JSON without rendering. Returns `{ ok: true, formatVersion, noteCount, durationSec }` when the score parses cleanly, or `{ ok: false, error: { code, message } }` with Zod issue details on failure. Cheap CI affordance — doesn't allocate a render buffer.",
  validateScoreArgs,
  async ({ score }) => {
    try {
      const parsed = parseVocalScore(JSON.stringify(score));
      const durationSec = parsed.notes.reduce(
        (acc, n) => Math.max(acc, n.startSec + n.durationSec),
        0,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              formatVersion: parsed.formatVersion,
              noteCount: parsed.notes.length,
              durationSec,
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: {
                code: err?.code ?? 'INVALID_SCORE',
                message: err?.message ?? String(err),
                issues: err?.issues,
              },
            }),
          },
        ],
        isError: true as const,
      };
    }
  },
);

// ─── inspect_preset ──────────────────────────────────────────────────────────

const inspectPresetArgs = {
  preset_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .describe('Preset id — same shape required by render_score.preset_id.'),
};

server.tool(
  'inspect_preset',
  'Load + validate a preset by id and return its manifest metadata, per-timbre harmonics, frequency-axis bounds, harmonic energy, and declared defaults. Same JSON shape `vse-inspect --json` emits. A passing inspection also proves the preset is structurally valid and its assets are readable.',
  inspectPresetArgs,
  async ({ preset_id }) => {
    try {
      const manifestPath = resolvePresetPath(preset_id);
      const preset = await loadVoicePreset(manifestPath);
      const { manifest, timbres } = preset;
      const out = {
        ok: true,
        preset_id,
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: {
                code: err?.code ?? 'INSPECT_FAILED',
                message: err?.message ?? String(err),
                hint: err?.hint,
                available_presets: err?.available ?? listPresetIds(),
              },
            }),
          },
        ],
        isError: true as const,
      };
    }
  },
);

// ─── Boot ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The MCP convention is to log boot lines to stderr so stdout stays
  // reserved for the JSON-RPC stream.
  console.error(`vocal-synth-engine MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err: unknown) => {
  console.error('vocal-synth-engine MCP fatal:', err);
  process.exit(1);
});
