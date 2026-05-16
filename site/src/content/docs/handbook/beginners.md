---
title: Beginners Guide
description: Core concepts, your first vocal score, and answers to common questions for newcomers to Vocal Synth Engine.
sidebar:
  order: 99
---

New to vocal synthesis? This page walks through the fundamentals of Vocal Synth Engine, from core concepts to rendering your first singing voice.

## What is Vocal Synth Engine?

Vocal Synth Engine is a TypeScript-based tool that generates singing voices from structured data. Instead of recording a singer, you describe notes, timing, and expression in JSON, and the engine produces a WAV audio file of a synthetic voice performing your composition. It runs as a local server with a browser-based interface for composing, live performance, and multi-user collaboration.

## Who is this for?

- **Game developers** who need procedural or dynamic vocal audio without hiring voice talent
- **Music producers** experimenting with synthetic vocal textures and additive synthesis
- **Creative coders** building interactive audio experiences with WebSocket-based real-time streaming
- **Researchers** exploring vocal synthesis, formant modeling, or phoneme-driven timbre control
- **Hobbyists** curious about how singing voices can be constructed from harmonic partials and spectral data

No prior audio programming experience is required, but basic comfort with a terminal and JSON will help.

## Prerequisites

Before you begin, make sure you have:

- **Node.js 18 or later** -- check with `node --version`
- **npm** (bundled with Node.js)
- **A modern browser** (Chrome, Firefox, or Edge) for the cockpit UI
- **Basic terminal skills** -- you will run commands like `npm ci` and `npm run dev`
- **A text editor** if you want to write score JSON by hand (VS Code, Sublime, etc.)

Optional but helpful:

- **A MIDI controller** for live mode (any USB MIDI keyboard works)
- **curl** for testing the REST API from the command line

## What is vocal synthesis?

Vocal synthesis generates singing voices from structured data rather than recorded audio. Vocal Synth Engine uses **additive synthesis** -- it builds sound by stacking sine waves (harmonics) at integer multiples of a fundamental pitch. A spectral envelope shapes the relative loudness of each harmonic, encoding the formant structure that makes an "ah" sound different from an "ee." A noise component adds breathiness and consonant texture.

The result is a controllable singing voice that responds to pitch, timing, timbre, and expression parameters in real time.

## Key terminology

| Term | Meaning |
|------|---------|
| **VocalScore** | A JSON object containing BPM, notes, optional lyrics, and automation lanes. This is the input to the render pipeline. |
| **VocalNote** | A single note in a score: MIDI pitch, start time, duration, velocity, and optional vibrato/portamento/timbre. |
| **Voice preset** | A frozen analysis artifact containing harmonic magnitudes, spectral envelope, and noise floor data. Each preset represents a different singing voice. |
| **Timbre** | A sub-voice within a preset. Many presets have three timbres (AH, EE, OO) representing different vowel shapes. The engine blends between them. |
| **Phoneme** | A unit of speech sound (ARPAbet notation). The engine maps lyrics text to phonemes, which drive timbre selection and consonant synthesis. |
| **Block size** | The number of audio samples processed at once. Smaller blocks reduce latency; larger blocks improve throughput. |
| **Polyphony** | The maximum number of simultaneous notes. When exceeded, the engine steals the oldest voice. |

## Your first five minutes

Start by cloning the repository, installing dependencies, and starting the dev server:

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
npm run dev
```

The server starts at `http://localhost:4321`. Open this URL in your browser to see the cockpit UI.

The fastest path to hearing a voice is through the cockpit: click and drag on the piano roll to create a note, choose a preset, and click Render. But you can also skip the UI entirely and render from the command line using a JSON score.

### Writing a score by hand

You do not need the cockpit UI to render audio. A VocalScore is plain JSON:

```json
{
  "bpm": 100,
  "notes": [
    { "id": "n1", "startSec": 0.0, "durationSec": 0.8, "midi": 60, "velocity": 0.9 },
    { "id": "n2", "startSec": 1.0, "durationSec": 0.8, "midi": 64, "velocity": 0.85 },
    { "id": "n3", "startSec": 2.0, "durationSec": 1.2, "midi": 67, "velocity": 0.9 }
  ]
}
```

