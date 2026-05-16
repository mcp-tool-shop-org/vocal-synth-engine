import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { createApp } from './app.js';
import { requireWsAuth } from './middleware/auth.js';
import { getPresetDirInfo } from './services/renderScoreToWav.js';
import { LiveSession } from './services/LiveSession.js';
import { JamSessionManager } from './services/JamSessionManager.js';
import type { ClientMessage } from '../types/live.js';
import type { JamClientMessage } from '../types/jam.js';

const app = createApp();
const server = createServer(app);

// Boot log: preset + render store info
const presetInfo = getPresetDirInfo();
const renderStoreDir = resolve(process.env.RENDER_STORE_DIR || '.vscockpit/renders');
console.log(`[boot] PRESET_DIR  = ${presetInfo.presetDir} (${presetInfo.count} voices: ${presetInfo.presets.join(', ') || 'NONE'})`);
console.log(`[boot] RENDER_STORE_DIR = ${renderStoreDir}`);

if (presetInfo.count === 0) {
  console.warn(`[boot] WARNING: No voices found in ${presetInfo.presetDir}. Renders will fail until voices are deployed.`);
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

// ── WebSocket: Live Mode ───────────────────────────────────────
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_LIVE_SESSIONS) || 4;
const wss = new WebSocketServer({ server, path: "/ws" });
const activeSessions = new Map<WsWebSocket, LiveSession>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? undefined;
  if (!requireWsAuth(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    ws.close(4002, 'Server full');
    console.warn(`[live] Rejected connection: ${activeSessions.size}/${MAX_CONCURRENT_SESSIONS} sessions`);
    return;
  }

  const session = new LiveSession(ws);
  activeSessions.set(ws, session);
  console.log(`[live] Client connected (${activeSessions.size}/${MAX_CONCURRENT_SESSIONS} sessions)`);

  ws.on('message', async (raw) => {
    try {
      const msg: ClientMessage = JSON.parse(raw.toString());
      await session.handleMessage(msg);
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'PARSE_ERROR',
        message: `Invalid message: ${err.message}`,
      }));
    }
  });

  ws.on('close', () => {
    session.destroy();
    activeSessions.delete(ws);
    console.log(`[live] Client disconnected (${activeSessions.size} active sessions)`);
  });

  ws.on('error', (err) => {
    console.error('[live] WebSocket error:', err.message);
    session.destroy();
    activeSessions.delete(ws);
  });
});

// ── WebSocket: Jam Mode ──────────────────────────────────────
const jamManager = new JamSessionManager();
const wssJam = new WebSocketServer({ server, path: "/ws/jam" });

wssJam.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? undefined;
  if (!requireWsAuth(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  jamManager.onConnect(ws);
  console.log(`[jam] Client connected (${jamManager.activeConnectionCount} connections, ${jamManager.activeSessionCount} sessions)`);

  ws.on('message', async (raw) => {
    try {
      const msg: JamClientMessage = JSON.parse(raw.toString());
      await jamManager.handleMessage(ws, msg);
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'jam_error',
        code: 'PARSE_ERROR',
        message: `Invalid message: ${err.message}`,
      }));
    }
  });

  ws.on('close', () => {
    jamManager.onDisconnect(ws);
    console.log(`[jam] Client disconnected (${jamManager.activeConnectionCount} connections)`);
  });

  ws.on('error', (err) => {
    console.error('[jam] WebSocket error:', err.message);
    jamManager.onDisconnect(ws);
  });
});

const port = Number(process.env.PORT ?? 4321);
server.listen(port, () => {
  console.log(`VocalSynth Cockpit (PROD) running at http://localhost:${port}`);
});
