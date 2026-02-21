import { Router } from 'express';
import { renderScoreToWav } from '../services/renderScoreToWav.js';

export const renderRouter = Router();

renderRouter.post('/', async (req, res) => {
  try {
    const { score, config } = req.body ?? {};
    if (!score) throw new Error("Missing score");
    if (!config) throw new Error("Missing config");

    const result = await renderScoreToWav({ score, config });

    // simplest transport: base64 (works everywhere)
    res.json({
      ok: true,
      durationSec: result.durationSec,
      telemetry: result.telemetry,
      provenance: result.provenance,
      wavBase64: result.wavBase64,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});
