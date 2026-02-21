import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createServer as createViteServer } from 'vite';

async function startDevServer() {
  const app = createApp();
  const server = createServer(app);

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
    console.log(`VocalSynth Cockpit (DEV) running at http://localhost:${port}`);
  });
}

startDevServer().catch(console.error);
