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

Tokens can be supplied two ways:

- **Header**: `Authorization: Bearer <your-token>`
- **Query parameter**: `?token=<your-token>` (useful for `<audio>` src URLs where headers cannot be set)

### Rate limiting

The render endpoint (`/api/render`) enforces a per-IP rate limit. Defaults to 20 requests per minute. Override with the `RATE_LIMIT_RPM` environment variable. Exceeding the limit returns HTTP 429.

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
| **Description** | Render a VocalScore to WAV. Returns a URL for retrieving the audio. |

**Request body:**

```json
{
  "score": {
    "bpm": 120,
    "notes": [
      { "id": "n1", "startSec": 0, "durationSec": 1, "midi": 60, "velocity": 0.8 }
    ]
  },
  "config": {
    "presetPath": "presets/kokoro-af-heart",
    "sampleRateHz": 48000,
    "blockSize": 2048,
    "maxPolyphony": 8,
    "rngSeed": 42,
    "defaultTimbre": "AH",
    "deterministic": "exact"
  }
}
```

**Response:**

```json
{
  "ok": true,
  "durationSec": 1.1,
  "telemetry": { ... },
  "provenance": { ... },
  "audioUrl": "/api/renders/last/audio.wav"
}
```

Score duration is capped at 60 seconds by default (override with `MAX_RENDER_DURATION_SEC` environment variable).

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

API errors return a JSON object with an `ok: false` field and error details. Structured errors include a machine-readable `code` and a `message`:

```json
{
  "ok": false,
  "code": "PRESET_NOT_FOUND",
  "message": "Preset 'presets/unknown' not found",
  "available": ["default-voice", "bright-lab", "kokoro-af-heart"]
}
```

General validation errors return a simpler shape:

```json
{
  "ok": false,
  "error": "Missing score"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `false` on errors |
| `code` | string | Machine-readable error code (present on structured errors) |
| `message` | string | Human-readable description (present on structured errors) |
| `error` | string | Error message (present on general validation errors) |

HTTP status codes follow standard conventions: 400 for bad requests, 401 for missing/invalid auth, 404 for not found, 429 for rate limited, 500 for server errors.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | _(unset)_ | Optional bearer token to protect API endpoints |
| `PORT` | `4321` | Server port |
| `RATE_LIMIT_RPM` | `20` | Max render requests per minute per IP |
| `MAX_RENDER_DURATION_SEC` | `60` | Maximum allowed score duration in seconds |
