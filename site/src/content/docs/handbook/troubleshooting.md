---
title: Troubleshooting
description: Structured error codes returned by the daemon, their causes, and how to recover. Plus common cockpit + live-mode problems.
sidebar:
  order: 9
---

Every error from the daemon comes back as a JSON envelope:

```json
{
  "ok": false,
  "code": "RENDER_STORE_FULL",
  "message": "Render store budget exceeded.",
  "hint": "Delete or unpin older renders before saving a new one.",
  "requestId": "abc-123"
}
```

The cockpit surfaces `code`, `message`, and `hint` inline (no `alert()` modals). The `requestId` matches the value in the daemon's log line for that request — quote it when filing an issue.

## Error code reference

### Authentication & authorization

| Code            | HTTP | Cause                                                                                | Next step                                                                                       |
|-----------------|------|--------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `UNAUTHORIZED`  | 401  | Missing or wrong `Authorization: Bearer …` header when `AUTH_TOKEN` is configured.   | Open the cockpit's **🔑 API Key** panel (header) and paste the daemon's `AUTH_TOKEN`.            |
| `FORBIDDEN`     | 403  | Bearer was valid but the resource is owned by another principal.                     | Confirm your `AUTH_KEYS` principal id matches the render's `createdBy`.                          |

The cockpit opens the API-key panel automatically on the first 401 from any fetch.

### Request validation

| Code                  | HTTP | Cause                                                                                | Next step                                                                          |
|-----------------------|------|--------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| `INVALID_BODY`        | 400  | Request body failed Zod validation (missing field, wrong type, out-of-range number). | Inspect `issues[]` on the response for the field path + reason.                    |
| `INVALID_JSON`        | 400  | Body could not be parsed as JSON.                                                    | Verify `Content-Type: application/json` and that the body is well-formed JSON.     |
| `INVALID_RENDER_ID`   | 400  | A render id contains a path traversal segment or invalid characters.                 | Use only ids returned by `/api/renders` (UUID-shaped). Do not hand-build them.     |
| `INVALID_JOB_ID`      | 400  | SSE jobId is malformed.                                                              | Use the `X-Render-Job-Id` header value from the render response.                   |
| `INVALID_PRESET_ID`   | 400  | The preset id contains a path traversal segment or invalid characters.               | Use only preset ids returned by `/api/presets`.                                    |
| `INVALID_MESSAGE`     | —    | A `/ws` message failed schema validation.                                            | Check the message shape against `src/types/live.ts`.                               |
| `PARSE_ERROR`         | —    | A `/ws` text message wasn't valid JSON.                                              | Send a JSON message matching the live protocol.                                    |

### Render queue + storage

