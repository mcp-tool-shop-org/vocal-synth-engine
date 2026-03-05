---
title: Getting Started
description: Install Vocal Synth Engine, start the dev server, and render your first singing voice.
sidebar:
  order: 1
---

Get up and running with Vocal Synth Engine in under two minutes.

## Prerequisites

- **Node.js** 18 or later
- **npm** (bundled with Node.js)
- A modern browser (Chrome, Firefox, Edge) for the cockpit UI

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/mcp-tool-shop-org/vocal-synth-engine.git
cd vocal-synth-engine
npm ci
```

## Start the dev server

```bash
npm run dev
```

The server starts at `http://localhost:4321`. The cockpit UI is served from the same port — open it in your browser to start playing.

## Production build

```bash
npm run build
npm start
```

This compiles the cockpit UI and server, then starts the production server.

## Available scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Build cockpit and server |
| `npm start` | Production server |
| `npm run inspect` | CLI preset inspector |

## Your first render

1. Open `http://localhost:4321` in your browser
2. The **Score Editor** tab opens by default
3. Click and drag on the piano roll to create notes (C2 through C6)
4. Choose a voice preset from the dropdown
5. Click **Render** to generate a WAV file
6. The render appears in the **Render Bank** tab for playback

## Live mode quick start

1. Switch to the **Live** tab in the cockpit
2. Play notes using the on-screen chromatic keyboard or your computer keyboard
3. Connect a MIDI device for hardware control
4. Use the XY pad to morph timbre (X axis) and breathiness (Y axis) in real time

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | _(unset)_ | Optional token to protect API endpoints |
| `PORT` | `4321` | Server port |

When `AUTH_TOKEN` is not set, all API endpoints are open. Set it to require bearer token authentication on protected routes.
