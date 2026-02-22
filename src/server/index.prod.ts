import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { createApp } from './app.js';
import { requireWsAuth } from './middleware/auth.js';
import { getPresetDirInfo } from './services/renderScoreToWav.js';

const app = createApp();
const server = createServer(app);

// Boot log: preset + render store info
const presetInfo = getPresetDirInfo();
const renderStoreDir = resolve(process.env.RENDER_STORE_DIR || '.vscockpit/renders');
console.log(`[boot] PRESET_DIR  = ${presetInfo.presetDir} (${presetInfo.count} presets: ${presetInfo.presets.join(', ') || 'NONE'})`);
console.log(`[boot] RENDER_STORE_DIR = ${renderStoreDir}`);

if (presetInfo.count === 0) {
  console.warn(`[boot] ⚠ WARNING: No presets found in ${presetInfo.presetDir}. Renders will fail until presets are deployed.`);
}

// Serve static Vite app
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
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? undefined;
  if (!requireWsAuth(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
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
  console.log(`VocalSynth Cockpit (PROD) running at http://localhost:${port}`);
});
