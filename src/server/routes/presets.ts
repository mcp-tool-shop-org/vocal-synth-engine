import { Router } from 'express';
import { listPresets } from '../services/renderScoreToWav.js';
import { HttpError } from '../middleware/errorHandler.js';

export const presetsRouter = Router();

presetsRouter.get('/', (_req, res, next) => {
  try {
    const presets = listPresets();
    if (presets.length === 0) {
      // SB-011 humanization — a render call will 404 with PRESET_NOT_FOUND
      // five lines later if no voices are installed.  Returning a 200 with
      // [] hides the root cause; emit a soft `degraded:true` so the
      // cockpit can show an install-voices banner.
      return res.json({
        ok: true,
        presets,
        degraded: true,
        message: 'No voice presets installed',
        hint: 'Deploy presets to PRESET_DIR (default ./presets) — see README',
      });
    }
    res.json({ ok: true, presets });
  } catch (err: any) {
    next(new HttpError(500, 'PRESET_LIST_FAILED', err?.message ?? String(err), {
      hint: 'Check PRESET_DIR is readable and contains valid voicepreset.json files',
    }));
  }
});
