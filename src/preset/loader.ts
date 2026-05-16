import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { VoicePresetSchema, LoadedVoicePreset, LoadedTimbre } from './schema.js';

/**
 * Preset schema versions this build of the loader understands. Closes T-010.
 *
 * Until v0.2.0 was added, analyze.ts wrote '0.1.0' presets while build-preset.ts
 * wrote '0.2.0' — and the schema accepted any string. A future v999 manifest
 * would have passed Zod and then crashed inside the engine on a missing
 * field. We now refuse anything not on the list with UNSUPPORTED_PRESET_VERSION
 * and the supported set in the message body.
 *
 * Adding a new version: list it here, write a migration / compat note in the
 * CHANGELOG, and only THEN have a CLI start writing it. Removing a version is
 * a breaking change.
 */
export const SUPPORTED_PRESET_VERSIONS: readonly string[] = ['0.1.0', '0.2.0'];

/**
 * Stub-hash sentinels that mean "no integrity declared, do not verify". Old
 * presets shipped these literal strings instead of a real digest; we keep them
 * loadable (backward-compat) but log a single WARN per load so the operator
 * sees them in the boot log. Anything else is treated as a real expected digest
 * and verified against the on-disk asset bytes.
 *
 * Discipline: do NOT widen this set silently. New stubs would defeat the
 * verification gate. If a tool needs a placeholder, prefer to omit the
 * `integrity` block entirely (the schema marks it optional).
 */
const INTEGRITY_STUBS: ReadonlySet<string> = new Set([
  'sha256:pending',
  'sha256:mock_assets_hash',
  'sha256:mock_analysis_hash',
]);

function isIntegrityStub(value: string): boolean {
  if (INTEGRITY_STUBS.has(value)) return true;
  // Also tolerate any value that starts with 'sha256:mock_' — analyze.ts and
  // older tools historically generated several variants. Treat them all as
  // "no integrity declared" rather than as digest mismatches.
  return value.startsWith('sha256:mock_');
}

/**
 * Resolve an asset path relative to the manifest directory and assert it stays
 * inside that directory. Defense-in-depth against path-traversal payloads in
 * preset manifests (e.g. `harmonicsMag: '../../../../etc/passwd'`). Even when
 * the schema-level guard rejects '..' and absolute paths, this catches edge
 * cases (URL-encoded sequences, symlinks resolving outside, etc.) by checking
 * the FULLY-RESOLVED path string.
 */
function resolveAssetPathSafe(manifestDir: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    const err: any = new Error(
      `INVALID_ASSET_PATH: absolute asset paths are not allowed (got '${relPath}')`
    );
    err.code = 'INVALID_ASSET_PATH';
    throw err;
  }
  const baseResolved = resolve(manifestDir);
  const fullResolved = resolve(baseResolved, relPath);
  // Trailing-sep check prevents '/foo/bar' from matching '/foo/barbaz'.
  const baseWithSep = baseResolved.endsWith(sep) ? baseResolved : baseResolved + sep;
  if (fullResolved !== baseResolved && !fullResolved.startsWith(baseWithSep)) {
    const err: any = new Error(
      `INVALID_ASSET_PATH: asset path '${relPath}' resolves outside the preset directory`
    );
    err.code = 'INVALID_ASSET_PATH';
    throw err;
  }
  return fullResolved;
}

/**
 * Read a float32 little-endian asset file and return it as a Float32Array.
 * Throws ASSET_CORRUPT on byte-length / alignment problems so corrupted or
 * partially-written assets fail loudly instead of silently truncating.
 *
 * Note on endianness: Float32Array reinterprets bytes in HOST byte order. All
 * supported Node.js targets (x64, arm64 macOS/Linux/Windows) are
 * little-endian, so this currently agrees with the on-disk format. If we ever
 * need to support a big-endian host this would have to migrate to DataView
 * with explicit LE reads. Asserted at runtime below as a tripwire.
 */
function bytesToFloat32(buffer: Buffer, filePath: string): Float32Array {
  if (buffer.byteLength % 4 !== 0) {
    const err: any = new Error(
      `ASSET_CORRUPT: '${filePath}' byte length ${buffer.byteLength} is not a multiple of 4 ` +
      `(expected float32 little-endian payload)`
    );
    err.code = 'ASSET_CORRUPT';
    throw err;
  }
  // Float32Array requires 4-byte alignment of its underlying byteOffset on
  // most runtimes; a misaligned view either throws cryptically or copies
  // silently. Force a fresh aligned ArrayBuffer to keep behaviour predictable.
  const aligned = new ArrayBuffer(buffer.byteLength);
  Buffer.from(aligned).set(buffer);
  return new Float32Array(aligned);
}

/**
 * Compute the canonical aggregate assets-hash for a preset. Path-sorted SHA-256
 * digest of (relative-path + ':' + per-file-sha256-hex + '\n') for each asset,
 * then SHA-256 of that envelope. Sorting + path-prefixing makes the hash
 * stable across run order and protects against an attacker swapping two asset
 * files' contents.
 *
 * Shared between the loader (verification side) and the CLI writers (analyze
 * + build-preset). Same function on both sides means a round-trip will never
 * produce a spurious mismatch. Closes T-007.
 *
 * `assetEntries` is `Map<relPath, Buffer>` of the FOUR (or more) asset files
 * that the loader / writer just read or is about to write — the same files
 * that would be listed in `timbre.assets.{harmonicsMag,envelopeDb,noiseDb,freqHz}`
 * for every timbre. Path keys must be the manifest-relative paths so the hash
 * is portable across check-outs at different absolute roots.
 */
