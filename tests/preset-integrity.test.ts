/**
 * Preset asset-integrity tests — covers T-007 (asset integrity hash was
 * declared in the schema but never verified by the loader; the literal
 * 'sha256:pending' / 'sha256:mock_assets_hash' strings shipped instead of
 * real digests, so corrupted or tampered preset asset files would load
 * silently and degrade synthesis output without any operator signal).
 *
 * Correct post-fix behavior (loader.ts):
 *   - Manifest with no integrity block          → load OK, no warning beyond
 *                                                  the existing log surface.
 *   - Manifest with stub hash (sha256:pending,
 *     sha256:mock_*)                            → load OK, log WARN once.
 *   - Manifest with real hash that MATCHES the
 *     recomputed asset hash                     → load OK silently.
 *   - Manifest with real hash that DOES NOT
 *     match                                      → throw ASSET_INTEGRITY_MISMATCH
 *                                                  with err.code set and
 *                                                  expected/actual fields
 *                                                  populated.
 *
 * We build a synthetic preset under tmp/ for the mismatch test so we don't
 * tamper with the shipping default-voice preset.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadVoicePreset, computeAssetsHash } from '../src/preset/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const REAL_PRESET = resolve(REPO_ROOT, 'presets', 'default-voice', 'voicepreset.json');

/**
 * Build a minimal but VALID voice preset on disk in `dir`. Returns the
 * manifest path. The float32 buffers are tiny but the shapes line up with
 * the loader's consistency checks (maxHarmonics, freqHz length).
 */
function writeSyntheticPreset(
  dir: string,
  opts: { integrityHash?: string } = {}
): { manifestPath: string; assetEntries: Map<string, Buffer> } {
  mkdirSync(join(dir, 'assets'), { recursive: true });

  const maxHarmonics = 4;
  const M = 8; // freq-axis length

  function f32Bytes(n: number, fill: number): Buffer {
    const arr = new Float32Array(n);
    arr.fill(fill);
    return Buffer.from(arr.buffer.slice(0));
  }

  const harmonicsMag = f32Bytes(maxHarmonics, 0.5);
  const envelopeDb = f32Bytes(M, -20);
  const noiseDb = f32Bytes(M, -40);
  const freqHz = f32Bytes(M, 1000);

  writeFileSync(join(dir, 'assets', 'h.f32'), harmonicsMag);
  writeFileSync(join(dir, 'assets', 'e.f32'), envelopeDb);
  writeFileSync(join(dir, 'assets', 'n.f32'), noiseDb);
  writeFileSync(join(dir, 'assets', 'f.f32'), freqHz);

  const assetEntries = new Map<string, Buffer>([
    ['assets/h.f32', harmonicsMag],
    ['assets/e.f32', envelopeDb],
    ['assets/n.f32', noiseDb],
    ['assets/f.f32', freqHz],
  ]);

  const manifest: any = {
    schema: 'mcp-voice-engine.voicepreset',
    version: '0.2.0',
    id: 'synthetic-test',
    sampleRateHz: 48000,
    analysis: {
      frameMs: 42,
      hopMs: 10,
      f0Method: 'yin',
      maxHarmonics,
      envelope: { method: 'moving_average' },
      noise: { method: 'residual_approx', fftSize: 2048 },
    },
    timbres: [
      {
        name: 'AH',
        kind: 'vowel',
        assets: {
          harmonicsMag: 'assets/h.f32',
          envelopeDb: 'assets/e.f32',
          noiseDb: 'assets/n.f32',
          freqHz: 'assets/f.f32',
        },
        defaults: {
          hnrDb: 18,
          breathiness: 0.1,
          vibrato: { rateHz: 5, depthCents: 35, onsetMs: 200 },
        },
      },
    ],
  };
  if (opts.integrityHash !== undefined) {
    manifest.integrity = {
      assetsHash: opts.integrityHash,
      analysisHash: 'sha256:pending',
    };
  }

  const manifestPath = join(dir, 'voicepreset.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, assetEntries };
}

describe('preset asset integrity verification (T-007)', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'vse-preset-integrity-'));
  });

  afterAll(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // T-007 / E-?: tampered asset bytes must cause the loader to throw
  // ASSET_INTEGRITY_MISMATCH rather than silently degrading the synth output.
  it('throws ASSET_INTEGRITY_MISMATCH on tampered asset bytes', async () => {
    const dir = join(tmpRoot, 'tampered');

    // Step 1: write a valid preset, capture its REAL hash.
    const { manifestPath, assetEntries } = writeSyntheticPreset(dir);
    const realHash = computeAssetsHash(assetEntries);

    // Step 2: declare a DIFFERENT hash in the manifest (simulate a
    // preset whose recorded assetsHash was correct at publish time but
    // whose asset bytes have since been modified).
    const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(wrongHash).not.toBe(realHash);

    // Rewrite manifest with the wrong hash.
    writeSyntheticPreset(dir, { integrityHash: wrongHash });

    // Step 3: load and expect a typed throw.
    let caught: any = null;
    try {
      await loadVoicePreset(manifestPath);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('ASSET_INTEGRITY_MISMATCH');
    // The error must include the expected hash for operator triage.
    expect(String(caught?.expected ?? caught?.message ?? '')).toContain(wrongHash);
  });

  it('passes when integrity hash matches the recomputed digest', async () => {
    const dir = join(tmpRoot, 'matching');

    // Step 1: build the preset, capture the real hash.
    const { manifestPath, assetEntries } = writeSyntheticPreset(dir);
    const realHash = computeAssetsHash(assetEntries);

    // Step 2: rewrite manifest WITH the correct hash declared.
    writeSyntheticPreset(dir, { integrityHash: realHash });

    // Step 3: load — must succeed.
    const loaded = await loadVoicePreset(manifestPath);
    expect(loaded).toBeDefined();
    expect(loaded.timbres.AH).toBeDefined();
    expect(loaded.manifest.id).toBe('synthetic-test');
  });

  it('passes (with WARN) on stub hash sha256:pending — backward-compat', async () => {
    const dir = join(tmpRoot, 'stub');

    writeSyntheticPreset(dir, { integrityHash: 'sha256:pending' });
    const loaded = await loadVoicePreset(join(dir, 'voicepreset.json'));
    expect(loaded).toBeDefined();
    expect(loaded.timbres.AH).toBeDefined();
  });

  it('passes when integrity block is entirely absent', async () => {
    const dir = join(tmpRoot, 'no-integrity');
    writeSyntheticPreset(dir); // no integrityHash option
    const loaded = await loadVoicePreset(join(dir, 'voicepreset.json'));
    expect(loaded).toBeDefined();
  });

  // Sanity: the shipping default-voice preset still loads (it has
  // 'sha256:pending' which is on the stub allowlist).
  it('shipping default-voice preset loads (stub hash backward-compat)', async () => {
    const loaded = await loadVoicePreset(REAL_PRESET);
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded.timbres).length).toBeGreaterThan(0);
  });
});
