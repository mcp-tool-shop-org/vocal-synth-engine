import { z } from 'zod';

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
        harmonicsMag: z.string(),
        envelopeDb: z.string(),
        noiseDb: z.string(),
        freqHz: z.string(),
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
