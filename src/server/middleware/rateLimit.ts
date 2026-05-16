import type { Request, Response, NextFunction } from 'express';

const windowMs = 60_000; // 1 minute
const maxPerWindow = Number(process.env.RATE_LIMIT_RPM) || 20;

// Bounded to prevent unbounded RAM growth when an attacker rotates source IPs
// (S-007).  When the cap is reached we evict the oldest entry (LRU-ish via
// Map insertion order).
const MAX_TRACKED_IPS = Number(process.env.RATE_LIMIT_MAX_IPS) || 10_000;

interface HitEntry {
  count: number;
  resetAt: number;
}

const hits = new Map<string, HitEntry>();

// Periodically sweep expired entries so a quiet server still cleans up.
const SWEEP_INTERVAL_MS = 5 * 60_000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, SWEEP_INTERVAL_MS);
// Allow the process to exit cleanly in tests/scripts.
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  // req.ip is honoured only when app.set('trust proxy', ...) is configured
  // in app.ts (see S-006).  Without trust-proxy, behind any reverse proxy
  // every request would appear to come from 127.0.0.1, effectively disabling
  // per-client rate limiting.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };

    // Cap the tracked-IP map.  If at the cap, evict the oldest (first) entry
    // before inserting the new one.
    if (hits.size >= MAX_TRACKED_IPS) {
      const oldestKey = hits.keys().next().value;
      if (oldestKey !== undefined) hits.delete(oldestKey);
    }

    hits.set(ip, entry);
  }

  entry.count++;

  if (entry.count > maxPerWindow) {
    // SB-007 humanization — clients (and humans tail-ing logs) need to know
    // exactly when they can retry, NOT a vague "try later".  Set
    // `Retry-After` per RFC 7231 and emit the same JSON envelope shape every
    // other error uses so the cockpit can switch on `code`.
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      ok: false,
      code: 'RATE_LIMITED',
      message: `Too many requests — rate limit is ${maxPerWindow} per minute`,
      hint: `Wait ${retryAfterSec}s then retry, or raise RATE_LIMIT_RPM`,
      requestId: (req as any).requestId,
      details: {
        retryAfterSec,
        limitPerMinute: maxPerWindow,
        resetAt: new Date(entry.resetAt).toISOString(),
      },
    });
    return;
  }

  next();
}

/** Test-only helper to reset the in-memory hit map between cases. */
export function _resetRateLimitForTests() {
  hits.clear();
}
