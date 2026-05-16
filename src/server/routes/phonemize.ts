import { Router } from 'express';
import { z } from 'zod';
import { phonemizeLyrics } from '../../phonemize/index.js';
import { validateBody } from '../middleware/validate.js';

export const phonemizeRouter = Router();

// S-011: cap text length and notes count.  Defaults: 5000 chars of lyrics,
// 1000 notes per phonemize call.  These are well above any legitimate use
// (sung lyrics rarely exceed 1k chars per render) but firmly below the
// CPU-DoS threshold the regex+G2P loop creates with 50 MB of text.
const MAX_LYRICS_LENGTH = Number(process.env.MAX_LYRICS_LENGTH) || 5_000;
const MAX_PHONEMIZE_NOTES = Number(process.env.MAX_PHONEMIZE_NOTES) || 1_000;

const phonemizeNoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    startSec: z.number().finite().min(0).max(3600),
    durationSec: z.number().finite().min(0.001).max(3600),
    midi: z.number().int().min(0).max(127),
    velocity: z.number().finite().min(0).max(1).optional(),
    timbre: z.string().min(1).max(64).optional(),
  })
  .passthrough();

const phonemizeBodySchema = z
  .object({
    text: z.string().min(1).max(MAX_LYRICS_LENGTH),
    notes: z.array(phonemizeNoteSchema).min(1).max(MAX_PHONEMIZE_NOTES),
  })
  .passthrough();

phonemizeRouter.post('/', validateBody(phonemizeBodySchema), (req, res) => {
  try {
    const { text, notes } = req.body as z.infer<typeof phonemizeBodySchema>;

    const result = phonemizeLyrics(text, notes);

    res.json({
      ok: true,
      events: result.events,
      warnings: result.warnings,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});
