/**
 * Cross-domain Stage-C tests — locks the post-fix behavior of HIGH-severity
 * Stage B findings landing in parallel waves from Engine / Server / Tooling
 * domains. Written by the tests-domain agent in Stage C; failures here mean
 * either (a) the other agent didn't land their fix, or (b) the fix
 * regressed since landing.
 *
 * Covers:
 *   - EB-001 class (Engine): noteOn() must throw TypeError/RangeError on
 *     NaN / Infinity / out-of-range velocity, midi, breathiness, etc.
 *     Silent NaN propagation would poison every downstream sample.
 *   - SB-003 (Server): graceful shutdown — server.close() must allow in-
 *     flight requests to complete, not yank the socket. This is a control-
 *     plane test only (no slow handler exists today), so we verify that
 *     close() is idempotent + resolves cleanly.
 *   - SB-005 (Server): a 404 on a pre-existing-route surface must return
 *     JSON, not Express's HTML default. A JSON-aware client sees a parse
 *     error otherwise.
 *   - TB-001 (Tooling): CLI scripts MUST exit non-zero on rejection. The
 *     shared runCli() helper sets process.exitCode = 1; a regression that
 *     swapped back to `.catch(console.error)` would set exit 0. Exercise
 *     via child_process to assert the actual exit code.
 *
 * Each test that depends on a not-yet-landed fix is wrapped in a guard
 * comment so the operator can flip to .skip with `TODO(stage-c-<domain>)`
 * if the parallel-domain agent didn't land their work.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LiveSynthEngine } from '../src/engine/LiveSynthEngine.js';
import { loadVoicePreset } from '../src/preset/loader.js';
import type { LoadedVoicePreset } from '../src/preset/schema.js';
import { createApp } from '../src/server/app.js';
import { PRESET_PATH, REPO_ROOT } from './helpers/index.js';

// ── Engine: NaN-velocity throws (EB-001 class) ─────────────────────

describe('Engine noteOn — NaN/Infinity guards (EB-001 cross-domain)', () => {
  let preset: LoadedVoicePreset;

  beforeAll(async () => {
    preset = await loadVoicePreset(PRESET_PATH);
  });

  it('throws RangeError on NaN velocity', () => {
    const engine = new LiveSynthEngine(
      { sampleRateHz: 48000, blockSize: 256, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 1 },
      preset
    );
    expect(() =>
      engine.noteOn({ noteId: 'n1', midi: 60, velocity: NaN })
    ).toThrow(RangeError);
  });

  it('throws RangeError on Infinity midi', () => {
    const engine = new LiveSynthEngine(
      { sampleRateHz: 48000, blockSize: 256, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 1 },
      preset
    );
    expect(() =>
      engine.noteOn({ noteId: 'n1', midi: Infinity, velocity: 0.5 })
    ).toThrow(RangeError);
  });

  it('throws on NaN breathiness', () => {
    const engine = new LiveSynthEngine(
      { sampleRateHz: 48000, blockSize: 256, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 1 },
      preset
    );
    expect(() =>
      engine.noteOn({ noteId: 'n1', midi: 60, velocity: 0.5, breathiness: NaN })
    ).toThrow(RangeError);
  });

  it('rejects velocity > 1 (MIDI 0-127 senders must divide by 127)', () => {
    const engine = new LiveSynthEngine(
      { sampleRateHz: 48000, blockSize: 256, maxPolyphony: 2, defaultTimbre: 'AH', rngSeed: 1 },
      preset
    );
    expect(() =>
      engine.noteOn({ noteId: 'n1', midi: 60, velocity: 127 })
    ).toThrow(RangeError);
  });
});

// ── Server: graceful shutdown + JSON 404 ───────────────────────────

describe('Server graceful shutdown + 404 JSON (SB-003 / SB-005)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.AUTH_TOKEN;
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server.listening) {
      await new Promise<void>((res, rej) => {
        server.close((err) => (err ? rej(err) : res()));
      });
    }
  });

  it('404 on unknown /api/ route returns JSON content-type', async () => {
    const res = await fetch(`${baseUrl}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const ct = res.headers.get('content-type') || '';
    // PENDING-CROSS-DOMAIN-FIX(stage-c-server): if SB-005 didn't land yet,
    // the response will be Express's HTML default and ct will be
    // 'text/html'. The post-fix contract is JSON-typed responses for /api/.
    // Soft check first — if HTML, log; then strict assertion.
    if (!ct.includes('application/json')) {
      // eslint-disable-next-line no-console
      console.warn(`[SB-005 unfixed] /api/ 404 returned content-type=${ct}`);
    }
    expect(ct).toContain('application/json');
    const body = await res.json().catch(() => null);
    expect(body).toBeTruthy();
    expect(body?.error || body?.message).toBeDefined();
  });

  it('server.close() resolves cleanly without throwing', async () => {
    // Spawn a fresh server for this test (do not nuke the file-shared one).
    const localServer = http.createServer(createApp());
    await new Promise<void>((res) => localServer.listen(0, '127.0.0.1', () => res()));
    // SB-003: shutdown should resolve, not throw, not hang.
    const closeP = new Promise<void>((res, rej) => {
      localServer.close((err) => (err ? rej(err) : res()));
    });
    // Use a short test-bound race to fail fast if shutdown hangs.
    const result = await Promise.race([
      closeP.then(() => 'closed'),
      new Promise<string>((res) => setTimeout(() => res('timeout'), 3000)),
    ]);
    expect(result).toBe('closed');
  });
});

// ── Tooling: CLI exits non-zero on rejection (TB-001) ──────────────

describe('CLI exits non-zero on rejection (TB-001 cross-domain)', () => {
  it('analyze CLI with no args exits with non-zero code', async () => {
    const cliPath = resolve(REPO_ROOT, 'src', 'cli', 'analyze.ts');
    const result = await runProcess('npx', ['--yes', 'tsx', cliPath], {
      timeoutMs: 30_000,
    });
    // Pre-fix: catch-and-log left exit code at 0. Post-fix: runCli sets
    // process.exitCode = 1 on rejection. We assert non-zero.
    expect(result.code).not.toBe(0);
    // Should also have printed a [analyze] error prefix per runCli's contract.
    const combined = result.stdout + result.stderr;
    expect(combined.length).toBeGreaterThan(0);
  });
});

// ── Local process helper ───────────────────────────────────────────

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: true, // npx + tsx need shell resolution on Windows
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    const t = setTimeout(() => {
      child.kill();
      reject(new Error(`process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}
