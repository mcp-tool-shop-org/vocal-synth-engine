# Vocal Synth Engine

A deterministic, playable vocal instrument designed for AI jam sessions.

## VoicePreset v0.1

The `VoicePreset` is a frozen model artifact that contains the analysis data needed to synthesize a voice. It is designed to be deterministic, composable, and backend-agnostic.

### Structure

A preset consists of a `voicepreset.json` manifest and several binary `.f32` assets.

#### Manifest (`voicepreset.json`)

```json
{
  "schema": "mcp-voice-engine.voicepreset",
  "version": "0.1.0",
  "id": "vp_human_female_001",
  "sampleRateHz": 48000,
  "analysis": {
    "frameMs": 20,
    "hopMs": 10,
    "f0Method": "yin",
    "maxHarmonics": 80,
    "envelope": { "method": "cepstral_lifter", "lifterQ": 30 },
    "noise": { "method": "residual_stft", "fftSize": 2048 }
  },
  "timbres": [
    {
      "name": "AH",
      "kind": "vowel",
      "assets": {
        "harmonicsMag": "assets/AH_harmonics_mag.f32",
        "envelopeDb": "assets/AH_envelope_db.f32",
        "noiseDb": "assets/AH_noise_db.f32",
        "freqHz": "assets/freq_axis_hz.f32"
      },
      "defaults": {
        "hnrDb": 18,
        "breathiness": 0.12,
        "vibrato": { "rateHz": 5.8, "depthCents": 35, "onsetMs": 220 }
      }
    }
  ]
}
```

#### Binary Assets

Assets are stored as little-endian `Float32Array` blobs:

- `harmonicsMag.f32`: Length `H`, linear magnitude. Indexed by harmonic number.
- `envelopeDb.f32`: Length `M`, dB over frequency axis.
- `noiseDb.f32`: Length `M`, dB over frequency axis.
- `freq_axis_hz.f32`: Length `M`, shared frequency axis.

### Tools

#### `preset:inspect`

Inspects a `VoicePreset` and prints its metadata, bounds, and a simulated telemetry report for a 1-second sustained note.

```bash
npm run inspect <path-to-voicepreset.json>
```

Example:

```bash
npm run inspect test-preset/voicepreset.json
```
