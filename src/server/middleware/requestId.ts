/**
 * SB-006 — Per-request correlation ID middleware.
 *
 * Humanization: operators correlate API calls with logs by a single field.
 * If the client supplies `X-Request-Id`, we honour it (so a frontend can
 * surface the same id in its toasts and an operator looking at the user's
 * screenshot can paste it straight into `grep`).  If absent, we mint a
 * short UUID-ish slug.
 *
 * The id is:
 *   - written to `req.requestId`
 *   - echoed back in the `X-Request-Id` response header
 *   - included in the JSON error envelope (see errorHandler.ts)
 *   - used as the child-logger binding (see structuredLog.ts)
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// Allow caller-supplied ids that look like a real correlation id (printable
// ASCII, no whitespace, bounded length).  Otherwise mint our own.
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  let id: string;
  if (typeof incoming === 'string' && SAFE_ID_RE.test(incoming)) {
    id = incoming;
  } else {
    id = `req_${randomUUID().slice(0, 12)}`;
  }
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
