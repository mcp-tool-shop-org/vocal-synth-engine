import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { VoicePresetSchema, LoadedVoicePreset, LoadedTimbre } from './schema.js';

export async function loadVoicePreset(manifestPath: string): Promise<LoadedVoicePreset> {
  const manifestDir = dirname(manifestPath);
  const manifestContent = await readFile(manifestPath, 'utf-8');
  const manifestJson = JSON.parse(manifestContent);
  
  const manifest = VoicePresetSchema.parse(manifestJson);
  
  const timbres: Record<string, LoadedTimbre> = {};
  
  for (const timbre of manifest.timbres) {
    const loadF32 = async (relPath: string) => {
      const fullPath = join(manifestDir, relPath);
      const buffer = await readFile(fullPath);
      // Ensure little-endian float32
      return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
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

  return {
    manifest,
    timbres,
  };
}
