/**
 * SB-006 — Per-request structured log line.
 *
 * Humanization: every request produces ONE summary line with method, path,
 * status, duration, requestId, and (when present) the operator hint that
 * helped the user understand WHY the request failed.  Operators tail this
 * stream during incidents.
 *
 * We deliberately do NOT log request bodies — they may contain lyrics,
 * preset data, or other large/sensitive payloads.  An operator who needs
 * the body can pull it from the cockpit's own logs by requestId.
 */
import type { Request, Response, NextFunction } from 'express';
import { getLogger } from '../util/logger.js';

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 5_000);

export function structuredLog(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const logger = getLogger({ requestId: req.requestId });
    const fields = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durMs: Math.round(durMs * 100) / 100,
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
    };
    if (res.statusCode >= 500) {
      logger.error(fields, 'request_finished');
    } else if (res.statusCode >= 400) {
      logger.warn(fields, 'request_finished');
    } else if (durMs > SLOW_REQUEST_MS) {
      logger.warn({ ...fields, slowRequest: true }, 'request_finished_slow');
    } else {
      logger.info(fields, 'request_finished');
    }
  });
  next();
}
