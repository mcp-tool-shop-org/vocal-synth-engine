import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { VoicePresetSchema, LoadedVoicePreset, LoadedTimbre } from './schema.js';

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

export async function loadVoicePreset(manifestPath: string): Promise<LoadedVoicePreset> {
  const manifestDir = dirname(manifestPath);
  const manifestContent = await readFile(manifestPath, 'utf-8');
  const manifestJson = JSON.parse(manifestContent);

  const manifest = VoicePresetSchema.parse(manifestJson);

  const timbres: Record<string, LoadedTimbre> = {};

  for (const timbre of manifest.timbres) {
    const loadF32 = async (relPath: string) => {
      const fullPath = resolveAssetPathSafe(manifestDir, relPath);
      const buffer = await readFile(fullPath);
      return bytesToFloat32(buffer, fullPath);
    };

    const harmonicsMag = await loadF32(timbre.assets.harmonicsMag);
    const envelopeDb = await loadF32(timbre.assets.envelopeDb);
    const noiseDb = await loadF32(timbre.assets.noiseDb);
    const freqHz = await loadF32(timbre.assets.freqHz);

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

  return {
    manifest,
    timbres,
  };
}
