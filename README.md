# Vocal Synth Engine

A deterministic vocal instrument engine built in TypeScript. Renders singing voices from score data using additive synthesis, voice presets, and real-time WebSocket streaming.

Built as the synthesis backend for [AI Jam Sessions](https://github.com/mcp-tool-shop-org/ai-jam-sessions).

## What It Does

- **Additive vocal synthesis** — harmonic partials + spectral envelope + noise residual
- **Voice presets** — frozen analysis artifacts (`.f32` blobs) describing timbre, breathiness, vibrato
- **Polyphonic rendering** — configurable max polyphony with per-voice state management
- **Streaming output** — block-based renderer feeds a WebSocket server for real-time playback
- **Score-driven** — takes JSON scores with MIDI note numbers, durations, and timbre automation
- **Deterministic** — seeded RNG, exact or fast mode, reproducible output from the same inputs

## Architecture

```
Score (JSON) ──> StreamingVocalSynthEngine ──> PCM blocks ──> WebSocket/WAV
                        │
                  VoicePreset (.f32)
                  DSP (FFT, pitch)
                  Curves (ADSR, vibrato, automation)
```

**Key modules:**

| Directory | Purpose |
|-----------|---------|
| `src/engine/` | Core synth engine — block renderer, streaming engine, ADSR/vibrato curves |
| `src/dsp/` | Signal processing — FFT, pitch detection |
| `src/preset/` | VoicePreset schema and loader |
| `src/server/` | Express + WebSocket API server |
| `src/cli/` | Preset inspector CLI |
| `apps/cockpit/` | Browser-based cockpit UI |
| `presets/` | Bundled voice preset data |

## Quick Start

```bash
npm ci
npm run dev
```

This starts the dev server with hot reload. The cockpit UI is available at `http://localhost:3000`.

### Render a score

```bash
# Inspect a voice preset
npm run inspect presets/voicepreset.json

# Build for production
npm run build
npm run start
```

### API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/health` | No | Health check |
| `GET /api/presets` | No | List available voice presets |
| `POST /api/render` | Yes | Render a score to audio |
| `GET /api/renders` | Yes | List past renders |

Auth is optional — enabled when `AUTH_TOKEN` is set in the environment.

## VoicePreset Format

A preset is a `voicepreset.json` manifest plus binary `.f32` assets:

- **harmonicsMag** — linear magnitude per harmonic partial
- **envelopeDb** — spectral envelope in dB over frequency
- **noiseDb** — noise floor in dB over frequency
- **freq_axis_hz** — shared frequency axis

Presets are deterministic, composable, and backend-agnostic. See `src/preset/schema.ts` for the full type definition.

## License

MIT. See [LICENSE](LICENSE).
