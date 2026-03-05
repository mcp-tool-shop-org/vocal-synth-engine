---
title: API Reference
description: Complete REST API endpoints, WebSocket paths, authentication, and response formats.
sidebar:
  order: 5
---

Vocal Synth Engine exposes a REST API and two WebSocket endpoints. All endpoints are served from the same Express server.

## Authentication

Authentication is **optional**. When the `AUTH_TOKEN` environment variable is set, protected endpoints require a bearer token:

```
Authorization: Bearer <your-token>
```

Endpoints marked "Auth: Yes" in the table below are protected when `AUTH_TOKEN` is configured. When unset, all endpoints are open.

## REST endpoints

### Health

| | |
|---|---|
| **Path** | `/api/health` |
| **Method** | `GET` |
| **Auth** | No |
| **Description** | Server health, version string, and uptime in seconds. |

### List presets

| | |
|---|---|
| **Path** | `/api/presets` |
| **Method** | `GET` |
| **Auth** | No |
| **Description** | Returns all voice presets with timbres, pitch ranges, and metadata. |

### Phonemize

| | |
|---|---|
| **Path** | `/api/phonemize` |
| **Method** | `POST` |
| **Auth** | Yes |
| **Description** | Convert lyrics text to a sequence of phoneme events. |

**Request body:**

```json
{
  "text": "hello world"
}
```

### Render

| | |
|---|---|
| **Path** | `/api/render` |
| **Method** | `POST` |
| **Auth** | Yes |
| **Description** | Render a VocalScore to WAV. Returns a render ID for retrieving the result. |

**Request body:**

```json
{
  "preset": "kokoro-af-heart",
  "score": { ... },
  "polyphony": 8,
  "seed": 42,
  "bpm": 120
}
```

### List renders

| | |
|---|---|
| **Path** | `/api/renders` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | List all saved renders with metadata. |

### Render audio

| | |
|---|---|
| **Path** | `/api/renders/:id/audio.wav` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | Download the rendered WAV file. |

### Render score

| | |
|---|---|
| **Path** | `/api/renders/:id/score` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | Retrieve the original score JSON used for this render. |

### Render metadata

| | |
|---|---|
| **Path** | `/api/renders/:id/meta` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | Render metadata including preset, polyphony, seed, and timing. |

### Render telemetry

| | |
|---|---|
| **Path** | `/api/renders/:id/telemetry` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | Performance telemetry: peak dBFS, real-time factor, click count. |

### Render provenance

| | |
|---|---|
| **Path** | `/api/renders/:id/provenance` |
| **Method** | `GET` |
| **Auth** | Yes |
| **Description** | Provenance data: commit SHA, score hash, WAV hash, engine config. |

## WebSocket endpoints

### Live mode

| | |
|---|---|
| **Path** | `/ws` |
| **Purpose** | Single-user note playback with real-time audio streaming. |

The live WebSocket accepts note-on and note-off messages and streams PCM audio blocks back to the client. The cockpit UI's Live tab uses this endpoint.

### Jam sessions

| | |
|---|---|
| **Path** | `/ws/jam` |
| **Purpose** | Multi-user collaborative sessions with recording. |

The jam WebSocket uses a structured JSON protocol. See the [Cockpit and Jams](/vocal-synth-engine/handbook/cockpit-and-jams/) page for the full protocol table and session lifecycle.

## Error responses

All API errors return a JSON object:

```json
{
  "code": "RENDER_FAILED",
  "message": "Polyphony limit exceeded",
  "hint": "Reduce the number of simultaneous notes or increase the polyphony setting"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Machine-readable error code |
| `message` | string | Human-readable description |
| `hint` | string | Suggested fix or next step |

HTTP status codes follow standard conventions: 400 for bad requests, 401 for missing/invalid auth, 404 for not found, 500 for server errors.
