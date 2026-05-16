/**
 * Cockpit auth store + authenticated fetch helpers (FS-009).
 *
 * The daemon's `requireAuth` middleware (src/server/middleware/auth.ts) enforces
 * `Authorization: Bearer <AUTH_TOKEN>` on every /api route when AUTH_TOKEN is
 * set on the server.  Previously the cockpit sent zero auth on any fetch, so
 * the moment an operator turned auth on the bundled UI broke.
 *
 * This module solves that with:
 *
 *  1. A small token store backed by localStorage so the operator only types it
 *     once per browser.
 *  2. `authFetch(url, opts)` — drop-in replacement for `fetch` that injects the
 *     Bearer header when a token is set and surfaces 401 responses through the
 *     `on401()` callback so the UI can open the API-Key panel and tell the
 *     user why.
 *  3. `wsTokenSuffix()` — query-string fragment for WebSocket URLs.  The
 *     standard browser WebSocket constructor does not let us set custom
 *     headers, so the server still accepts `?token=` for /ws + /ws/jam.  The
 *     HTTP side is Bearer-only (S-004).
 *  4. `audioBlobUrl(url)` — wraps an authenticated GET of a WAV into a
 *     `blob:` URL suitable for `<audio>.src`.  Browsers cannot attach the
 *     Authorization header to `<audio>` directly; auth.ts:40-42 in the server
 *     anticipates this pattern.
 */

const STORAGE_KEY = 'vocalsynth.authToken';

let cachedToken: string | null = null;
let on401Handler: ((url: string) => void) | null = null;

/** Load the token once at module-load.  localStorage is sync so this is fine. */
try {
  cachedToken = window.localStorage.getItem(STORAGE_KEY);
} catch {
  // Private-mode browsers / disabled storage — keep cachedToken null and let
  // authFetch behave as an unauthenticated client.  The 401 handler will
  // surface the panel as usual.
  cachedToken = null;
}

export function getToken(): string {
  return cachedToken ?? '';
}

export function hasToken(): boolean {
  return !!cachedToken && cachedToken.length > 0;
}

export function setToken(token: string): void {
  cachedToken = token.trim() || null;
  try {
    if (cachedToken) window.localStorage.setItem(STORAGE_KEY, cachedToken);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage failures are non-fatal; the token still lives in memory for
    // this session.
  }
}

export function clearToken(): void {
  setToken('');
}

export function setOn401(handler: (url: string) => void): void {
  on401Handler = handler;
}

/**
 * Drop-in replacement for `fetch`.  Adds `Authorization: Bearer <token>` when
 * a token is stored.  On 401 we call the on401 callback so the UI can open
 * the API-Key panel — but we still return the Response so callers can read
 * the structured-error body and decide what to do.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const opts: RequestInit = { ...(init ?? {}) };
  if (cachedToken) {
    const headers = new Headers(opts.headers ?? {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${cachedToken}`);
    }
    opts.headers = headers;
  }
  const res = await fetch(input, opts);
  if (res.status === 401 && on401Handler) {
    try {
      on401Handler(typeof input === 'string' ? input : input.toString());
    } catch {
      // Never let a handler throw out of the fetch helper.
    }
  }
  return res;
}

/**
 * Query-string fragment for WebSocket URLs.  Returns "?token=..." when a token
 * is set, or "" when not.  The standard WebSocket constructor does not allow
 * custom headers — the server (index.prod.ts:64, :134) reads the token from
 * the query string for /ws + /ws/jam specifically.  HTTP routes do NOT accept
 * the query token (S-004).
 */
export function wsTokenSuffix(): string {
  return cachedToken ? `?token=${encodeURIComponent(cachedToken)}` : '';
}

/**
 * Fetch a binary resource (typically a WAV) with auth and return a `blob:` URL
 * suitable for `<audio>.src` or `<a>.href`.  Caller is responsible for calling
 * URL.revokeObjectURL when the blob is no longer needed.
 *
 * Returns null and triggers on401 if the fetch was unauthorized.
 */
export async function audioBlobUrl(url: string): Promise<string | null> {
  const res = await authFetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
