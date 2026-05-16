/**
 * FS-003 — HTTP metrics middleware.
 *
 * Records one entry into `http_requests_total` and one observation into
 * `http_request_duration_seconds` per response, with method/route/status
 * labels.
 *
 * The `route` label is derived from req.route?.path when express has matched
 * a route (e.g. '/api/renders/:id/meta'), falling back to req.baseUrl + path
 * so unmatched 404s still emit a stable label (truncated to keep the label
 * cardinality from exploding on probes for arbitrary URLs).
 *
 * Mounted FIRST in createApp (after requestId/structuredLog) so it sees
 * every request, including those that 401 / 404 / 413 in middleware.
 */
import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../util/metrics.js';

// Tight cap so a probe for /api/renders/<random-256-byte-blob> can't blow up
// Prometheus label cardinality (which would tank scrape performance + cost).
const MAX_ROUTE_LABEL = 64;
// Set of paths we exclude from the histogram entirely — high-volume probes
// that would otherwise dominate the histogram with low-information data.
const SKIP_PATHS = new Set(['/livez', '/readyz', '/api/metrics']);

function deriveRouteLabel(req: Request): string {
  // Prefer the matched-route template so /api/renders/:id/meta stays one
  // label instead of 1 per render id.
  const matched = req.route?.path;
  if (typeof matched === 'string' && matched.length > 0) {
    // Combine with the router mount path; req.baseUrl is empty for top-level.
    const base = req.baseUrl || '';
    const full = (base + matched) || '/';
    return full.length > MAX_ROUTE_LABEL ? full.slice(0, MAX_ROUTE_LABEL) : full;
  }
  // Unmatched: bound the raw path so probes can't grow the label set.
  const raw = req.path || '/';
  return raw.length > MAX_ROUTE_LABEL ? raw.slice(0, MAX_ROUTE_LABEL) : raw;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip noisy probes; they show up as `up` in Prometheus and don't need
  // detailed histograms.
  if (SKIP_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = deriveRouteLabel(req);
    const status = String(res.statusCode);
    const labels = { method: req.method, route, status };
    httpRequestsTotal.inc(labels);
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDurationSeconds.observe(labels, elapsedSec);
  });
  next();
}
