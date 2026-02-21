import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { renderRouter } from './routes/render.js';
import { rendersRouter } from './routes/renders.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API Routes
  app.use('/api/health', healthRouter);
  app.use('/api/render', renderRouter);
  app.use('/api/renders', rendersRouter);

  return app;
}
