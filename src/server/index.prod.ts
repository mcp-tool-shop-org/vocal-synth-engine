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
import { liveClientMessageSchema, jamClientMessageSchema } from './services/wsSchemas.js';
import type { ClientMessage } from '../types/live.js';
import type { JamClientMessage } from '../types/jam.js';
import { getLogger } from './util/logger.js';
import { attachHeartbeat } from './util/wsHeartbeat.js';
import { installGracefulShutdown } from './util/gracefulShutdown.js';
import { getRenderQueue } from './services/renderQueue.js';

const logger = getLogger();
const app = createApp();
const server = createServer(app);

// Boot log: preset + render store info
const presetInfo = getPresetDirInfo();
const renderStoreDir = resolve(process.env.RENDER_STORE_DIR || '.vscockpit/renders');
logger.info({ presetDir: presetInfo.presetDir, count: presetInfo.count, presets: presetInfo.presets }, 'boot_presets');
logger.info({ renderStoreDir }, 'boot_render_store');

if (presetInfo.count === 0) {
  logger.warn({ presetDir: presetInfo.presetDir }, 'boot_no_voices_warning');
}

// Serve static Vite app
const cockpitDist = resolve(process.cwd(), 'apps/cockpit/dist');
if (existsSync(cockpitDist)) {
  logger.info({ cockpitDist }, 'boot_static_assets');
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
  logger.warn({ cockpitDist }, 'boot_cockpit_missing');
  app.use((req, res) => {
    res.status(404).send('Cockpit UI not built. Run npm run build:cockpit');
  });
}

// ── WebSocket: Live Mode ───────────────────────────────────────
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_LIVE_SESSIONS) || 4;
const wss = new WebSocketServer({ server, path: "/ws" });
const activeSessions = new Map<WsWebSocket, LiveSession>();

// SB-004: heartbeat ping/pong so dead clients are reaped, not leaked.
attachHeartbeat(wss, 'live');

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? undefined;
  if (!requireWsAuth(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    // SB-005-style humanization: include the active/max counts so the
    // client UI can show "server is full (4/4)" verbatim.
    ws.close(4002, `Server full (${activeSessions.size}/${MAX_CONCURRENT_SESSIONS})`);
    logger.warn({ active: activeSessions.size, max: MAX_CONCURRENT_SESSIONS }, 'live_session_rejected_full');
    return;
  }

  const session = new LiveSession(ws);
  activeSessions.set(ws, session);
  logger.info({ active: activeSessions.size, max: MAX_CONCURRENT_SESSIONS }, 'live_session_connected');

  ws.on('message', async (raw) => {
    try {
      // S-013: validate parsed JSON against the discriminated-union schema
      // BEFORE handing to session.handleMessage.  Replaces the trusted cast.
      const parsed = JSON.parse(raw.toString());
      const result = liveClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Message failed schema validation',
          hint: 'Check the message shape against the live protocol schema',
          issues: result.error.issues.slice(0, 5).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }));
        return;
      }
      await session.handleMessage(result.data as ClientMessage);
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'PARSE_ERROR',
        message: `Invalid message: ${err.message}`,
        hint: 'Send a JSON message matching the live protocol',
      }));
    }
  });

  ws.on('close', () => {
    session.destroy();
    activeSessions.delete(ws);
    logger.info({ active: activeSessions.size }, 'live_session_disconnected');
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'live_ws_error');
    session.destroy();
    activeSessions.delete(ws);
  });
});

// ── WebSocket: Jam Mode ──────────────────────────────────────
const jamManager = new JamSessionManager();
const wssJam = new WebSocketServer({ server, path: "/ws/jam" });

// SB-004: same heartbeat policy for jam sessions.
attachHeartbeat(wssJam, 'jam');

wssJam.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? undefined;
  if (!requireWsAuth(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  jamManager.onConnect(ws);
  logger.info({ connections: jamManager.activeConnectionCount, sessions: jamManager.activeSessionCount }, 'jam_session_connected');

  ws.on('message', async (raw) => {
    try {
      // S-012 + S-013: validate parsed JSON against the jam discriminated
      // union BEFORE jamManager.handleMessage routes it.  session_create
      // payload bounds (blockSize, bpm, seed, timeSig) are enforced here
      // so JamSession can never receive a 2-billion blockSize.
      const parsed = JSON.parse(raw.toString());
      const result = jamClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'jam_error',
          code: 'INVALID_MESSAGE',
          message: 'Message failed schema validation',
          hint: 'Check the message shape against the jam protocol schema',
          issues: result.error.issues.slice(0, 5).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }));
        return;
      }
      await jamManager.handleMessage(ws, result.data as JamClientMessage);
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'jam_error',
        code: 'PARSE_ERROR',
        message: `Invalid message: ${err.message}`,
        hint: 'Send a JSON message matching the jam protocol',
      }));
    }
  });

  ws.on('close', () => {
    jamManager.onDisconnect(ws);
    logger.info({ connections: jamManager.activeConnectionCount }, 'jam_session_disconnected');
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'jam_ws_error');
    jamManager.onDisconnect(ws);
  });
});

const port = Number(process.env.PORT ?? 4321);
server.listen(port, () => {
  logger.info({ port, mode: 'prod' }, 'server_listening');
});

// SB-003: install graceful shutdown.  SIGTERM (Docker/fly) and SIGINT
// (Ctrl-C) both trigger a clean drain: HTTP server stops accepting new
// connections, the render queue finishes its in-flight job, every WS
// gets a 1001 close with a human-readable reason, then exit 0.
installGracefulShutdown({
  httpServer: server,
  webSocketServers: [wss, wssJam],
  drainRenderQueue: () => getRenderQueue().drain(),
  onShutdown: () => {
    jamManager.destroyAll();
    for (const session of activeSessions.values()) session.destroy();
    activeSessions.clear();
  },
});
