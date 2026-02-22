# Vocal Synth Engine

A deterministic vocal instrument engine built in TypeScript. Renders singing voices from score data using additive synthesis, voice presets, and real-time WebSocket streaming. Play live via keyboard/MIDI, collaborate in multi-user jam sessions, or render scores to WAV.

## What It Does

- **Additive vocal synthesis** — harmonic partials + spectral envelope + noise residual
- **15 voice presets** — frozen analysis artifacts from Kokoro TTS voices + lab presets, each with multiple timbres
- **Polyphonic rendering** — configurable max polyphony with per-voice state management and voice stealing
- **Live mode** — play notes via keyboard or MIDI with real-time WebSocket audio streaming
- **Jam sessions** — multi-user collaborative sessions with host authority, participant attribution, and recording
- **Score input** — load a `VocalScore` into a track for automatic playback synced to transport
- **Recording & export** — capture live performances to an EventTape, export to WAV with full provenance
- **Lyrics & phonemes** — grapheme-to-phoneme pipeline with phoneme lane visualization
- **Cockpit UI** — browser-based SPA with piano roll editor, live keyboard, XY pad, render bank, and telemetry
- **Deterministic** — seeded RNG, reproducible output from the same inputs

## Architecture

```
                          ┌─── Cockpit UI (browser SPA) ───┐
                          │  Piano Roll  │  Live  │ Renders │
                          └──────────────┴────────┴─────────┘
                                     │        │
                              REST API    WebSocket
                                     │    /ws  /ws/jam
                          ┌──────────┴────────┴─────────────┐
                          │        Express Server            │
                          │  Render API │ Jam Sessions       │
                          └──────┬──────┴───────┬────────────┘
                                 │              │
                      StreamingVocalSynthEngine  │
                        LiveSynthEngine ─────────┘
                                 │
                    ┌────────────┼─────────────┐
              VoicePreset    DSP (FFT)    Curves (ADSR,
              (.f32 blobs)   Pitch Det.   vibrato, automation)
```

**Key directories:**

| Directory | Purpose |
|-----------|---------|
| `src/engine/` | Core synth — block renderer, streaming engine, ADSR/vibrato curves |
| `src/dsp/` | Signal processing — FFT, pitch detection |
| `src/preset/` | VoicePreset schema, loader, and resolver |
| `src/server/` | Express + WebSocket API server, jam session manager |
| `src/types/` | Shared types — scores, jam protocol, presets |
| `src/cli/` | CLI tools + integration test suites |
| `apps/cockpit/` | Browser cockpit UI (Vite + vanilla TS) |
| `presets/` | 15 bundled voice presets with binary timbre data |

## Quick Start

```bash
npm ci
npm run dev
```

The dev server starts at `http://localhost:4321`. The cockpit UI is served from the same port.

## Cockpit UI

The cockpit is a browser-based SPA with three tabs:

### Score Editor
- Piano roll with drag-to-create, move, and resize notes (C2-C6 range)
- Per-note controls: velocity, timbre, breathiness, vibrato, portamento
- Lyrics input with automatic phoneme generation
- Phoneme lane overlay synced to the piano roll
- Render to WAV with configurable preset, polyphony, seed, and BPM

### Live Mode
- 24-key chromatic keyboard (mouse + key bindings)
- MIDI device input with channel filtering
- XY pad for real-time timbre morphing (X) and breathiness (Y)
- Hold pedal, velocity/breathiness sliders, vibrato controls
- Metronome with quantize grid (1/4, 1/8, 1/16)
- Latency calibration (low/balanced/safe presets)
- Record performances and save to render bank
- Live telemetry: voices, peak dBFS, RTF, click risk, WS jitter

### Render Bank
- Browse, play, pin, rename, and delete saved renders
- Load a render's score back into the editor
- Side-by-side telemetry comparison between renders
- Provenance tracking: commit SHA, score hash, WAV hash

## Jam Sessions

Multi-user collaborative sessions over WebSocket (`/ws/jam`):

- **Host authority** — session creator controls transport, tracks, recording, and quantization
- **Guest participation** — guests can play notes on any track but cannot modify session state
- **Track ownership** — tracks belong to their creator; only owner or host can modify/remove
- **Participant attribution** — every note event in the EventTape records who played it
- **Score input mode** — load a `VocalScore` into a track for automatic playback synced to transport
- **Recording** — capture all participants' notes into an EventTape, export to WAV
- **Metronome** — shared metronome with configurable BPM and time signature

### Jam Protocol

Clients connect to `/ws/jam` and exchange JSON messages:

```
Client: jam_hello → Server: jam_hello_ack (participantId)
Client: session_create → Server: session_created (snapshot)
Client: session_join → Server: session_joined (snapshot)
Client: track_note_on/off → Server: track_note_ack
Client: record_start/stop → Server: record_status
Client: record_export → Server: record_exported (renderId)
Client: track_set_score → Server: score_status
```

## API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Server health, version, uptime |
| `/api/presets` | GET | No | List voice presets with timbres and metadata |
| `/api/phonemize` | POST | Yes | Convert lyrics text to phoneme events |
| `/api/render` | POST | Yes | Render a score to WAV |
| `/api/renders` | GET | Yes | List all saved renders |
| `/api/renders/:id/audio.wav` | GET | Yes | Download render WAV |
| `/api/renders/:id/score` | GET | Yes | Original score JSON |
| `/api/renders/:id/meta` | GET | Yes | Render metadata |
| `/api/renders/:id/telemetry` | GET | Yes | Render telemetry (peak, RTF, clicks) |
| `/api/renders/:id/provenance` | GET | Yes | Provenance (commit, hashes, config) |

Auth is optional — enabled when `AUTH_TOKEN` is set in the environment.

### WebSocket

| Path | Purpose |
|------|---------|
| `/ws` | Live mode — single-user note playback with audio streaming |
| `/ws/jam` | Jam sessions — multi-user collaboration with recording |

## Voice Presets

15 bundled presets with multi-timbre support:

| Preset | Voice | Timbres |
|--------|-------|---------|
| `default-voice` | Baseline female | Default timbre |
| `bright-lab` | Lab/experimental | Bright formant |
| `kokoro-af-*` | Aoede, Heart, Jessica, Sky | Multiple per voice |
| `kokoro-am-*` | Eric, Fenrir, Liam, Onyx | Multiple per voice |
| `kokoro-bf-*` | Alice, Emma, Isabella | Multiple per voice |
| `kokoro-bm-*` | George, Lewis | Multiple per voice |

Each preset includes binary `.f32` assets (harmonic magnitudes, spectral envelope, noise floor) and a JSON manifest describing pitch range, resonance, and vibrato defaults.

## Scripts

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## Tests

Integration tests run against a live dev server:

```bash
# Start the server first
npm run dev

# Then in another terminal:
npx tsx src/cli/test-jam-session.ts        # Jam session lifecycle (12 tests)
npx tsx src/cli/test-jam-recording.ts      # Recording & export (10 tests)
npx tsx src/cli/test-jam-collaboration.ts  # Collaboration & score input (12 tests)
npx tsx src/cli/test-score-render.ts       # Score rendering pipeline
npx tsx src/cli/test-consonants.ts         # Consonant phonemes
npx tsx src/cli/test-g2p.ts               # Grapheme-to-phoneme
npx tsx src/cli/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx src/cli/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx src/cli/test-noise-tail.ts         # Tail silence/noise
```

## License

MIT. See [LICENSE](LICENSE).
