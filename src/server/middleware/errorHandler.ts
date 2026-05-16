/**
 * SB-005 — JSON error envelope for every unhandled throw.
 *
 * BEFORE: express's default `finalhandler` emitted text/html with a stack
 * trace on any error, leaking source paths to API clients and forcing the
 * cockpit to parse HTML to surface a useful message.
 *
 * AFTER: every error becomes
 *   { ok: false, code, message, hint?, requestId }
 * with the correct status code AND a `code` that the cockpit can switch on
 * without string-matching messages.
 *
 * Humanization lens: the `hint` is a sentence written for a HUMAN OPERATOR
 * — "delete old renders or raise RENDER_STORE_BUDGET_MB" beats a hex
 * stack frame.  The `requestId` lets the user paste it into a bug report.
 *
 * The handler is registered LAST in createApp() (after all routes) so it
 * catches everything express forwards to it.
 */
import type { Request, Response, NextFunction } from 'express';
import { getLogger } from '../util/logger.js';

const NODE_ENV = process.env.NODE_ENV;

/**
 * Custom error class so handlers can THROW a fully-populated error and the
 * middleware will faithfully serialise it.  Plain `new Error('...')` still
 * works — it just won't carry a hint or a custom status.
 */
export class HttpError extends Error {
  status: number;
  code: string;
  hint?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

interface ErrorEnvelope {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  requestId?: string;
  details?: Record<string, unknown>;
  stack?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // If headers were already sent, delegate to the default handler.  Express
  // can't switch to JSON once bytes have flushed; the connection will be
  // torn down.  This is the documented escape hatch from express docs.
  if (res.headersSent) {
    return _next(err);
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let hint: string | undefined;
  let details: Record<string, unknown> | undefined;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
    hint = err.hint;
    details = err.details;
  } else if (err && typeof err === 'object') {
    // express.json() bodyParser error: status + type set on the error.
    if ((err as any).type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message = 'Request body exceeds size limit';
      hint = 'Reduce the score size or raise JSON_BODY_LIMIT (default 2mb)';
    } else if ((err as any).type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Request body is not valid JSON';
      hint = 'Check the Content-Type header is application/json and the body parses';
    } else if (typeof (err as any).status === 'number' && (err as any).status >= 400 && (err as any).status < 600) {
      status = (err as any).status;
      code = (err as any).code || (status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
      message = (err as any).message || message;
    } else if ((err as any).code === 'ENOENT') {
      status = 500;
      code = 'ASSET_NOT_FOUND';
      message = (err as any).message || message;
      hint = 'A required file is missing from the deployment — check the boot logs';
    } else if (typeof (err as any).message === 'string') {
      message = (err as any).message;
    }
  } else if (typeof err === 'string') {
    message = err;
  }

  const envelope: ErrorEnvelope = {
    ok: false,
    code,
    message,
    requestId: req.requestId,
  };
  if (hint) envelope.hint = hint;
  if (details) envelope.details = details;
  if (NODE_ENV !== 'production' && err && (err as any).stack) {
    envelope.stack = String((err as any).stack);
  }

  const logger = getLogger({ requestId: req.requestId });
  // Stack lives in the log line for operators — never in the response body
  // outside of dev — so users don't see source paths.
  const logFields = {
    code,
    status,
    method: req.method,
    path: req.path,
    err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
  };
  if (status >= 500) {
    logger.error(logFields, 'request_error');
  } else {
    logger.warn(logFields, 'request_error');
  }

  res.status(status).type('application/json').send(JSON.stringify(envelope));
}

/**
 * 404 fallback for /api/* requests that didn't match any route.  Plain text
 * 404s confuse SPA clients that probe for endpoints; this gives them a
 * machine-parseable envelope identical in shape to every other error.
 */
export function apiNotFoundHandler(req: Request, _res: Response, next: NextFunction) {
  // Only fire for /api/* paths so the static-file / SPA-fallback handler in
  // index.prod.ts can still serve index.html for unknown GETs.
  if (!req.path.startsWith('/api/')) return next();
  next(
    new HttpError(404, 'NOT_FOUND', `No API route matches ${req.method} ${req.path}`, {
      hint: 'Check the path spelling and the HTTP method',
    }),
  );
}
