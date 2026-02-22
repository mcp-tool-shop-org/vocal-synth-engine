import type { Request, Response, NextFunction } from 'express';

const windowMs = 60_000; // 1 minute
const maxPerWindow = Number(process.env.RATE_LIMIT_RPM) || 20;

const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  let entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    hits.set(ip, entry);
  }

  entry.count++;

  if (entry.count > maxPerWindow) {
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  next();
}
