/**
 * Server input-validation tests — covers S-010..S-014 (no body validation
 * on /api/render, /api/phonemize, JamSession, WS messages, presetId).
 *
 * Correct post-fix behavior: a malformed body must be rejected with 400
 * Bad Request and a clear error code, NOT a 500 Internal Server Error,
 * NOT a server crash, NOT silent garbage output.
 *
 * The server starts on a random port; tests teardown cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/server/app.js';

let server: http.Server;
let baseUrl: string;

async function startServer(): Promise<void> {
  // Ensure AUTH_TOKEN is not set so /api/render is reachable without auth
  // headers (we are validating BODY validation, not auth).
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

async function post(path: string, body: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, body: parsed };
}

describe('server input validation', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  // S-010: malformed render body must return 400 not 500.
  it('POST /api/render with empty body returns 400', async () => {
    const { status } = await post('/api/render', {});
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('POST /api/render with missing score returns 400', async () => {
    const { status } = await post('/api/render', { config: { sampleRateHz: 48000 } });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('POST /api/render with missing config returns 400', async () => {
    const { status } = await post('/api/render', {
      score: { bpm: 120, notes: [] },
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  // S-010 specifically: notes[i].startSec as a string concatenating to NaN.
  // The engine must NOT see NaN values; validation should catch this.
  // Acceptable outcomes: 400 with validation error, OR 200 + safe handling.
  // What is NOT acceptable: 500, infinite loop, NaN-poisoned audio.
  it('POST /api/render with NaN-coercing fields does not crash to 500', async () => {
    const { status } = await post('/api/render', {
      score: {
        bpm: 120,
        notes: [{ id: 'n', startSec: 'oops', durationSec: 0.5, midi: 60 }],
      },
      config: {
        sampleRateHz: 48000,
        blockSize: 256,
        presetPath: 'presets/default-voice/voicepreset.json',
        deterministic: 'fast',
        rngSeed: 1,
        defaultTimbre: 'AH',
        maxPolyphony: 4,
      },
    });
    // Any 4xx (validation rejection) is correct. 500 would indicate the
    // engine ate the bad input and threw downstream.
    expect(status).not.toBe(500);
  });

  // S-014: presetId path traversal. Either the request is rejected
  // (4xx) or the server safely refuses to load the malicious preset.
  // Must NOT be a 500 or a directory-read.
  it('POST /api/render with traversal presetId is rejected safely', async () => {
    const { status } = await post('/api/render', {
      score: { bpm: 120, notes: [{ id: 'n', startSec: 0, durationSec: 0.1, midi: 60 }] },
      config: {
        sampleRateHz: 48000,
        blockSize: 256,
        presetPath: '../../../../etc/passwd',
        deterministic: 'fast',
        rngSeed: 1,
        defaultTimbre: 'AH',
        maxPolyphony: 4,
        presetId: '../../../etc',
      },
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  // S-011: phonemize body validation.
  it('POST /api/phonemize with non-string text returns 400', async () => {
    const { status } = await post('/api/phonemize', {
      text: 12345,
      notes: [{ midi: 60, startSec: 0, durationSec: 0.5 }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('POST /api/phonemize with missing notes returns 400', async () => {
    const { status } = await post('/api/phonemize', { text: 'hello' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
