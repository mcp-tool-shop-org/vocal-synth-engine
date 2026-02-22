import { Router } from 'express';
import { listPresets } from '../services/renderScoreToWav.js';

export const presetsRouter = Router();

presetsRouter.get('/', (_req, res) => {
  try {
    const presets = listPresets();
    res.json({ ok: true, presets });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});
