import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createServer as createViteServer } from 'vite';
import { requireWsAuth } from './middleware/auth.js';
import { getPresetDirInfo } from './services/renderScoreToWav.js';
import { LiveSession } from './services/LiveSession.js';
import type { ClientMessage } from '../types/live.js';

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
  const wss = new WebSocketServer({ server, path: "/ws" });
  const activeSessions = new Map<WebSocket, LiveSession>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') ?? undefined;
    if (!requireWsAuth(token)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const session = new LiveSession(ws);
    activeSessions.set(ws, session);
    console.log(`[live] Client connected (${activeSessions.size} active sessions)`);

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

  const port = Number(process.env.PORT ?? 4321);
  server.listen(port, () => {
    console.log(`VocalSynth Cockpit (DEV) running at http://localhost:${port}`);
  });
}

startDevServer().catch(console.error);