| Code                       | HTTP | Cause                                                                              | Next step                                                                                  |
|----------------------------|------|------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `RENDER_QUEUE_FULL`        | 503  | The render queue is at `RENDER_QUEUE_MAX_DEPTH` and cannot accept more jobs.       | Wait for in-flight renders to finish. Increase `RENDER_QUEUE_MAX_DEPTH` if this is chronic. |
| `RENDER_STORE_FULL`        | 507  | Adding this render would exceed `RENDER_STORE_BUDGET_MB`.                          | Delete or unpin older renders, or raise the budget.                                        |
| `RENDER_TOO_LARGE`         | 413  | The estimated render size exceeds `RENDER_PER_BUDGET_MB`.                          | Shorten the score, drop polyphony, or raise the per-render cap.                            |
| `RENDER_CANCELLED`         | 499  | The render job was cancelled (client disconnect, server shutdown).                 | If unexpected, check the daemon log for `SIGTERM` or client-side aborts.                   |
| `CANCELLED`                | —    | A jam recording or other long-running task was cancelled.                          | Re-issue the request if intended; check for stuck participants if not.                     |
| `NO_RECORDING`             | 400  | An export was requested for a session that never started recording.                | Start recording first (`btn-record` in the cockpit's Live tab).                            |
| `EXPORT_FAILED`            | 500  | The jam export pipeline failed (rare; usually disk-related).                       | Check the daemon log for the underlying error and free up `RENDER_STORE_DIR` space.        |

### Preset loading

| Code                        | HTTP | Cause                                                                                    | Next step                                                                                  |
|-----------------------------|------|------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| `PRESET_NOT_FOUND`          | 404  | The requested preset id is not in `PRESET_DIR`.                                          | Check `/api/presets` for the available list. The error envelope includes `available[]`.   |
| `ASSET_NOT_FOUND`           | 500  | The preset manifest references a `.f32` asset file that isn't on disk.                   | Re-deploy with all preset assets present, or rebuild the preset via `build-preset`.        |
| `ASSET_INTEGRITY_MISMATCH`  | 500  | A preset asset's SHA hash doesn't match the manifest's declared `assetsHash`.            | A file was modified or corrupted. Re-download / rebuild the preset.                        |
| `UNSUPPORTED_PRESET_VERSION`| 400  | The preset's `formatVersion` is newer than the engine supports.                          | Upgrade the engine or downgrade the preset.                                                |
| `UNSUPPORTED_SCORE_VERSION` | 400  | The score's `formatVersion` is newer than the engine supports.                           | Upgrade the engine (`SUPPORTED_SCORE_VERSIONS` is published in `src/types/scoreSchema.ts`).|
| `PRESET_LIST_FAILED`        | 500  | The server could not enumerate `PRESET_DIR`.                                             | Verify the path exists and is readable by the daemon user.                                 |

### Rate limiting

| Code           | HTTP | Cause                                                                                 | Next step                                                                          |
|----------------|------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| `RATE_LIMITED` | 429  | Per-IP request rate exceeded `RATE_LIMIT_RPM` (default 20/min on render endpoints).   | Throttle the client. Raise `RATE_LIMIT_RPM` if the limit is too tight for the use case. |

The `Retry-After` header is set on every 429.

### Server lifecycle

| Code              | HTTP | Cause                                                                          | Next step                                                                |
|-------------------|------|--------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `SERVER_SHUTDOWN` | 503  | The daemon received `SIGTERM` / `SIGINT` and is draining.                      | Retry against the redeployed instance. In Fly/Render this is automatic. |
| `NOT_FOUND`       | 404  | The route doesn't exist.                                                       | Check the path. `/api/*` 404s return JSON; other 404s return HTML.       |
| `READ_ERROR`      | 500  | A render asset (audio.wav, telemetry.json, score.json) could not be read.      | Check disk health and that the render directory wasn't deleted out from under the daemon. |

---

## Common cockpit problems

### "Daemon Offline" badge

The cockpit polls `/api/health` every 5 s.

- If the badge is **red**, the daemon is unreachable. Check the daemon log and that `PORT` is correct.
- If the badge is **red but `/api/health` works in curl**, the cockpit is loaded from a different origin than the daemon. Set `ALLOWED_ORIGIN` on the daemon to the cockpit origin.

### "No voices on server" banner

`/api/presets` returned an empty list. Either `PRESET_DIR` is wrong, or the directory is empty. Re-deploy with `presets/` populated, or build a fresh preset with `build-preset`.

### 401 dialog keeps reopening

The cockpit sends `Authorization: Bearer <stored token>` on every fetch. If 401 persists:

1. Click the **🔑 API Key** button in the header.
2. Click **Clear**, then **Save** a fresh value pasted from the daemon's `AUTH_TOKEN` env var.
3. Confirm with `curl -H 'Authorization: Bearer <token>' http://<daemon>/api/health/detailed` from a shell.

### Audio plays in Live mode but not on rendered playback

The cockpit fetches the WAV via `authFetch` and creates a blob URL for `<audio>` (the element cannot send `Authorization` headers itself). If the blob fetch fails the audio element silently does nothing.

- Check the browser console for a `401` line — that means the saved token is wrong.
- Check the `Network` tab for the `/api/renders/<id>/audio.wav` request — if it's missing entirely, try Reload.

### Compare modal shows no waveform

The Compare modal fetches and decodes both WAVs in parallel. If either decode fails (corrupt WAV, network error) the waveform canvas stays empty. The numeric stats above still render. Check the browser console.

---

## Common Live-mode problems

### "Failed to load AudioWorklet"

`pcm-worklet.js` could not be loaded from `/pcm-worklet.js`.

- Cause: the cockpit is being served from a CDN that doesn't expose `apps/cockpit/public/pcm-worklet.js`, or the file is missing from `dist/`.
- Fix: run `npm run build:cockpit` and confirm `apps/cockpit/dist/pcm-worklet.js` exists.

### Live WS closes immediately with code 4001

Server-side WS auth rejected your token.

- `?token=<TOKEN>` is the WebSocket query parameter the server expects (browsers don't allow custom headers on the WebSocket constructor).
- If you have an API key saved in the cockpit, the live tab attaches it automatically. From a custom client, append `?token=<your-token>` to the WS URL.

### Live WS closes with code 4002

The server is at `MAX_LIVE_SESSIONS` (default 4). The close reason is `"Server full (X/Y)"`. Wait for another session to disconnect or raise the limit.

### "BUFFER STARVED" badge stays lit

Underruns have happened since you connected.

- Switch the **Latency** dropdown from Low to Balanced (or Balanced to Safe).
- Lower polyphony.
- Check the server's CPU saturation in `/api/health/detailed` (auth required).

### MIDI dropdown is empty

The browser denied or never asked for `requestMIDIAccess()`.

- Firefox does not support WebMIDI — use Chrome / Edge / Safari (with the WebMIDI flag enabled).
- Refresh the page after plugging a MIDI device in.

### Recording auto-stops at exactly 60 s

By design — the live recording cap is 60 s to bound the in-memory buffer. Save what you have, then start a new recording.

---

## Reading the daemon log

The daemon emits structured Pino JSON logs. The fields most useful for triage:

- `requestId` — matches the value in the error envelope's `requestId`.
- `code` — the same code surfaced to the client.
- `slow_request` — fires when a request exceeds `SLOW_REQUEST_MS` (default 1 s).
- `live_session_rejected_full` — server hit `MAX_LIVE_SESSIONS`.
- `boot_auth_open_mode_in_production` — production server booted without `AUTH_TOKEN` (loud warn).

Pretty-print with `pino-pretty`:

```bash
node dist/server/index.prod.js | pino-pretty
```

## See also

- [API Reference](/handbook/reference/) — endpoint contract.
- [Deployment](/handbook/deployment/) — env vars, health checks, graceful shutdown.
