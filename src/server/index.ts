import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

import { healthRouter } from './routes/health.js';
import { renderRouter } from './routes/render.js';
import { rendersRouter } from './routes/renders.js';

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// API Routes
app.use('/api/health', healthRouter);
app.use('/api/render', renderRouter);
app.use('/api/renders', rendersRouter);

// Serve static Astro app
const cockpitDist = resolve(process.cwd(), 'apps/cockpit/dist');
if (existsSync(cockpitDist)) {
  console.log(`Serving static files from ${cockpitDist}`);
  app.use(express.static(cockpitDist, { index: false }));

  // Fallback: serve index.html for any unknown GET
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(join(cockpitDist, "index.html"));
    } else {
      next();
    }
  });
} else {
  console.warn(`Warning: Cockpit dist not found at ${cockpitDist}. Run 'npm run build:cockpit' first.`);
  app.use((req, res) => {
    res.status(404).send('Cockpit UI not built. Run npm run build:cockpit');
  });
}

// WebSocket setup (stubbed for future)
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: "hello", msg: "ws connected" }));
  console.log('Client connected via WebSocket');
  ws.on('message', (message) => {
    console.log('Received:', message.toString());
  });
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

const port = Number(process.env.PORT ?? 4321);
server.listen(port, () => {
  console.log(`VocalSynth Cockpit running at http://localhost:${port}`);
});
