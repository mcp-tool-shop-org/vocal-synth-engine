---
title: Welcome
description: Vocal Synth Engine handbook — deterministic vocal instrument engine with additive synthesis, voice presets, and real-time collaboration.
sidebar:
  order: 0
---

Welcome to the **Vocal Synth Engine** handbook. This guide covers everything you need to know to synthesize singing voices, play live, and collaborate with others.

## What is Vocal Synth Engine?

Vocal Synth Engine is a deterministic vocal instrument engine built in TypeScript. It renders singing voices from score data using additive synthesis, voice presets, and real-time WebSocket streaming. You can play live via keyboard or MIDI, collaborate in multi-user jam sessions, or render scores to WAV.

## Key capabilities

- **Additive vocal synthesis** with harmonic partials, spectral envelopes, and noise residual
- **15 voice presets** from Kokoro TTS analysis artifacts and lab experiments
- **Polyphonic rendering** with configurable max polyphony and voice stealing
- **Live mode** with keyboard, MIDI, and real-time WebSocket audio streaming
- **Multi-user jam sessions** with host authority, track ownership, and recording
- **Score input** for automatic playback synced to transport
- **Recording and export** to WAV with full provenance tracking
- **Lyrics and phonemes** via grapheme-to-phoneme pipeline
- **Cockpit UI** with piano roll editor, live keyboard, XY pad, and render bank
- **Deterministic output** using seeded RNG for reproducible renders

## Handbook contents

| Page | Covers |
|------|--------|
| [Getting Started](/vocal-synth-engine/handbook/getting-started/) | Installation, dev server, first render |
| [Architecture](/vocal-synth-engine/handbook/architecture/) | Engine design, directory layout, synthesis pipeline |
| [Cockpit and Jams](/vocal-synth-engine/handbook/cockpit-and-jams/) | Cockpit UI tabs, jam session protocol |
| [Voice Presets](/vocal-synth-engine/handbook/voice-presets/) | Preset catalog, timbre data, manifest format |
| [API Reference](/vocal-synth-engine/handbook/reference/) | REST endpoints, WebSocket paths, auth |
