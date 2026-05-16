/**
 * FS-003 — Prometheus /api/metrics endpoint.
 *
 * Admin-only (requireAuth + requireAdmin).  Returns text-format prom
 * exposition for scraping by Prometheus, Grafana Agent, vmagent, etc.
 *
 * The route also triggers a synchronous refresh of the sampled gauges
 * (queue depth, render store bytes) so the scraped values reflect the
 * state at scrape time, not the last 5-second sampler tick.  This matters
 * when an alerting rule fires off a single curl probe and needs a fresh
 * value to evaluate.
 */
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  registry,
  queueDepthGauge,
  queueInflightGauge,
  renderStoreBytesUsedGauge,
  renderStoreBudgetBytesGauge,
} from '../util/metrics.js';
import { getRenderQueue } from '../services/renderQueue.js';
import { getRenderBudgetSnapshot } from '../storage/renderStore.js';

export const metricsRouter = Router();

/**
 * Refresh the sampled gauges synchronously, then emit the registry's
 * exposition text.  Errors during sampling are non-fatal — we still return
 * whatever metrics we have rather than 500ing the entire scrape.
 */
async function refreshSampledGauges() {
  try {
    const q = getRenderQueue();
    queueDepthGauge.set(q.depth);
    queueInflightGauge.set(q.inFlight ? 1 : 0);
  } catch {
    /* render queue not constructable; gauge stays at last value */
  }
  try {
    const snap = getRenderBudgetSnapshot();
    renderStoreBytesUsedGauge.set(snap.usedBytes);
    renderStoreBudgetBytesGauge.set(snap.storeBudgetBytes);
  } catch {
    /* render store unavailable; gauge stays at last value */
  }
}

metricsRouter.get('/', requireAuth, requireAdmin, async (_req, res) => {
  await refreshSampledGauges();
  const body = await registry.metrics();
  res.setHeader('Content-Type', registry.contentType);
  res.status(200).send(body);
});
