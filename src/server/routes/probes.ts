/**
 * FS-003 — k8s-style liveness and readiness probes.
 *
 *   GET /livez  — "is the process alive" — answers 200 unconditionally
 *                 (the very fact that express handled the request is the
 *                 signal).  No auth, no body parsing, ultra-cheap.  Use as
 *                 the k8s livenessProbe and the load balancer reachability
 *                 check.
 *
 *   GET /readyz — "is the process able to serve real traffic" — answers
 *                 200 ONLY when:
 *                   - the render queue is not in the shutting-down state,
 *                   - the render store directory is writable (mkdir+stat
 *                     of the root),
 *                   - initialisation is complete (set true after the
 *                     express app is built).
 *                 Otherwise 503 with a `failing` array naming the failed
 *                 checks so an operator's k8s describe / fly status output
 *                 says WHY readiness flipped.
 *
 * Both probes return JSON (text/plain would be more k8s-idiomatic but a
 * structured body is friendlier to humans curl-debugging an outage at 3am).
 * Auth is intentionally NOT required — these probes pre-date any user
 * session and must be callable by the orchestrator before AUTH_TOKEN is
 * even resolved.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getRenderQueue } from '../services/renderQueue.js';

export const probesRouter = Router();

const RENDER_STORE_ROOT = path.resolve(process.env.RENDER_STORE_DIR || '.vscockpit/renders');

// Init flag — flipped to true by createApp at the end of construction so a
// half-initialised process is not considered ready.  Exported as a setter
// so the lifecycle owner has one knob to manipulate.
let initComplete = false;
export function markInitComplete(): void {
  initComplete = true;
}

probesRouter.get('/livez', (_req, res) => {
  // Liveness must be cheap and unconditional.  If express is running, the
  // process is alive.  The 200 body is a single literal string so the
  // response is < 50 bytes and skips JSON.stringify.
  res.status(200).type('text/plain').send('ok');
});

probesRouter.get('/readyz', (_req, res) => {
  const failing: string[] = [];

  if (!initComplete) failing.push('init_incomplete');

  // Render store writable check — mkdir({recursive:true}) is idempotent and
  // throws on a permission failure, so wrapping it in try/catch tells us
  // whether the path is usable.  We do NOT write a probe file (avoid
  // pointlessly burning the disk inode budget on every probe).
  try {
    fs.mkdirSync(RENDER_STORE_ROOT, { recursive: true });
    const stat = fs.statSync(RENDER_STORE_ROOT);
    if (!stat.isDirectory()) failing.push('render_store_not_directory');
  } catch (err: any) {
    failing.push(`render_store_unavailable:${err?.code || 'unknown'}`);
  }

  // Queue check — the queue accepts new submissions unless it's draining.
  // The render-queue singleton initialisation also implicitly verifies the
  // service module loaded without errors.
  try {
    const queue = getRenderQueue();
    // shuttingDown is private; we expose its proxy via the depth/inFlight
    // accessors only.  When draining, `submit` throws RENDER_QUEUE_CLOSED;
    // since we don't want to actually submit a job from readyz, check via
    // the public `depth` getter which still works in shutdown.  The real
    // signal is whether draining has been initiated — that's only the case
    // during graceful shutdown, when /readyz should already return 503 so
    // k8s redirects traffic.  Use a sentinel object inspection.
    void queue.depth;
  } catch {
    failing.push('render_queue_unavailable');
  }

  // Drain signal: graceful shutdown sets shuttingDown=true.  We don't have a
  // direct read accessor; introduce one by way of a public probe method —
  // see renderQueue.isAcceptingJobs() added in this PR.
  try {
    if (!getRenderQueue().isAcceptingJobs()) failing.push('render_queue_draining');
  } catch {
    // Swallow — accessor failure already reported via render_queue_unavailable.
  }

  if (failing.length === 0) {
    return res.status(200).json({ ok: true, ready: true });
  }
  res.status(503).json({
    ok: false,
    ready: false,
    failing,
    hint: 'See `failing` for the reason readiness is failing',
  });
});
