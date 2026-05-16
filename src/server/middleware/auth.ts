/**
 * Authentication middleware.
 *
 * Three modes (precedence: KEYS_FILE > KEYS > legacy AUTH_TOKEN > open):
 *
 *   1. AUTH_KEYS_FILE=/path/to/keys.json
 *      Loaded at module-import time.  File is a JSON array of
 *      { id, key, createdAt?, admin? } objects.  Reload happens only on
 *      process restart (operator-controlled cadence).
 *
 *   2. AUTH_KEYS='[{"id":"alice","key":"..."}]'
 *      Inline JSON string for environments where mounting a file is awkward
 *      (e.g. fly.io secrets, k8s env-only configs).
 *
 *   3. AUTH_TOKEN=<single-secret>
 *      Legacy single-token mode preserved for backward compatibility with
 *      every existing operator.  No keys-file/inline-JSON path required.
 *      Resolves to a synthetic identity { id: 'legacy', admin: true } so
 *      downstream code that consumes req.userId / req.principal still
 *      works — no per-user filtering, full visibility (matches prior
 *      behaviour).
 *
 *   4. None set
 *      Open access.  Loud warning at startup in production.
 *
 * The chosen mode is decided ONCE at module load.  Reloading at runtime
 * would require a SIGHUP handler we deliberately don't introduce here.
 */
import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authFailuresTotal } from '../util/metrics.js';

export interface ApiKey {
  /** Stable identifier flowed into req.userId and meta.createdBy. */
  id: string;
  /** Bearer token presented over the wire.  Constant-time compared. */
  key: string;
  /** ISO timestamp the key was minted.  Optional, operator bookkeeping. */
  createdAt?: string;
  /** If true, holder sees every render (not just their own). */
  admin?: boolean;
}

interface AuthState {
  mode: 'keys' | 'legacy' | 'open';
  keys: ApiKey[];
  // sha256(key) → identity, computed once so requireAuth never re-hashes the
  // configured side.  The presented token is hashed at request time.
  digestIndex: Map<string, ApiKey>;
}

function parseKeyArray(raw: unknown, source: string): ApiKey[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON array of {id, key, ...} objects`);
  }
  const out: ApiKey[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${source}[${i}] is not an object`);
    }
    const id = (entry as any).id;
    const key = (entry as any).key;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new Error(`${source}[${i}].id must be a non-empty string (max 128 chars)`);
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`${source}[${i}].key must be a non-empty string`);
    }
    if (seenIds.has(id)) {
      throw new Error(`${source}[${i}].id duplicates an earlier entry: ${id}`);
    }
    seenIds.add(id);
    out.push({
      id,
      key,
      createdAt: typeof (entry as any).createdAt === 'string' ? (entry as any).createdAt : undefined,
      admin: (entry as any).admin === true,
    });
  }
  return out;
}

function sha256Digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function buildAuthState(): AuthState {
  const keysFile = process.env.AUTH_KEYS_FILE;
  const keysInline = process.env.AUTH_KEYS;
  const legacyToken = process.env.AUTH_TOKEN;

  let parsed: ApiKey[] | null = null;
  if (keysFile && keysFile.length > 0) {
    const raw = readFileSync(keysFile, 'utf8');
    parsed = parseKeyArray(JSON.parse(raw), 'AUTH_KEYS_FILE');
  } else if (keysInline && keysInline.length > 0) {
    parsed = parseKeyArray(JSON.parse(keysInline), 'AUTH_KEYS');
  }

  if (parsed && parsed.length > 0) {
    const digestIndex = new Map<string, ApiKey>();
    for (const k of parsed) digestIndex.set(sha256Digest(k.key).toString('hex'), k);
    return { mode: 'keys', keys: parsed, digestIndex };
  }

  if (legacyToken && legacyToken.length > 0) {
    // Synthetic identity so downstream code sees a uniform req.userId.
    const legacy: ApiKey = {
      id: 'legacy',
      key: legacyToken,
      admin: true,
    };
    const digestIndex = new Map<string, ApiKey>();
    digestIndex.set(sha256Digest(legacyToken).toString('hex'), legacy);
    return { mode: 'legacy', keys: [legacy], digestIndex };
  }

  return { mode: 'open', keys: [], digestIndex: new Map() };
}

const authState: AuthState = buildAuthState();

