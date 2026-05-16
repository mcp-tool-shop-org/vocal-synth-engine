/**
 * SB-003 — Graceful shutdown coordinator.
 *
 * BEFORE: SIGTERM (from Docker, systemd, fly.io) killed the process mid-
 * render.  In-flight HTTP responses were truncated, the cockpit got a
 * connection-reset, and renders were lost.  WebSocket sessions vanished
 * without a `close` frame, leaving browser clients in a "still connected,
 * silently dead" zombie state.
 *
 * AFTER: a single coordinator handles SIGTERM + SIGINT and:
 *   1. Logs `shutdown_started` so operators see the trigger
 *   2. Stops accepting new HTTP connections (server.close)
 *   3. Closes the render queue and waits for the in-flight job (with a cap)
 *   4. Sends a clean 1001 close frame to every WebSocket with a
 *      human-readable reason ("server shutting down — reconnect to resume")
 *   5. Logs each step so the operator can trace how long each phase took
 *   6. Exits 0 (or 1 on timeout)
 *
 * Humanization: the WS close reason is the SAME phrase the cockpit can
 * surface in its reconnect toast.  Operators get a timeline in the logs;
 * end users get a clear reconnect prompt, not a silent disconnect.
 */
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { getLogger } from './logger.js';

export interface ShutdownContext {
  /** HTTP server (closes new connection acceptance). */
  httpServer: Server;
  /** All websocket servers — every open socket gets a 1001 close frame. */
  webSocketServers: WebSocketServer[];
  /** Render queue, if any — drained before exit. */
  drainRenderQueue?: () => Promise<void>;
  /** Optional teardown for jam manager etc. */
  onShutdown?: () => Promise<void> | void;
  /** Overall shutdown deadline (ms). */
  shutdownDeadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 30_000;
const WS_CLOSE_CODE_GOING_AWAY = 1001;
const WS_CLOSE_REASON = 'server shutting down — reconnect to resume';

let shuttingDown = false;

export function installGracefulShutdown(ctx: ShutdownContext): void {
  const logger = getLogger();

  const trigger = (signal: NodeJS.Signals | 'manual') => {
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown_signal_repeat');
      return;
    }
    shuttingDown = true;
    void runShutdown(ctx, signal, logger);
  };

  // SIGTERM = orchestrator (Docker, fly, systemd) requesting a graceful stop.
  // SIGINT = Ctrl-C in dev; same logic so dev behaves like prod.
  process.once('SIGTERM', () => trigger('SIGTERM'));
  process.once('SIGINT', () => trigger('SIGINT'));

  // Unhandled errors should still attempt a graceful shutdown.  We log
  // loudly so the operator gets a stack trace; the process still exits.
  process.on('uncaughtException', (err) => {
    logger.error({ err: { message: err.message, stack: err.stack } }, 'uncaught_exception');
    trigger('manual');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled_rejection');
    trigger('manual');
  });
}

async function runShutdown(
  ctx: ShutdownContext,
  signal: NodeJS.Signals | 'manual',
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  const start = Date.now();
  const deadline = ctx.shutdownDeadlineMs ?? DEFAULT_DEADLINE_MS;
  logger.info({ signal, deadlineMs: deadline }, 'shutdown_started');

  // Hard deadline — if any phase hangs, force-exit with a clear log line so
  // the operator can see WHICH phase exceeded the deadline.
  const deadlineTimer = setTimeout(() => {
    logger.error({ elapsedMs: Date.now() - start }, 'shutdown_deadline_exceeded');
    process.exit(1);
  }, deadline);
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

  // 1) Stop accepting new HTTP connections.  Existing requests still drain.
  await new Promise<void>((resolve) => {
    ctx.httpServer.close((err) => {
      if (err) logger.warn({ err: err.message }, 'http_close_warning');
      logger.info({ phaseMs: Date.now() - start }, 'shutdown_http_closed');
      resolve();
    });
  });

  // 2) Drain the render queue (wait for the in-flight job, reject queued).
  if (ctx.drainRenderQueue) {
    try {
      await ctx.drainRenderQueue();
      logger.info({ phaseMs: Date.now() - start }, 'shutdown_render_queue_drained');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err) }, 'shutdown_render_queue_warning');
    }
  }

  // 3) Close every WebSocket with a 1001 + a HUMAN-READABLE reason so the
  //    browser-side reconnect logic can show the user a real message.
  let wsClosed = 0;
  for (const wss of ctx.webSocketServers) {
    for (const client of wss.clients) {
      try {
        client.close(WS_CLOSE_CODE_GOING_AWAY, WS_CLOSE_REASON);
        wsClosed++;
      } catch {
        try { client.terminate(); } catch {}
      }
    }
    try {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch {}
  }
  logger.info({ phaseMs: Date.now() - start, wsClosed }, 'shutdown_ws_closed');

  // 4) Custom teardown (e.g. JamSessionManager.destroyAll).
  if (ctx.onShutdown) {
    try {
      await ctx.onShutdown();
      logger.info({ phaseMs: Date.now() - start }, 'shutdown_custom_done');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err) }, 'shutdown_custom_warning');
    }
  }

  clearTimeout(deadlineTimer);
  logger.info({ totalMs: Date.now() - start, signal }, 'shutdown_complete');
  process.exit(0);
}
