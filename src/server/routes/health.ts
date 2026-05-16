import { Router } from 'express';
import path from 'node:path';
import { getPresetDirInfo } from '../services/renderScoreToWav.js';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/', (req, res) => {
  const presetInfo = getPresetDirInfo();
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? "dev",
    commit: process.env.GIT_COMMIT ?? "unknown",
    node: process.version,
    renderStorePath: path.resolve(process.env.RENDER_STORE_DIR || ".vscockpit/renders"),
    presetDir: presetInfo.presetDir,
    presetsFound: presetInfo.count,
    presets: presetInfo.presets,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});