// Loud fail-open warning at startup so an operator cannot accidentally
// expose the server to LAN without realising auth is disabled.
if (authState.mode === 'open') {
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] WARNING: no AUTH_KEYS_FILE / AUTH_KEYS / AUTH_TOKEN configured in production. ' +
        'ALL api routes are open. Configure one before exposing this server.'
    );
  } else {
    console.warn('[auth] no auth configured — running in open-access mode (dev default).');
  }
} else if (authState.mode === 'legacy') {
  console.warn(
    '[auth] legacy AUTH_TOKEN mode — single shared token, admin scope, no per-user attribution. ' +
      'Migrate to AUTH_KEYS / AUTH_KEYS_FILE for per-user identity.'
  );
} else {
  console.log(`[auth] keys mode — ${authState.keys.length} key(s) loaded`);
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Stable identifier for the authenticated caller (req.userId mirrors the principal id). */
    userId?: string;
    /** Full principal record (id + admin scope).  Undefined in open-access mode. */
    principal?: { id: string; admin: boolean };
  }
}

function matchPresentedToken(presented: string): ApiKey | null {
  // Constant-time digest compare against the full set of configured keys.
  // Hashing first means presenting a longer/shorter token does NOT short
  // circuit timingSafeEqual's length check.
  if (presented.length === 0) return null;
  const presentedDigest = sha256Digest(presented);

  // Walk every configured key so the wall-clock time of a 401 doesn't leak
  // which prefix matched.  Map.get() on the hex index would be O(1) but
  // also branchy — the linear walk is cheap (N is small) and timing-stable.
  let matched: ApiKey | null = null;
  for (const k of authState.keys) {
    const keyDigest = sha256Digest(k.key);
    const eq = timingSafeEqual(presentedDigest, keyDigest);
    if (eq && !matched) matched = k;
  }
  return matched;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (authState.mode === 'open') {
    // Open mode: synthesize an "anonymous" admin principal so downstream
    // code that branches on req.principal still has something to read.
    req.userId = 'anonymous';
    req.principal = { id: 'anonymous', admin: true };
    return next();
  }

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const presented = header.slice('Bearer '.length);
    const matched = matchPresentedToken(presented);
    if (matched) {
      req.userId = matched.id;
      req.principal = { id: matched.id, admin: matched.admin === true };
      return next();
    }
  }

  authFailuresTotal.inc();
  res.status(401).json({
    ok: false,
    code: 'UNAUTHORIZED',
    error: 'Unauthorized', // legacy field for older clients
    message: 'Missing or invalid Authorization header',
    hint: 'Send Authorization: Bearer <api-key>',
    requestId: (req as any).requestId,
  });
}

/**
 * Admin-only middleware.  Use AFTER requireAuth on routes that should be
 * restricted to admin-scope keys (e.g. /api/metrics, future preset CRUD).
 * In legacy AUTH_TOKEN mode the synthetic identity has admin:true so
 * behavior is unchanged from before this middleware existed.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.principal || !req.principal.admin) {
    return res.status(403).json({
      ok: false,
      code: 'FORBIDDEN',
      message: 'This route requires an admin key',
      hint: 'Use a key with "admin": true in AUTH_KEYS / AUTH_KEYS_FILE',
      requestId: (req as any).requestId,
    });
  }
  next();
}

export function requireWsAuth(token: string | undefined): boolean {
  if (authState.mode === 'open') return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  return matchPresentedToken(token) !== null;
}

/**
 * Resolve a WS token to its identity (or null if invalid).  Used so jam/live
 * sessions can attribute activity to a specific user when keys-mode is on.
 */
export function resolveWsPrincipal(token: string | undefined): { id: string; admin: boolean } | null {
  if (authState.mode === 'open') return { id: 'anonymous', admin: true };
  if (typeof token !== 'string' || token.length === 0) return null;
  const matched = matchPresentedToken(token);
  if (!matched) return null;
  return { id: matched.id, admin: matched.admin === true };
}

/**
 * Exposed for diagnostics / tests.  Operators querying /api/health/detailed
 * can see the auth mode without leaking the keys themselves.
 */
export function getAuthMode(): 'keys' | 'legacy' | 'open' {
  return authState.mode;
}

export function getAuthKeyCount(): number {
  return authState.keys.length;
}
