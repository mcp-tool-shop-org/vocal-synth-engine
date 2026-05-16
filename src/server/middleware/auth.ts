import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Loud fail-open warning at startup so an operator cannot accidentally
// expose the server to LAN without realising auth is disabled.
if (!AUTH_TOKEN) {
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] WARNING: AUTH_TOKEN is NOT SET in production. ALL api routes are open. ' +
        'Set AUTH_TOKEN=<secret> before exposing this server.'
    );
  } else {
    console.warn('[auth] AUTH_TOKEN not set — running in open-access mode (dev default).');
  }
}

/**
 * Constant-time string compare.  Hashes both sides to a fixed-length digest
 * before comparing so length differences do not leak through timingSafeEqual's
 * length check.
 */
function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next(); // no token configured = open access

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const presented = header.slice('Bearer '.length);
    if (safeTokenEqual(presented, AUTH_TOKEN)) return next();
  }

  // NOTE: ?token= query auth was removed (S-004).  URLs containing the token
  // leak through access logs, referers, and browser history.  Use the
  // Authorization header instead.  For <audio>/<video> playback, fetch via
  // XHR with the header and create a blob URL.
  res.status(401).json({
    ok: false,
    code: 'UNAUTHORIZED',
    error: 'Unauthorized', // legacy field for older clients
    message: 'Missing or invalid Authorization header',
    hint: 'Send Authorization: Bearer <AUTH_TOKEN>',
    requestId: (req as any).requestId,
  });
}

export function requireWsAuth(token: string | undefined): boolean {
  if (!AUTH_TOKEN) return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  return safeTokenEqual(token, AUTH_TOKEN);
}
