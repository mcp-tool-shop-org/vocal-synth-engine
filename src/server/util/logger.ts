/**
 * SB-006 — Structured logging with `pino` so operators can grep, ship to
 * Datadog/Loki, and correlate every line with the request that produced it.
 *
 * Humanization lens: every log line carries the requestId / sessionId that
 * triggered it, so when a user reports "my render failed at 13:42" the
 * operator can grep `req_abcd1234` and see the entire path through the
 * server — auth, validation, render queue tick, disk-budget check, error.
 *
 * Falls back to a console shim if `pino` is unavailable at runtime (e.g.
 * a stripped install).  We never want logging to crash the server.
 */

type LogFields = Record<string, unknown>;

export interface Logger {
  trace(fields: LogFields | string, msg?: string): void;
  debug(fields: LogFields | string, msg?: string): void;
  info(fields: LogFields | string, msg?: string): void;
  warn(fields: LogFields | string, msg?: string): void;
  error(fields: LogFields | string, msg?: string): void;
  fatal(fields: LogFields | string, msg?: string): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

function getLevelThreshold(): number {
  const want = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[want] ?? 30;
}

function fmt(time: number, level: string, fields: LogFields, msg?: string): string {
  const payload: LogFields = {
    time: new Date(time).toISOString(),
    level,
    ...fields,
  };
  if (msg) payload.msg = msg;
  return JSON.stringify(payload);
}

class ConsoleLogger implements Logger {
  private bindings: LogFields;
  private threshold: number;

  constructor(bindings: LogFields = {}) {
    this.bindings = bindings;
    this.threshold = getLevelThreshold();
  }

  private log(levelName: string, fieldsOrMsg: LogFields | string, msg?: string) {
    if ((LEVELS[levelName] ?? 30) < this.threshold) return;
    const isString = typeof fieldsOrMsg === 'string';
    const fields = isString ? this.bindings : { ...this.bindings, ...(fieldsOrMsg as LogFields) };
    const message = isString ? (fieldsOrMsg as string) : msg;
    const line = fmt(Date.now(), levelName, fields, message);
    if (levelName === 'error' || levelName === 'fatal') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  trace(f: LogFields | string, msg?: string) { this.log('trace', f, msg); }
  debug(f: LogFields | string, msg?: string) { this.log('debug', f, msg); }
  info(f: LogFields | string, msg?: string)  { this.log('info', f, msg); }
  warn(f: LogFields | string, msg?: string)  { this.log('warn', f, msg); }
  error(f: LogFields | string, msg?: string) { this.log('error', f, msg); }
  fatal(f: LogFields | string, msg?: string) { this.log('fatal', f, msg); }

  child(fields: LogFields): Logger {
    return new ConsoleLogger({ ...this.bindings, ...fields });
  }
}

let _logger: Logger | null = null;

/**
 * Lazily create a pino logger if available, otherwise the console shim.
 *
 * NOTE: we deliberately avoid a top-level static import of pino so the
 * server still boots if the dependency hasn't been installed yet.  This
 * keeps the dependency soft for downstream consumers who only use the
 * library (engine + cli) and never spin up the HTTP server.
 */
export function getLogger(bindings: LogFields = {}): Logger {
  if (_logger) return bindings && Object.keys(bindings).length ? _logger.child(bindings) : _logger;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRequire } = require('node:module');
    const req = createRequire(import.meta.url);
    const pino = req('pino');
    _logger = pino({
      level: String(process.env.LOG_LEVEL || 'info'),
      base: { service: 'vocal-synth-engine' },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
    }) as Logger;
  } catch {
    _logger = new ConsoleLogger({ service: 'vocal-synth-engine' });
  }
  return bindings && Object.keys(bindings).length ? _logger.child(bindings) : _logger;
}
