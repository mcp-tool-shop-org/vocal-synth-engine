import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createServer as createViteServer } from 'vite';
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

async function startDevServer() {
  const logger = getLogger();
  const app = createApp();
  const server = createServer(app);

  // Boot log: preset info
  const presetInfo = getPresetDirInfo();
  logger.info({ presetDir: presetInfo.presetDir, count: presetInfo.count, presets: presetInfo.presets }, 'boot_presets');

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
      // SB-005-style humanization: include the active/max counts.
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
  const wssJam = new WebSocketServer({ noServer: true });

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

  // S-019 — dev server includes Vite HMR upgrade-routing fallback for any
  // path that isn't /ws or /ws/jam; HMR is unauthenticated.  Bind to
  // 127.0.0.1 by default so a dev server cannot be reached from the LAN
  // unless the operator explicitly opts in via DEV_HOST=0.0.0.0.
  const port = Number(process.env.PORT ?? 4321);
  const host = process.env.DEV_HOST || '127.0.0.1';
  server.listen(port, host, () => {
    const displayHost = host === '127.0.0.1' ? 'localhost' : host;
    logger.info({ port, host: displayHost, mode: 'dev' }, 'server_listening');
    if (host !== '127.0.0.1') {
      logger.warn(
        { host },
        'dev_server_lan_exposed_warning'
      );
    }
  });

  // SB-003: graceful shutdown in dev so Ctrl-C drains the render queue and
  // closes WS sessions cleanly — same behaviour as prod.
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
}

startDevServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[dev server] failed to start:', err);
  process.exit(1);
});
