import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createServer as createViteServer } from 'vite';
import { requireWsAuth } from './middleware/auth.js';
import { getPresetDirInfo } from './services/renderScoreToWav.js';
import { LiveSession } from './services/LiveSession.js';
import { JamSessionManager } from './services/JamSessionManager.js';
import type { ClientMessage } from '../types/live.js';
import type { JamClientMessage } from '../types/jam.js';

async function startDevServer() {
  const app = createApp();
  const server = createServer(app);

  // Boot log: preset info
  const presetInfo = getPresetDirInfo();
  console.log(`[boot] PRESET_DIR  = ${presetInfo.presetDir} (${presetInfo.count} presets: ${presetInfo.presets.join(', ') || 'NONE'})`);

  // Create Vite server in middleware mode
  const vite = await createViteServer({
    root: resolve(process.cwd(), 'apps/cockpit'),
    server: {
      middlewareMode: true,
      hmr: {
        server
      }
    },
    appType: 'spa'
  });

  // Use vite's connect instance as middleware
  app.use(vite.middlewares);

  // ── WebSocket: Live Mode ───────────────────────────────────
  const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_LIVE_SESSIONS) || 4;
  const wss = new WebSocketServer({ noServer: true });
  const activeSessions = new Map<WebSocket, LiveSession>();

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
  const wssJam = new WebSocketServer({ noServer: true });

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

  // ── Manual upgrade routing ──────────────────────────────────────
  // Vite HMR attaches its own 'upgrade' handler to the HTTP server.
  // We must capture it and route explicitly to avoid double-handling.
  const viteUpgradeHandlers = server.listeners('upgrade').slice();
  server.removeAllListeners('upgrade');

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url || '/', `http://${req.headers.host}`);
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/jam') {
      wssJam.handleUpgrade(req, socket, head, (ws) => {
        wssJam.emit('connection', ws, req);
      });
    } else {
      // Forward to Vite HMR
      for (const handler of viteUpgradeHandlers) {
        (handler as Function).call(server, req, socket, head);
      }
    }
  });

  const port = Number(process.env.PORT ?? 4321);
  server.listen(port, () => {
    console.log(`VocalSynth Cockpit (DEV) running at http://localhost:${port}`);
  });
}

startDevServer().catch(console.error);
