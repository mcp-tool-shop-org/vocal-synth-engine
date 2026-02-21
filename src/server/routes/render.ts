import { Router } from 'express';
import { renderScoreToWav } from '../services/renderScoreToWav.js';

export const renderRouter = Router();

renderRouter.post('/', async (req, res) => {
  try {
    const { score, config = {} } = req.body;
    if (!score) {
      return res.status(400).json({ error: 'Missing score in request body' });
    }

    const result = await renderScoreToWav({ score, config });

    res.json({
      wavBase64: result.wavBase64,
      telemetry: result.telemetry,
      provenance: result.provenance,
      durationSec: result.durationSec
    });
  } catch (error: any) {
    console.error('Render error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});
