---
title: Cockpit UI and Jam Sessions
description: Browser-based cockpit interface, three editing tabs, and multi-user jam session protocol.
sidebar:
  order: 3
---

The cockpit is a browser-based single-page application served alongside the API. It provides three tabs for composing, performing, and managing renders, plus support for multi-user jam sessions.

## Score Editor

The score editor is a piano roll interface for composing vocal scores.

- **Note creation** — Click and drag on the grid to create notes spanning C2 through C6
- **Note editing** — Move, resize, and delete notes with mouse interaction
- **Per-note controls** — Velocity, timbre, breathiness, vibrato depth, and portamento time
- **Lyrics input** — Type lyrics text and the engine runs grapheme-to-phoneme conversion automatically
- **Phoneme lane** — A synchronized overlay below the piano roll showing the phoneme timeline
- **Render controls** — Choose a preset, set polyphony limit, seed, and BPM, then render to WAV

## Live Mode

Live mode turns the cockpit into a real-time instrument.

- **24-key chromatic keyboard** — Play with mouse clicks or mapped keyboard shortcuts
- **MIDI input** — Connect a MIDI device with optional channel filtering
- **XY pad** — X axis controls timbre morphing, Y axis controls breathiness, updated in real time
- **Hold pedal** — Sustains notes beyond key release
- **Velocity and breathiness sliders** — Set default values for keyboard input
- **Vibrato controls** — Rate, depth, and onset delay
- **Metronome** — Configurable BPM with quantize grid options (1/4, 1/8, 1/16)
- **Latency calibration** — Low, balanced, and safe presets to match your audio setup
- **Recording** — Capture a performance and save it to the render bank
- **Live telemetry** — Active voices, peak dBFS, real-time factor, click risk, WebSocket jitter

## Render Bank

The render bank stores and manages all rendered audio.

- **Playback** — Play any saved render directly in the browser
- **Pin and rename** — Mark important renders and give them descriptive names
- **Load score** — Send a render's original score back into the editor for further editing
- **Telemetry comparison** — Side-by-side view of peak levels, real-time factor, and click counts between two renders
- **Provenance** — Each render tracks its commit SHA, score hash, WAV hash, and engine configuration

## Jam Sessions

Jam sessions enable multi-user collaboration over WebSocket at the `/ws/jam` endpoint.

### Roles

| Role | Capabilities |
|------|-------------|
| **Host** | Creates the session. Controls transport, tracks, recording, quantization, BPM, and time signature. |
| **Guest** | Joins an existing session. Can play notes on any track but cannot modify session state. |

### Track ownership

Tracks belong to the participant who created them. Only the track owner or the session host can modify or remove a track.

### Recording

The host can start and stop recording. All participants' note events are captured into an EventTape with full participant attribution. The recording can be exported to WAV.

### Score input mode

A `VocalScore` can be loaded into a track for automatic playback synced to the session transport. This lets participants mix live performance with pre-composed parts.

### Protocol overview

Clients connect to `/ws/jam` and exchange JSON messages:

| Client sends | Server responds | Purpose |
|-------------|----------------|---------|
| `jam_hello` | `jam_hello_ack` | Handshake, receive participant ID |
| `session_create` | `session_created` | Create a new session, receive snapshot |
| `session_join` | `session_joined` | Join existing session, receive snapshot |
| `track_note_on` | `track_note_ack` | Play a note on a track |
| `track_note_off` | `track_note_ack` | Release a note on a track |
| `record_start` | `record_status` | Begin recording (host only) |
| `record_stop` | `record_status` | Stop recording (host only) |
| `record_export` | `record_exported` | Export recording to WAV, receive render ID |
| `track_set_score` | `score_status` | Load a score into a track |

### Shared metronome

The session metronome is controlled by the host. BPM and time signature changes are broadcast to all participants for synchronized playback.
