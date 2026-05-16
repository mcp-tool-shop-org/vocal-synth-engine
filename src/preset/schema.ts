import { z } from 'zod';
import { isAbsolute } from 'node:path';

/**
 * Asset paths inside a voice-preset manifest must be RELATIVE to the manifest
 * directory and may not contain parent-directory segments. Defense-in-depth:
 * loader.ts also resolves and bounds-checks each path against the manifest
 * directory, but rejecting the obvious cases at parse time gives a clearer
 * error message and a smaller attack surface.
 */
const RelativeAssetPath = z.string().refine(
  (p) => p.length > 0 && !isAbsolute(p) && !p.split(/[\\/]/).some((seg) => seg === '..'),
  { message: "asset path must be relative and may not contain '..' segments" }
);

export const VoicePresetSchema = z.object({
  schema: z.literal('mcp-voice-engine.voicepreset'),
  version: z.string(),
  id: z.string(),
  sampleRateHz: z.number(),
  analysis: z.object({
    frameMs: z.number(),
    hopMs: z.number(),
    f0Method: z.string(),
    maxHarmonics: z.number(),
    envelope: z.object({
      method: z.string(),
      lifterQ: z.number().optional(),
    }),
    noise: z.object({
      method: z.string(),
      fftSize: z.number(),
    }),
  }),
  timbres: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      assets: z.object({
        harmonicsMag: RelativeAssetPath,
        envelopeDb: RelativeAssetPath,
        noiseDb: RelativeAssetPath,
        freqHz: RelativeAssetPath,
      }),
      defaults: z.object({
        hnrDb: z.number(),
        breathiness: z.number(),
        vibrato: z.object({
          rateHz: z.number(),
          depthCents: z.number(),
          onsetMs: z.number(),
        }),
      }),
    })
  ),
  integrity: z.object({
    assetsHash: z.string(),
    analysisHash: z.string(),
  }).optional(),
});

export type VoicePresetManifest = z.infer<typeof VoicePresetSchema>;

export interface LoadedTimbre {
  name: string;
  kind: string;
  harmonicsMag: Float32Array;
  envelopeDb: Float32Array;
  noiseDb: Float32Array;
  freqHz: Float32Array;
  defaults: VoicePresetManifest['timbres'][0]['defaults'];
}

export interface LoadedVoicePreset {
  manifest: VoicePresetManifest;
  timbres: Record<string, LoadedTimbre>;
}
