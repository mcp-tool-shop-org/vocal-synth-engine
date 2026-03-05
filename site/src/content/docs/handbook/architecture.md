---
title: Architecture
description: Engine architecture, additive synthesis design, directory layout, and signal pipeline.
sidebar:
  order: 2
---

Vocal Synth Engine is structured around a core synthesis pipeline with REST and WebSocket interfaces, wrapped by a browser-based cockpit UI.

## System overview

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

## Additive synthesis design

The engine generates singing voices by combining three signal components:

1. **Harmonic partials** — A bank of sine oscillators at integer multiples of the fundamental frequency. Each partial has its own amplitude envelope derived from the voice preset.
2. **Spectral envelope** — A smooth curve that shapes the relative amplitudes of the harmonics, encoding formant structure (vowel identity).
3. **Noise residual** — Broadband noise filtered through the spectral envelope, adding breathiness and consonant-like texture.

These three components are summed per sample block to produce the final audio signal. The engine processes audio in fixed-size blocks for consistent real-time performance.

## Signal flow

For each audio block:

1. **Note scheduling** resolves which notes are active based on transport position or live input
2. **Voice allocation** assigns notes to polyphonic voice slots, using voice stealing when the limit is exceeded
3. **Per-voice rendering** computes ADSR envelope, vibrato LFO, pitch curve (portamento), and the three synthesis components
4. **Mixing** sums all active voices into the output buffer
5. **Streaming** sends the buffer over WebSocket (live mode) or appends to the WAV accumulator (offline render)

## Curves and modulation

- **ADSR** — Attack, decay, sustain, release envelope applied to each note
- **Vibrato** — Sinusoidal pitch modulation with configurable rate, depth, and onset delay
- **Portamento** — Smooth pitch glide between consecutive notes
- **Automation** — Per-note parameter curves (timbre, breathiness) interpolated per block

## Directory layout

| Directory | Purpose |
|-----------|---------|
| `src/engine/` | Core synth: block renderer, streaming engine, ADSR, vibrato curves |
| `src/dsp/` | Signal processing: FFT, pitch detection |
| `src/preset/` | VoicePreset schema, loader, and resolver |
| `src/server/` | Express + WebSocket API server, jam session manager |
| `src/types/` | Shared TypeScript types: scores, jam protocol, presets |
| `src/cli/` | CLI tools and integration test suites |
| `apps/cockpit/` | Browser cockpit UI (Vite + vanilla TS) |
| `presets/` | 15 bundled voice presets with binary timbre data |

## Determinism

The engine uses a seeded pseudo-random number generator for any stochastic elements (noise generation, jitter). Given the same seed, score, and preset, the engine produces bit-identical output. Renders include provenance metadata: commit SHA, score hash, WAV hash, and full configuration.
