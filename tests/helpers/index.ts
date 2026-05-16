/**
 * Shared test helpers — Stage C TSB-006 closer.
 *
 * Before this module existed, `PRESET_PATH = resolve(__dirname, '..',
 * 'presets', 'default-voice', 'voicepreset.json')` was copy-pasted across
 * four test files, `hashFloat32` across two, and `startServer`/`stopServer`
 * boilerplate across three. When the preset moved, four files had to change
 * in lockstep — and one was always missed. Centralise here.
 *
 * IMPORTANT for auth-enabled tests: src/server/middleware/auth.ts captures
 * `process.env.AUTH_TOKEN` at MODULE IMPORT TIME. Tests that need to
 * exercise the AUTH_TOKEN code path must call `vi.stubEnv('AUTH_TOKEN',
 * 'test-secret')` BEFORE the first import of src/server/app.ts AND use
 * `vi.resetModules()` to clear any previous import. The default test server
 * here intentionally clears AUTH_TOKEN; see `tests/server-auth.test.ts` for
 * the auth-enabled pattern.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root — useful for resolving fixtures (test-score.json etc.) */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Default voice preset, used by every engine-determinism / envelope /
 *  score-fixture test. */
export const PRESET_PATH = resolve(REPO_ROOT, 'presets', 'default-voice', 'voicepreset.json');

/** SHA-256 hex of the float32 buffer's underlying bytes (host-LE, consistent
 *  across runs on the same architecture). */
export function hashFloat32(buf: Float32Array): string {
  const h = createHash('sha256');
  h.update(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return h.digest('hex');
}

export interface TestServer {
  server: http.Server;
  baseUrl: string;
}

/**
 * Start an HTTP test server on a random loopback port. Clears AUTH_TOKEN by
 * default so requests don't have to carry a Bearer header. For auth-enabled
 * coverage use the dedicated pattern in `tests/server-auth.test.ts` instead.
 *
 * The `createApp` factory is passed in so tests can opt into a freshly
 * imported app (the only way to exercise AUTH_TOKEN paths — see module-doc).
 */
export async function startTestServer(
  createApp: () => import('express').Express,
  opts: { clearAuthToken?: boolean } = { clearAuthToken: true }
): Promise<TestServer> {
  if (opts.clearAuthToken !== false) {
    delete process.env.AUTH_TOKEN;
  }
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', () => resolveListen())
  );
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

export async function stopTestServer(srv: TestServer): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    srv.server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
}
