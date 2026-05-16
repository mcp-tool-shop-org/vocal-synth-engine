/**
 * validateBody — express middleware factory that runs a zod schema against
 * req.body. On parse failure, returns 400 with a descriptive error and
 * short-circuits the handler chain. On success, replaces req.body with the
 * parsed/coerced result so downstream handlers see typed, validated data.
 */
import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }));
      res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Strict ID pattern used to reject path-traversal attempts on path params
 * before they reach the filesystem.  Allows lowercase + uppercase alnum,
 * underscore, dash; up to 64 chars.  Reserved special id 'last' permitted.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_PATTERN.test(id);
}
