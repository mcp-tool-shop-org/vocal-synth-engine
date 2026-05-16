import type { Request, Response, NextFunction } from 'express';

const AUTH_TOKEN = process.env.AUTH_TOKEN;

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next(); // no token configured = open access

  const header = req.headers.authorization;
  if (header === `Bearer ${AUTH_TOKEN}`) return next();

  // Also accept ?token= query param (for audio playback URLs in <audio> tags)
  if (req.query.token === AUTH_TOKEN) return next();

  res.status(401).json({ error: "Unauthorized" });
}

export function requireWsAuth(token: string | undefined): boolean {
  if (!AUTH_TOKEN) return true;
  return token === AUTH_TOKEN;
}
