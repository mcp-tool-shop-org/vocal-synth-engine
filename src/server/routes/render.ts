import { Router } from 'express';
import { renderScoreToWav } from '../services/renderScoreToWav.js';
import { saveLastRender } from '../storage/renderStore.js';

export const renderRouter = Router();

renderRouter.post('/', async (req, res) => {
  try {
    const { score, config } = req.body ?? {};
    if (!score) throw new Error("Missing score");
    if (!config) throw new Error("Missing config");

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
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});
