import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { renderRouter } from './routes/render.js';
import { rendersRouter } from './routes/renders.js';
import { presetsRouter } from './routes/presets.js';
import { phonemizeRouter } from './routes/phonemize.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { structuredLog } from './middleware/structuredLog.js';
import { errorHandler, apiNotFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // SB-006: requestId FIRST so every downstream middleware (logger, error
  // handler, rate limiter, validators) can attach it to whatever they emit.
  app.use(requestIdMiddleware);

  // SB-006: one structured line per request so operators can correlate the
  // user-reported requestId with the full request lifecycle.
  app.use(structuredLog);

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

  // API Routes (auth-gated when AUTH_TOKEN is set)
  app.use('/api/health', healthRouter);
  app.use('/api/presets', presetsRouter);           // public — no auth needed
  app.use('/api/render', requireAuth, rateLimit, renderRouter);
  // S-008: /api/renders POST is just as expensive as /api/render and must
  // pay the same rate-limit cost.  The router-level middleware here also
  // guards every read/delete/patch path on the renders resource.
  app.use('/api/renders', requireAuth, rateLimit, rendersRouter);
  app.use('/api/phonemize', requireAuth, rateLimit, phonemizeRouter);

  // SB-005: 404 catch-all for /api/* so clients get JSON envelopes for
  // unknown routes (instead of express's default HTML).
  app.use(apiNotFoundHandler);

  // SB-005: JSON error envelope MUST be the last `.use()` so it sees every
  // throw from every route + middleware above.
  app.use(errorHandler);

  return app;
}
