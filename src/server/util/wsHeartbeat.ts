/**
 * SB-004 — WebSocket heartbeat.
 *
 * BEFORE: a client whose TCP socket silently dropped (laptop slept,
 * NAT idle-timeout, broken proxy) kept its session on the server forever.
 * The browser knew the connection was gone but our server didn't, so the
 * session counter slowly leaked toward MAX_LIVE_SESSIONS and rejected
 * legitimate new clients.
 *
 * AFTER:
 *   - Every 30s the server PINGs each client and marks it as awaiting-pong.
 *   - The browser's `ws` runtime auto-replies with PONG (this is at the
 *     protocol layer; no application code needs to handle it).
 *   - If the client misses TWO consecutive pings (~60s), we close with
 *     code 1008 and the HUMAN-readable reason "idle timeout — reconnect
 *     to resume", which the cockpit can show verbatim.
 *
 * Humanization: the close reason is a complete sentence written for the
 * end user, not a code.  Operators tail the structured logs and see
 * which sessions timed out so they can correlate spikes with network
 * trouble.
 */
import type { WebSocket, WebSocketServer } from 'ws';
import { getLogger } from './logger.js';

const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 30_000);
// Allow up to 2 missed pings (per ws spec recommendation) before reaping.
const MAX_MISSED_PINGS = Number(process.env.WS_MAX_MISSED_PINGS || 2);
const CLOSE_CODE_IDLE = 1008; // policy violation
const CLOSE_REASON = 'idle timeout — reconnect to resume';

interface HeartbeatState {
  missedPings: number;
}

const states = new WeakMap<WebSocket, HeartbeatState>();

/**
 * Wire heartbeat to a WebSocketServer.  Returns a teardown function so
 * graceful shutdown can stop the interval.
 *
 * `kind` is logged with each timeout event so operators can tell `live`
 * sessions from `jam` sessions at a glance.
 */
export function attachHeartbeat(wss: WebSocketServer, kind: string): () => void {
  const logger = getLogger({ ws: kind });

  // When a client connects, track it and reset on pong.
  wss.on('connection', (ws: WebSocket) => {
    states.set(ws, { missedPings: 0 });
    ws.on('pong', () => {
      const s = states.get(ws);
      if (s) s.missedPings = 0;
    });
    ws.on('close', () => {
      states.delete(ws);
    });
  });

  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const state = states.get(client) ?? { missedPings: 0 };
      if (!states.has(client)) states.set(client, state);

      // OPEN state per ws spec.  CONNECTING (0) hasn't completed the
      // handshake; CLOSING/CLOSED don't accept frames.
      if ((client as any).readyState !== 1) continue;

      if (state.missedPings >= MAX_MISSED_PINGS) {
        logger.warn({ missedPings: state.missedPings }, 'ws_idle_timeout');
        try {
          client.close(CLOSE_CODE_IDLE, CLOSE_REASON);
        } catch {
          try { client.terminate(); } catch {}
        }
        states.delete(client);
        continue;
      }
      state.missedPings++;
      try {
        // ws@8 supports ping(data?, mask?, cb?) — fire-and-forget; pong
        // arrives on the listener we attached on connection.
        client.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();

  return () => clearInterval(interval);
}
