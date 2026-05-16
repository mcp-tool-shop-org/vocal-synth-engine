/**
 * Server path-traversal tests — covers S-001 (path traversal on
 * /api/renders/:id/* reads) and S-002 (DELETE /api/renders/:id rm -rf).
 *
 * Correct post-fix behavior: any :id that isn't a strict allowlisted
 * identifier (alphanumeric / hyphen / underscore / 'last') must be
 * rejected with 400 — NEVER reach the filesystem, NEVER read or delete
 * an out-of-tree path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/server/app.js';

let server: http.Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  delete process.env.AUTH_TOKEN;
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function req(method: string, path: string): Promise<{ status: number; bodyText: string }> {
  // Use URL with bypass of express normalization by sending the raw path on the socket.
  const res = await fetch(`${baseUrl}${path}`, { method });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
}

/**
 * Send a raw HTTP request so URL-encoded path traversal is preserved
 * (fetch may normalize segments). Returns response status and body.
 */
function rawRequest(method: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        method,
        path: rawPath,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      }
    );
    socket.on('error', reject);
    socket.end();
  });
}

describe('server path traversal protection', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  // S-001: GET /api/renders/<traversal>/audio.wav must be rejected.
  // We accept any of: 400 (validation), 404 (not found after sanitisation),
  // or 403 (forbidden). The bug returns 200 with file contents OR 500.
  it('GET /api/renders/..%2F..%2Fetc%2Fpasswd/audio.wav is rejected', async () => {
    const { status, body } = await rawRequest(
      'GET',
      '/api/renders/..%2F..%2F..%2Fetc%2Fpasswd/audio.wav'
    );
    // Must NOT be a 200 (would mean file was served).
    expect(status).not.toBe(200);
    // Must NOT contain root:x: (passwd marker).
    expect(body).not.toContain('root:x:');
    // Must be a 4xx error.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('GET /api/renders/..%2F..%2F../some/meta is rejected', async () => {
    const { status } = await rawRequest('GET', '/api/renders/..%2F..%2F..%2Fmeta');
    expect(status).not.toBe(200);
    expect(status).toBeGreaterThanOrEqual(400);
  });

  // S-002: DELETE traversal must not actually rm. Test via /api/renders.
  // Use a benign-but-suspicious id (won't trash test machine even if guard
  // is broken, because path resolves into the repo).
  it('DELETE /api/renders/..%2Fsuspicious is rejected (not a 200)', async () => {
    const { status } = await rawRequest('DELETE', '/api/renders/..%2Fsuspicious');
    // Must be a 4xx, not a 200 (success would imply rm).
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  // Defense-in-depth: dot-slash variants.
  it('GET /api/renders/.%2E%2Fsneaky/audio.wav is rejected', async () => {
    const { status } = await rawRequest('GET', '/api/renders/.%2E%2Fsneaky/audio.wav');
    expect(status).not.toBe(200);
    expect(status).toBeGreaterThanOrEqual(400);
  });

  // Sanity check: 'last' (an allowlisted id) is NOT rejected by the
  // validator — it should reach the handler. May return 404 if no render
  // has been saved, but NOT 400 (validation error). This guards against
  // an over-aggressive allowlist that breaks legitimate use.
  it('GET /api/renders/last/audio.wav passes ID validation', async () => {
    const { status } = await req('GET', '/api/renders/last/audio.wav');
    // 404 (no render saved yet) or 200 (if one exists). NEVER 400.
    expect(status === 404 || status === 200).toBe(true);
  });
});
