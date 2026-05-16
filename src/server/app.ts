import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { renderRouter } from './routes/render.js';
import { rendersRouter } from './routes/renders.js';
import { presetsRouter } from './routes/presets.js';
import { phonemizeRouter } from './routes/phonemize.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Routes (auth-gated when AUTH_TOKEN is set)
  app.use('/api/health', healthRouter);
  app.use('/api/presets', presetsRouter);           // public — no auth needed
  app.use('/api/render', requireAuth, rateLimit, renderRouter);
  app.use('/api/renders', requireAuth, rendersRouter);
  app.use('/api/phonemize', requireAuth, phonemizeRouter);

  return app;
}
