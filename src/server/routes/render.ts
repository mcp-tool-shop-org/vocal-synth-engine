import { Router } from 'express';
import { renderScoreToWav } from '../services/renderScoreToWav.js';
import { saveLastRender } from '../storage/renderStore.js';

export const renderRouter = Router();

const MAX_RENDER_DURATION_SEC = Number(process.env.MAX_RENDER_DURATION_SEC) || 60;

renderRouter.post('/', async (req, res) => {
  try {
    const { score, config } = req.body ?? {};
    if (!score) throw new Error("Missing score");
    if (!config) throw new Error("Missing config");

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
