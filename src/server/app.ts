import express, { type Router } from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { renderRouter } from './routes/render.js';
import { rendersRouter } from './routes/renders.js';
import { presetsRouter } from './routes/presets.js';
import { phonemizeRouter } from './routes/phonemize.js';
import { metricsRouter } from './routes/metrics.js';
import { probesRouter, markInitComplete } from './routes/probes.js';
import { openapiRouter } from './routes/openapi.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { structuredLog } from './middleware/structuredLog.js';
import { metricsMiddleware } from './middleware/metricsMiddleware.js';
import { errorHandler, apiNotFoundHandler } from './middleware/errorHandler.js';
import { startSamplers, registerSampler, queueDepthGauge, queueInflightGauge, renderStoreBytesUsedGauge, renderStoreBudgetBytesGauge } from './util/metrics.js';
import { getRenderQueue } from './services/renderQueue.js';
import { getRenderBudgetSnapshot } from './storage/renderStore.js';

export function createApp() {
  const app = express();

  // SB-006: requestId FIRST so every downstream middleware (logger, error
  // handler, rate limiter, validators) can attach it to whatever they emit.
  app.use(requestIdMiddleware);

  // SB-006: one structured line per request so operators can correlate the
  // user-reported requestId with the full request lifecycle.
  app.use(structuredLog);

  // FS-003: per-request Prometheus accounting (method/route/status counter +
  // duration histogram).  Mounted after requestId/structuredLog so a metric
  // observation only happens for requests express actually accepted.  The
  // middleware skips /livez, /readyz, /api/metrics itself to keep
  // probe-driven scrape pressure out of the histogram.
  app.use(metricsMiddleware);

  // S-006: Tell express to honour the leftmost X-Forwarded-For entry.
  // Default to 'loopback' which is safe everywhere; operators behind a real
  // reverse proxy should set TRUST_PROXY=true (boolean) or to a numeric hop
  // count to enable per-client rate limiting.
  const trustProxyRaw = process.env.TRUST_PROXY;
  if (trustProxyRaw === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxyRaw && /^\d+$/.test(trustProxyRaw)) {
    app.set('trust proxy', Number(trustProxyRaw));
  } else {
    app.set('trust proxy', 'loopback');
  }

  // S-003: lock CORS down to a single configured origin.  Default to the
  // cockpit's dev port on localhost; operators can override via env.
  // SB-007 humanization: expose X-Request-Id so a browser fetch caller can
  // read the correlation id from its own response headers.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:4321';
  app.use(
    cors({
      origin: allowedOrigin,
      credentials: false,
      exposedHeaders: ['X-Request-Id', 'X-Render-Job-Id'],
    })
  );

  // S-009: 50 MB JSON bodies were absurdly permissive.  2 MB is enough for
  // every legitimate score we ship; operators with huge scores can raise it
  // explicitly via JSON_BODY_LIMIT.
  const bodyLimit = process.env.JSON_BODY_LIMIT || '2mb';
  app.use(express.json({ limit: bodyLimit }));

  // FS-003: open probes mounted BEFORE /api/* so a misconfigured AUTH stack
  // can't block the orchestrator from reaching them.  Both are dependency-
  // free and ultra-cheap.
  app.use('/', probesRouter);

  // FS-004: API versioning.
  //
  // Every route lives under /api/v1/* going forward.  The unversioned
  // /api/* paths are kept as a backward-compatible alias so existing
  // operators (and the bundled cockpit until FS-009 lands) keep working
  // without a code change.  When v2 introduces breaking response shapes,
  // it mounts at /api/v2/* and /api/* continues to point at v1.
  function mountApi(prefix: string) {
    // FS-004: OpenAPI spec — public (no auth) so clients building against
    // the API can introspect without a key.
    app.use(`${prefix}/openapi.json`, openapiRouter);
    app.use(`${prefix}/health`, healthRouter);
    app.use(`${prefix}/presets`, presetsRouter); // public — no auth needed
    app.use(`${prefix}/render`, requireAuth, rateLimit, renderRouter);
    // S-008: /api/renders POST is just as expensive as /api/render and must
    // pay the same rate-limit cost.  The router-level middleware here also
    // guards every read/delete/patch path on the renders resource.
    app.use(`${prefix}/renders`, requireAuth, rateLimit, rendersRouter);
    app.use(`${prefix}/phonemize`, requireAuth, rateLimit, phonemizeRouter);
    // FS-003: admin-gated metrics surface.
    app.use(`${prefix}/metrics`, metricsRouter);
  }

  mountApi('/api/v1');
  // Backward-compat alias for clients pre-FS-004.  Sets a Deprecation header
  // so callers know to migrate, but otherwise behaves identically.
  app.use('/api', (req, res, next) => {
    // Skip the alias for /api/v1/* (which is the real surface) so the
    // Deprecation header is only emitted for the legacy unprefixed paths.
    if (req.path.startsWith('/v1/') || req.path === '/v1') return next();
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Wed, 31 Dec 2025 23:59:59 GMT');
    res.setHeader('Link', '</api/v1' + req.path + '>; rel="successor-version"');
    next();
  });
  mountApi('/api');

  // SB-005: 404 catch-all for /api/* so clients get JSON envelopes for
  // unknown routes (instead of express's default HTML).
  app.use(apiNotFoundHandler);

  // SB-005: JSON error envelope MUST be the last `.use()` so it sees every
  // throw from every route + middleware above.
  app.use(errorHandler);

  // FS-003: register periodic samplers for queue depth + render store
  // bytes.  Each sampler is also invoked synchronously at /api/metrics
  // request time so an alerting rule's first scrape always sees fresh
  // values.
  registerSampler(() => {
    try {
      const q = getRenderQueue();
      queueDepthGauge.set(q.depth);
      queueInflightGauge.set(q.inFlight ? 1 : 0);
    } catch { /* queue not yet available */ }
  });
  registerSampler(() => {
    try {
      const snap = getRenderBudgetSnapshot();
      renderStoreBytesUsedGauge.set(snap.usedBytes);
      renderStoreBudgetBytesGauge.set(snap.storeBudgetBytes);
    } catch { /* render store not available */ }
  });
  startSamplers(Number(process.env.METRICS_SAMPLE_INTERVAL_MS) || 5_000);

  // FS-003: signal /readyz that init has completed and the process is
  // ready to serve real traffic.  Anything that needs to happen BEFORE the
  // first ready=true response must happen above this line.
  markInitComplete();

  return app;
}
