import { Router } from 'express';
import path from 'node:path';
import { getPresetDirInfo } from '../services/renderScoreToWav.js';
import { requireAuth } from '../middleware/auth.js';
import { getRenderBudgetSnapshot } from '../storage/renderStore.js';
import { getRenderQueue } from '../services/renderQueue.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * S-018 — the public health endpoint must NOT leak:
 *   - absolute renderStorePath / presetDir (helps target writable paths)
 *   - the full preset list (helps target preset-specific exploits)
 *   - the node version + commit (fingerprints version-specific CVEs)
 *
 * Public callers get the bare minimum needed for a load-balancer probe.
 * Operators who need the full picture authenticate against
 * /api/health/detailed (auth-gated).
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? 'dev',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

/**
 * S-018 — detailed health info gated by AUTH_TOKEN.  Same fields the public
 * /api/health used to emit; useful for operator dashboards but not exposed
 * to unauthenticated probes / scanners.
 *
 * SB-008 humanization: detailed health surfaces:
 *   - render queue depth + in-flight flag (so an operator can see WHY
 *     /api/render is feeling slow)
 *   - render store budget snapshot (used / total MB, utilization fraction)
 *   - process resident memory (rss) so the operator can decide whether the
 *     spike is render-driven or jam-driven
 *
 * These are exactly the fields an operator paged at 3am needs to triage in
 * one curl.
 */
healthRouter.get('/detailed', requireAuth, (_req, res) => {
  const presetInfo = getPresetDirInfo();
  const queue = getRenderQueue();
  const budget = getRenderBudgetSnapshot();
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? 'dev',
    commit: process.env.GIT_COMMIT ?? 'unknown',
    node: process.version,
    renderStorePath: path.resolve(process.env.RENDER_STORE_DIR || '.vscockpit/renders'),
    presetDir: presetInfo.presetDir,
    presetsFound: presetInfo.count,
    presets: presetInfo.presets,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    queue: {
      depth: queue.depth,
      inFlight: queue.inFlight,
    },
    budget,
    memory: {
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
    },
  });
});
