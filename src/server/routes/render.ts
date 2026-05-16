import { Router } from 'express';
import { z } from 'zod';
import { renderScoreToWav } from '../services/renderScoreToWav.js';
import { saveLastRender } from '../storage/renderStore.js';
import { validateBody } from '../middleware/validate.js';

export const renderRouter = Router();

const MAX_RENDER_DURATION_SEC = Number(process.env.MAX_RENDER_DURATION_SEC) || 60;
const MAX_NOTES_PER_SCORE = Number(process.env.MAX_NOTES_PER_SCORE) || 10_000;
const MAX_LYRICS_LENGTH = Number(process.env.MAX_LYRICS_LENGTH) || 10_000;

// S-014: presetId must be a safe filesystem segment.  Same pattern enforced
// inside resolvePresetPath as defence-in-depth.
const presetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'presetId must match /^[A-Za-z0-9_-]+$/');

const vocalNoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    startSec: z.number().finite().min(0).max(3600),
    durationSec: z.number().finite().min(0.001).max(3600),
    midi: z.number().int().min(0).max(127),
    velocity: z.number().finite().min(0).max(1).optional(),
    timbre: z.string().min(1).max(64).optional(),
    vibrato: z
      .object({
        rateHz: z.number().finite().min(0).max(50),
        depthCents: z.number().finite().min(0).max(1200),
        onsetSec: z.number().finite().min(0).max(60),
      })
      .strict()
      .optional(),
    portamentoSec: z.number().finite().min(0).max(10).optional(),
  })
  .passthrough();

const phonemeEventSchema = z
  .object({
    tSec: z.number().finite().min(0),
    durSec: z.number().finite().min(0),
    phoneme: z.string().min(1).max(8),
    kind: z.enum(['vowel', 'consonant']),
    timbreHint: z.string().min(1).max(64).optional(),
    strength: z.number().finite().min(0).max(1).optional(),
  })
  .passthrough();

const automationPointSchema = z
  .object({
    tSec: z.number().finite().min(0),
    value: z.number().finite(),
  })
  .strict();

const scoreSchema = z
  .object({
    bpm: z.number().finite().min(20).max(400),
    notes: z.array(vocalNoteSchema).max(MAX_NOTES_PER_SCORE),
    lyrics: z
      .object({
        text: z.string().max(MAX_LYRICS_LENGTH),
        language: z.string().min(2).max(16).optional(),
      })
      .strict()
      .optional(),
    phonemes: z.array(phonemeEventSchema).max(MAX_NOTES_PER_SCORE * 4).optional(),
    lanes: z
      .object({
        dynamics: z.array(automationPointSchema).max(10_000).optional(),
        breathiness: z.array(automationPointSchema).max(10_000).optional(),
        timbreMorph: z
          .record(z.string().max(64), z.array(automationPointSchema).max(10_000))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

const configSchema = z
  .object({
    presetId: presetIdSchema.optional(),
    blockSize: z
      .number()
      .int()
      .refine((v) => [128, 256, 512, 1024, 2048].includes(v), {
        message: 'blockSize must be one of 128, 256, 512, 1024, 2048',
      })
      .optional(),
    deterministic: z.enum(['exact', 'approximate']).optional(),
    rngSeed: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    defaultTimbre: z.string().min(1).max(64).optional(),
    maxPolyphony: z.number().int().min(1).max(64).optional(),
  })
  .passthrough();

// S-010 — validated body schema for /api/render.  Exported so /api/renders
// POST can reuse the same `score` + `config` shape (S-008 path).
export const renderBodySchema = z
  .object({
    score: scoreSchema,
    config: configSchema,
  })
  .passthrough();

renderRouter.post('/', validateBody(renderBodySchema), async (req, res) => {
  try {
    const { score, config } = req.body as z.infer<typeof renderBodySchema>;

    // Safety: cap render duration
    const notes = score.notes || [];
    let maxEndSec = 0;
    for (const n of notes) {
      const end = (n.startSec || 0) + (n.durationSec || 0);
      if (end > maxEndSec) maxEndSec = end;
    }
    if (maxEndSec > MAX_RENDER_DURATION_SEC) {
      throw new Error(`Score duration ${maxEndSec.toFixed(1)}s exceeds max ${MAX_RENDER_DURATION_SEC}s`);
    }

    const result = await renderScoreToWav({ score, config });

    // Auto-save to the "last" slot
    saveLastRender({
      score,
      config,
      telemetry: result.telemetry,
      provenance: result.provenance,
      wavBytes: result.wavBytes,
      durationSec: result.durationSec,
    });

    // Return the URL to the last render instead of base64
    res.json({
      ok: true,
      durationSec: result.durationSec,
      telemetry: result.telemetry,
      provenance: result.provenance,
      audioUrl: '/api/renders/last/audio.wav',
    });
  } catch (err: any) {
    // Phase 5: human-readable preset errors
    if (err?.code === 'PRESET_NOT_FOUND') {
      res.status(404).json({
        ok: false,
        code: 'PRESET_NOT_FOUND',
        message: err.message,
        presetId: err.presetId,
        presetDir: err.presetDir,
        available: err.available,
      });
      return;
    }

    // ENOENT from file system (missing asset files, etc.)
    if (err?.code === 'ENOENT') {
      res.status(500).json({
        ok: false,
        code: 'ASSET_NOT_FOUND',
        message: `File not found: ${err.path}. The preset assets may be missing from the deployment.`,
        error: err.message,
      });
      return;
    }

    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});