This creates three notes -- C4, E4, G4 -- forming a simple C major arpeggio. MIDI note 60 is middle C. Velocity ranges from 0 (silent) to 1 (full volume).

To render it, POST the score and a config object to the render API:

```bash
curl -X POST http://localhost:4321/api/render \
  -H "Content-Type: application/json" \
  -d '{
    "score": {
      "bpm": 100,
      "notes": [
        { "id": "n1", "startSec": 0, "durationSec": 0.8, "midi": 60, "velocity": 0.9 },
        { "id": "n2", "startSec": 1, "durationSec": 0.8, "midi": 64, "velocity": 0.85 },
        { "id": "n3", "startSec": 2, "durationSec": 1.2, "midi": 67, "velocity": 0.9 }
      ]
    },
    "config": {
      "presetPath": "presets/default-voice",
      "sampleRateHz": 48000,
      "blockSize": 2048,
      "maxPolyphony": 4,
      "rngSeed": 42,
      "defaultTimbre": "default",
      "deterministic": "exact"
    }
  }'
```

The response includes an `audioUrl` field. Fetch it to download the WAV.

## Understanding voice presets

Voice presets are the "singer" in the engine. Each preset directory under `presets/` contains a `manifest.json` and binary `.f32` files holding the spectral data.

Preset names follow a naming convention:

- **`default-voice`** -- a baseline female voice for testing
- **`bright-lab`** -- an experimental lab-created voice with bright formants
- **`kokoro-af-*`** -- American female voices (Aoede, Heart, Jessica, Sky)
- **`kokoro-am-*`** -- American male voices (Eric, Fenrir, Liam, Onyx)
- **`kokoro-bf-*`** -- British female voices (Alice, Emma, Isabella)
- **`kokoro-bm-*`** -- British male voices (George, Lewis)

Most Kokoro presets ship with three timbres named AH, EE, and OO, corresponding to open, front, and rounded vowel shapes. The engine blends between them based on phoneme data or the XY pad in live mode.

To list all available presets and their timbres:

```bash
curl http://localhost:4321/api/presets
```

## Adding lyrics and phonemes

Lyrics add vowel-aware timbre blending and consonant synthesis to a render. Add a `lyrics` field to your score:

```json
{
  "bpm": 100,
  "notes": [
    { "id": "n1", "startSec": 0, "durationSec": 1.5, "midi": 60, "velocity": 0.9 }
  ],
  "lyrics": {
    "text": "hello",
    "language": "en-US"
  }
}
```

The engine runs a grapheme-to-phoneme pipeline: it looks up words in the CMU Pronouncing Dictionary first, then falls back to letter-based rules for unknown words. Vowel phonemes drive timbre blending (AH/EE/OO weights), and consonant phonemes trigger noise bursts shaped by profiles for fricatives, plosives, and nasals.

You can also call the phonemize endpoint directly to preview the conversion:

```bash
curl -X POST http://localhost:4321/api/phonemize \
  -H "Content-Type: application/json" \
  -d '{"text": "hello world"}'
```

## Live mode and jam sessions

Beyond offline rendering, the engine supports two real-time modes:

**Live mode** (`/ws` WebSocket) lets a single user play notes in real time. The cockpit's Live tab provides a chromatic keyboard, MIDI input, an XY pad for timbre morphing, and recording. Audio streams back over the WebSocket as PCM blocks.

**Jam sessions** (`/ws/jam` WebSocket) support multiple users collaborating. One person creates a session as host, others join as guests. The host controls transport (play, stop, BPM), recording, and quantization. Guests can play notes on any track. All events are captured in an EventTape with participant attribution and can be exported to WAV.

To try live mode, start the dev server and open the cockpit in your browser. Switch to the Live tab and play notes with your keyboard or mouse.

## Common mistakes

**Server will not start** -- Make sure you have Node.js 18 or later. Run `node --version` to check. Delete `node_modules` and run `npm ci` again if dependencies look corrupted.

