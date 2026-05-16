/**
 * FS-003 — Prometheus metrics registry.
 *
 * Wraps prom-client into a single module so:
 *   - the registry is process-singleton (any route or service that imports
 *     `metrics` shares the same counters/histograms — no double-counting),
 *   - default Node.js process metrics (cpu, memory, gc, eventloop lag) are
 *     enabled with a 'vocal_synth_' prefix so they don't collide with any
 *     other process scraped from the same Prometheus,
 *   - HTTP middleware emits per-request labels (method/route/status) once,
 *   - the render queue / store / WS / Live sessions can probe the same
 *     instruments without each having to know prom-client's collectDefault
 *     vs custom-register lifecycle.
 *
 * The instruments named here line up with the FS-003 recommendation:
 *   queue_depth, queue_inflight, render_store_bytes_used,
 *   render_store_budget_bytes, http_requests_total{method,route,status},
 *   http_request_duration_seconds, ws_sessions_active{kind},
 *   render_duration_seconds, render_rtf.
 *
 * Operators query /api/metrics (admin-only) and scrape into Prometheus.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Default node/process metrics: cpu, memory, gc, eventloop lag, file descriptors.
// The prefix isolates our metrics so a Prometheus scraping multiple Node
// processes can disambiguate.
collectDefaultMetrics({ register: registry, prefix: 'vocal_synth_' });

// HTTP — counted in the middleware below.
export const httpRequestsTotal = new Counter({
  name: 'vocal_synth_http_requests_total',
  help: 'Total HTTP requests grouped by method, route and response status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'vocal_synth_http_request_duration_seconds',
  help: 'HTTP request handler duration in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  // Tuned for an interactive DAW backend: most requests resolve under 100ms,
  // some renders block the calling handler for 30+s.  Buckets reach 60s so
  // even the longest render's POST /api/render handler is captured.
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

// Render queue — set/updated from the queue gauge sampler below.
export const queueDepthGauge = new Gauge({
  name: 'vocal_synth_queue_depth',
  help: 'Number of render jobs currently queued OR in-flight.',
  registers: [registry],
});

export const queueInflightGauge = new Gauge({
  name: 'vocal_synth_queue_inflight',
  help: 'Whether a render job is currently in-flight (0 or 1).',
  registers: [registry],
});

// Render store — set/updated from the budget snapshot sampler below.
export const renderStoreBytesUsedGauge = new Gauge({
  name: 'vocal_synth_render_store_bytes_used',
  help: 'Bytes currently consumed by the render store on disk.',
  registers: [registry],
});

export const renderStoreBudgetBytesGauge = new Gauge({
  name: 'vocal_synth_render_store_budget_bytes',
  help: 'Configured RENDER_STORE_BUDGET_MB expressed in bytes.',
  registers: [registry],
});

// Render outcomes — observed when a job finishes (done/failed/cancelled).
export const renderDurationSeconds = new Histogram({
  name: 'vocal_synth_render_duration_seconds',
  help: 'Audio duration of the rendered output, in seconds.',
  // Audio output can be a beat or several minutes; cap at the
  // MAX_RENDER_DURATION_SEC default plus headroom.
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const renderRtf = new Histogram({
  name: 'vocal_synth_render_rtf',
  help: 'Render real-time factor (wall_render_time / audio_duration). <1 = faster than real-time.',
  // RTF of 1 is real-time; the streaming engine routinely renders at 0.05-0.3
  // RTF on dev hardware so the bucket lower bound is intentionally tight.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const renderJobsTotal = new Counter({
  name: 'vocal_synth_render_jobs_total',
  help: 'Total render jobs grouped by terminal outcome.',
  labelNames: ['outcome'] as const, // 'done' | 'failed' | 'cancelled'
  registers: [registry],
});

// Auth — incremented in the auth middleware on every 401.
export const authFailuresTotal = new Counter({
  name: 'vocal_synth_auth_failures_total',
  help: 'Total HTTP requests rejected with 401 by requireAuth.',
  registers: [registry],
});

// Rate-limit drops — incremented in rateLimit middleware on every 429.
export const rateLimitDropsTotal = new Counter({
  name: 'vocal_synth_rate_limit_drops_total',
  help: 'Total HTTP requests rejected with 429 by the rate limiter.',
  registers: [registry],
});

// WS — set by an external sampler so the live/jam managers don't have to
// know about prom-client directly.  Labels keep live vs jam separate so an
// operator can see at a glance which surface has connections.
export const wsSessionsActiveGauge = new Gauge({
  name: 'vocal_synth_ws_sessions_active',
  help: 'Number of currently-connected WebSocket sessions, grouped by kind.',
  labelNames: ['kind'] as const, // 'live' | 'jam'
  registers: [registry],
});

/**
 * Periodically refresh sampled gauges (queue depth, store bytes) so the
 * /metrics endpoint serves fresh values even between requests.  Called from
 * createApp; the timer is `unref()`-ed so tests/scripts can exit cleanly.
 */
let samplerHandle: NodeJS.Timeout | null = null;
let registeredSamplers: Array<() => void> = [];

export function registerSampler(fn: () => void): void {
  registeredSamplers.push(fn);
}

export function startSamplers(intervalMs: number = 5_000): NodeJS.Timeout {
  if (samplerHandle) return samplerHandle;
  samplerHandle = setInterval(() => {
    for (const fn of registeredSamplers) {
      try {
        fn();
      } catch {
        // Sampling errors are non-fatal; the next interval retries.  We
        // intentionally swallow so a transient ENOENT during render-store
        // size walking can't crash the process.
      }
    }
  }, intervalMs);
  if (typeof samplerHandle.unref === 'function') samplerHandle.unref();
  return samplerHandle;
}

export function stopSamplers(): void {
  if (samplerHandle) {
    clearInterval(samplerHandle);
    samplerHandle = null;
  }
}

/**
 * Test helper — flushes every counter/histogram and de-registers the
 * sampler callbacks so a freshly-imported registry behaves like a cold
 * process.  Production code never calls this.
 */
export function _resetMetricsForTests(): void {
  registry.resetMetrics();
  registeredSamplers = [];
  stopSamplers();
}
