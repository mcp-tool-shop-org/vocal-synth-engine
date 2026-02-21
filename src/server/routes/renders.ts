import { Router } from 'express';
import { renderScoreToWav } from '../services/renderScoreToWav.js';
import { saveRender, listRenders, updateRenderName, deleteRender, getRenderDir } from '../storage/renderStore.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const rendersRouter = Router();

rendersRouter.get('/', async (req, res) => {
  try {
    const renders = await listRenders();
    res.json(renders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

rendersRouter.post('/', async (req, res) => {
  try {
    const { score, config = {}, name } = req.body;
    if (!score) {
      return res.status(400).json({ error: 'Missing score in request body' });
    }

    const result = await renderScoreToWav({ score, config });
    const saved = await saveRender({
      name: name || `Render ${new Date().toISOString()}`,
      score,
      config,
      wavBytes: result.wavBytes,
      telemetry: result.telemetry,
      provenance: result.provenance,
      durationSec: result.durationSec
    });

    res.json(saved);
  } catch (error: any) {
    console.error('Save render error:', error);
    res.status(500).json({ error: error.message });
  }
});

rendersRouter.patch('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Missing name in request body' });
    }
    const updated = await updateRenderName(req.params.id, name);
    if (!updated) {
      return res.status(404).json({ error: 'Render not found' });
    }
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

rendersRouter.delete('/:id', async (req, res) => {
  try {
    const success = await deleteRender(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

rendersRouter.get('/:id/audio.wav', (req, res) => {
  const dir = getRenderDir(req.params.id);
  const file = join(dir, 'audio.wav');
  if (existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).json({ error: 'Audio not found' });
  }
});

rendersRouter.get('/:id/score', (req, res) => {
  const dir = getRenderDir(req.params.id);
  const file = join(dir, 'score.json');
  if (existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).json({ error: 'Score not found' });
  }
});