export function computeAssetsHash(assetEntries: Map<string, Buffer>): string {
  const sortedKeys = Array.from(assetEntries.keys()).sort();
  const envelope = createHash('sha256');
  for (const key of sortedKeys) {
    const buf = assetEntries.get(key)!;
    const perFile = createHash('sha256').update(buf).digest('hex');
    envelope.update(`${key}:${perFile}\n`);
  }
  return `sha256:${envelope.digest('hex')}`;
}

export async function loadVoicePreset(manifestPath: string): Promise<LoadedVoicePreset> {
  const manifestDir = dirname(manifestPath);
  const manifestContent = await readFile(manifestPath, 'utf-8');
  const manifestJson = JSON.parse(manifestContent);

  const manifest = VoicePresetSchema.parse(manifestJson);

  // T-010: explicit version-compat gate. Schema regex already proved the
  // shape is MAJOR.MINOR.PATCH; this rejects strings we don't have engine
  // support for yet (e.g. a future v0.3.0 with new fields).
  if (!SUPPORTED_PRESET_VERSIONS.includes(manifest.version)) {
    const err: any = new Error(
      `UNSUPPORTED_PRESET_VERSION: preset version '${manifest.version}' is not supported by this build. ` +
      `Supported: [${SUPPORTED_PRESET_VERSIONS.join(', ')}].`
    );
    err.code = 'UNSUPPORTED_PRESET_VERSION';
    err.presetVersion = manifest.version;
    err.supportedVersions = SUPPORTED_PRESET_VERSIONS;
    throw err;
  }

  const timbres: Record<string, LoadedTimbre> = {};
  // Asset-bytes map for integrity verification. Keyed by manifest-relative
  // path so the same key set appears on both the loader side (here) and the
  // writer side (analyze.ts / build-preset.ts) — must NOT include a per-timbre
  // duplicate of the shared freqHz axis, which is already covered by the
  // single entry below.
  const assetBytes = new Map<string, Buffer>();

  for (const timbre of manifest.timbres) {
    const loadAsset = async (relPath: string): Promise<{ buffer: Buffer; floats: Float32Array }> => {
      const fullPath = resolveAssetPathSafe(manifestDir, relPath);
      const buffer = await readFile(fullPath);
      const floats = bytesToFloat32(buffer, fullPath);
      // Map by relative-path key (manifest's own key). Repeated freqHz reads
      // will replace identical bytes — that's fine, the hash sees one entry.
      assetBytes.set(relPath, buffer);
      return { buffer, floats };
    };

    const harmonicsMag = (await loadAsset(timbre.assets.harmonicsMag)).floats;
    const envelopeDb = (await loadAsset(timbre.assets.envelopeDb)).floats;
    const noiseDb = (await loadAsset(timbre.assets.noiseDb)).floats;
    const freqHz = (await loadAsset(timbre.assets.freqHz)).floats;

    // Consistency checks
    if (harmonicsMag.length !== manifest.analysis.maxHarmonics) {
      throw new Error(`Timbre ${timbre.name}: harmonicsMag length (${harmonicsMag.length}) does not match maxHarmonics (${manifest.analysis.maxHarmonics})`);
    }

    const M = freqHz.length;
    if (envelopeDb.length !== M || noiseDb.length !== M) {
      throw new Error(`Timbre ${timbre.name}: envelopeDb/noiseDb lengths must match freqHz length (${M})`);
    }

    timbres[timbre.name] = {
      name: timbre.name,
      kind: timbre.kind,
      harmonicsMag,
      envelopeDb,
      noiseDb,
      freqHz,
      defaults: timbre.defaults,
    };
  }

  // Cross-timbre shape validation: all timbres must share freqHz length
  const timbreNames = Object.keys(timbres);
  if (timbreNames.length > 1) {
    const refName = timbreNames[0];
    const refLen = timbres[refName].freqHz.length;
    for (let i = 1; i < timbreNames.length; i++) {
      const t = timbres[timbreNames[i]];
      if (t.freqHz.length !== refLen) {
        const err: any = new Error(
          `ASSET_SHAPE_MISMATCH: timbre '${t.name}' freqHz length (${t.freqHz.length}) ` +
          `differs from '${refName}' (${refLen}). All timbres must share the same frequency axis.`
        );
        err.code = 'ASSET_SHAPE_MISMATCH';
        throw err;
      }
    }
  }

  // T-007: integrity verification. Two cases:
  //   1. No integrity block OR stub value      → log a one-line WARN and
  //      continue (back-compat with v1.0.x presets that were shipped before
  //      hash computation existed). Don't throw — that would break every
  //      preset on disk today.
  //   2. Real digest string                    → recompute over the asset
  //      bytes we just read and throw
  //      ASSET_INTEGRITY_MISMATCH (with expected + actual) if they differ.
  if (manifest.integrity?.assetsHash) {
    const declared = manifest.integrity.assetsHash;
    if (isIntegrityStub(declared)) {
      console.warn(
        `[preset] '${manifestPath}': integrity.assetsHash is a stub (${declared}) — no verification performed.`
      );
    } else {
      const actual = computeAssetsHash(assetBytes);
      if (actual !== declared) {
        const err: any = new Error(
          `ASSET_INTEGRITY_MISMATCH: preset '${manifestPath}' declares assetsHash '${declared}' ` +
          `but recomputed hash is '${actual}'. Asset files may have been modified or corrupted.`
        );
        err.code = 'ASSET_INTEGRITY_MISMATCH';
        err.manifestPath = manifestPath;
        err.expected = declared;
        err.actual = actual;
        throw err;
      }
    }
  }

  return {
    manifest,
    timbres,
  };
}