**No sound from live mode** -- Verify the WebSocket connection in your browser's dev tools (Network tab, filter by WS). The `/ws` endpoint must show a connected state. Check that transport is set to "play" -- notes are silent when transport is stopped.

**Render returns 404 for preset** -- The preset path in config must match a directory under `presets/`. Use the `/api/presets` endpoint to list valid preset IDs.

**Render returns 429** -- You have exceeded the rate limit (20 requests per minute by default). Wait and retry, or increase the limit with the `RATE_LIMIT_RPM` environment variable.

**Voice stealing clicks** -- When polyphony is exceeded, the engine steals the oldest voice with a 10ms crossfade. Increase `maxPolyphony` in your config or reduce the number of overlapping notes.

**Different output on re-render** -- Make sure `deterministic` is set to `"exact"` and the `rngSeed` value is the same. The engine is fully deterministic when both are consistent.

## Next steps

Once you have rendered your first score, explore these handbook pages to go deeper:

- [Getting Started](/vocal-synth-engine/handbook/getting-started/) -- install instructions, dev server setup, environment variables
- [Architecture](/vocal-synth-engine/handbook/architecture/) -- how the synthesis pipeline works, directory layout, signal flow
- [Voice Presets](/vocal-synth-engine/handbook/voice-presets/) -- browse the 15 bundled presets, understand timbre data, inspect preset manifests
- [Cockpit UI and Jam Sessions](/vocal-synth-engine/handbook/cockpit-and-jams/) -- use the piano roll editor, play live, collaborate in multi-user sessions
- [API Reference](/vocal-synth-engine/handbook/reference/) -- REST endpoints, WebSocket protocol, authentication, error handling

## Glossary

| Term | Definition |
|------|-----------|
| **Additive synthesis** | Building sound by summing sine waves (harmonics) at integer multiples of a fundamental frequency. |
| **ADSR / ASR** | Envelope shape controlling amplitude over time. This engine uses Attack-Sustain-Release (no separate decay phase). |
| **ARPAbet** | A phonetic notation system used by the CMU Pronouncing Dictionary. Phonemes like AH, IY, and K represent speech sounds. |
| **Block size** | The number of audio samples processed per rendering step. Smaller blocks mean lower latency; larger blocks mean better throughput. |
| **BPM** | Beats per minute -- the tempo of a score or jam session. |
| **Breathiness** | The amount of noise mixed into the voice signal, controlled per note or via automation lanes. |
| **Deterministic** | Given the same inputs (score, preset, seed), the engine produces identical output every time. |
| **EventTape** | A recording of all note events during a jam session, with timestamps and participant attribution. |
| **Formant** | A resonant frequency of the vocal tract that shapes vowel identity. The spectral envelope encodes formant structure. |
| **G2P (grapheme-to-phoneme)** | Converting written text (like "hello") into phoneme sequences (like HH-AH-L-OW). |
| **Harmonic** | A sine wave at an integer multiple of the fundamental frequency. The first harmonic is the fundamental itself. |
| **MIDI note number** | A standard pitch identifier where 60 = middle C, 69 = A4 (440 Hz). |
| **Polyphony** | The number of notes that can sound simultaneously. When exceeded, the engine steals the oldest voice. |
| **Preset** | A frozen analysis artifact containing spectral data for a specific singing voice. |
| **RNG seed** | A number that initializes the random number generator, ensuring reproducible noise patterns across renders. |
| **Spectral envelope** | A smooth curve describing the relative amplitude of harmonics, encoding vowel identity and voice character. |
| **Timbre** | A sub-voice within a preset (e.g., AH, EE, OO) representing a vowel shape. The engine blends between timbres. |
| **VocalScore** | The JSON input format describing notes, lyrics, tempo, and automation for a render. |
| **Voice stealing** | When polyphony is exceeded, the engine recycles the oldest active voice with a short crossfade to avoid clicks. |
| **WebSocket** | A persistent bidirectional connection used for real-time audio streaming and jam session communication. |
