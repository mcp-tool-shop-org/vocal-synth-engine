import { Router } from 'express';
import { phonemizeLyrics } from '../../phonemize/index.js';

export const phonemizeRouter = Router();

phonemizeRouter.post('/', (req, res) => {
  try {
    const { text, notes } = req.body ?? {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing or invalid "text" field' });
      return;
    }
    if (!Array.isArray(notes) || notes.length === 0) {
      res.status(400).json({ ok: false, error: 'Missing or empty "notes" array' });
      return;
    }

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
