---
title: Voice Presets
description: Voice preset catalog, timbre binary format, manifest schema, and how to inspect presets.
sidebar:
  order: 4
---

Vocal Synth Engine ships with 15 voice presets. Each preset is a frozen analysis artifact containing the spectral characteristics of a singing voice.

## Preset catalog

| Preset | Voice | Timbres |
|--------|-------|---------|
| `default-voice` | Baseline female | Default timbre |
| `bright-lab` | Lab/experimental | Bright formant |
| `kokoro-af-aoede` | Aoede (female) | Multiple timbres |
| `kokoro-af-heart` | Heart (female) | Multiple timbres |
| `kokoro-af-jessica` | Jessica (female) | Multiple timbres |
| `kokoro-af-sky` | Sky (female) | Multiple timbres |
| `kokoro-am-eric` | Eric (male) | Multiple timbres |
| `kokoro-am-fenrir` | Fenrir (male) | Multiple timbres |
| `kokoro-am-liam` | Liam (male) | Multiple timbres |
| `kokoro-am-onyx` | Onyx (male) | Multiple timbres |
| `kokoro-bf-alice` | Alice (British female) | Multiple timbres |
| `kokoro-bf-emma` | Emma (British female) | Multiple timbres |
| `kokoro-bf-isabella` | Isabella (British female) | Multiple timbres |
| `kokoro-bm-george` | George (British male) | Multiple timbres |
| `kokoro-bm-lewis` | Lewis (British male) | Multiple timbres |

## Binary timbre format

Each timbre is stored as a set of `.f32` binary files containing 32-bit floating-point arrays:

- **Harmonic magnitudes** — Amplitude values for each harmonic partial across the pitch range
- **Spectral envelope** — Formant shape curve used to weight harmonic amplitudes
- **Noise floor** — Broadband noise spectrum for breathiness and consonant texture

These files are loaded at startup and held in memory for zero-latency access during synthesis.

## Manifest schema

Each preset directory contains a JSON manifest file describing the voice characteristics:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable preset name |
| `id` | string | Unique preset identifier (used in API calls) |
| `pitch_range` | `[min, max]` | Supported pitch range in MIDI note numbers |
| `resonance` | object | Formant resonance parameters |
| `vibrato_defaults` | object | Default vibrato rate, depth, and onset delay |
| `timbres` | array | List of available timbres with their binary asset paths |

## Inspecting presets

Use the built-in CLI inspector to examine preset data:

```bash
npm run inspect
```

This prints a table of all loaded presets with their timbre counts, pitch ranges, and file sizes.

You can also query presets through the REST API:

```bash
curl http://localhost:4321/api/presets
```

The response includes full metadata for every preset, including timbre names and parameter ranges.

## Using presets in renders

When rendering a score (via the cockpit UI or the REST API), specify the preset by its `id`:

```json
{
  "preset": "kokoro-af-heart",
  "score": { ... },
  "polyphony": 8,
  "seed": 42
}
```

The engine resolves the preset, loads its binary timbre data, and uses it for the entire render. Changing the preset produces a different voice while keeping the same score and timing.

## Multi-timbre usage

Presets with multiple timbres support real-time timbre morphing via the XY pad in live mode. The X axis interpolates between timbres, blending their spectral characteristics smoothly. In score mode, per-note timbre values select or blend between available timbres.
