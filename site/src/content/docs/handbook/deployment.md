---
title: Deployment
description: Run Vocal Synth Engine on Docker, Fly.io, and Render — config, env vars, health checks, and graceful shutdown.
sidebar:
  order: 8
---

Vocal Synth Engine ships three deployment targets out of the box. They all wrap the same Express server (`src/server/index.prod.ts`) and the same bundled cockpit (`apps/cockpit/dist/`).

| Target    | Manifest         | Notes                                                                            |
|-----------|------------------|----------------------------------------------------------------------------------|
| Docker    | `Dockerfile`     | Multi-stage build, non-root `vsynth` user, persistent volume at `/data/renders`. |
| Fly.io    | `fly.toml`       | Auto-stop machines, edge probe at `/api/health`, 1 GB volume mount.              |
| Render    | `render.yaml`    | Docker-runtime, free starter plan, disk mount at `/data/renders`.                |

## Docker

The shipped `Dockerfile` is a multi-stage build on `node:20.18-slim`:

```bash
docker build -t vocal-synth-engine .
docker run -p 4321:4321 \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -v $(pwd)/renders:/data/renders \
  vocal-synth-engine
```

The container:

- Runs as a non-root user (`vsynth`).
- Listens on `:4321` by default (`PORT` env var to override).
- Bakes presets from `presets/` into the image.
- Persists render artifacts to `/data/renders` (mount a volume).
- Includes a `HEALTHCHECK` that hits `/api/health` every 30 s (`wget --spider`).

To pin to an immutable image digest, replace `node:20.18-slim` with `node:20.18-slim@sha256:<digest>`. See `SCORECARD.md` for the open digest-pin upgrade path.

## Fly.io

Deploy from a clone of the repo:

```bash
fly launch --copy-config --no-deploy   # if you haven't already created the app
fly secrets set AUTH_TOKEN=$(openssl rand -hex 32)
fly volumes create render_bank --region iad --size 1
fly deploy
```

Highlights from the shipped `fly.toml`:

- `app = "vocal-synth-cockpit"`, primary region `iad`.
- `internal_port = 4321`, `force_https = true`.
- `auto_stop_machines = "stop"` + `min_machines_running = 0` → idle cost is zero. First-request cold-start is covered by `grace_period = "10s"` on the health check.
- `[[http_service.checks]]` polls `GET /api/health` every 15 s (timeout 2 s).
- `[[mounts]]` maps the `render_bank` volume to `/data/renders` — required for `RENDER_STORE_DIR`.
- VM: `shared-cpu-1x`, 512 MB.

Bump up `[[vm]] memory` if you raise `RENDER_QUEUE_MAX_DEPTH` or run long renders.

## Render

Drop the included `render.yaml` into a Render Blueprint:

```bash
git push     # Render auto-deploys on push to the configured branch
```

- Service type `web`, Docker runtime, Ohio region, starter plan.
- `healthCheckPath: /api/health` for zero-downtime deploys.
- Disk `render-bank` mounted at `/data/renders` (1 GB).
- `AUTH_TOKEN` is declared with `sync: false` — set it manually in the Render dashboard, never commit it.

## Environment variables

Read by `src/server/`. Most have safe defaults; set the ones your deployment cares about.

### Core

| Variable             | Default                | Purpose                                                                                 |
|----------------------|------------------------|-----------------------------------------------------------------------------------------|
| `NODE_ENV`           | `development`          | Set to `production` for the prod server. Affects logging and the auth open-mode warning.|
| `PORT`               | `4321`                 | TCP port the server listens on.                                                         |
| `APP_VERSION`        | from `package.json`    | Surfaced in `/api/health` and `/metrics`.                                               |
| `GIT_COMMIT`         | unset                  | Optional. Surfaced in `/api/health/detailed` for traceability.                          |
| `LOG_LEVEL`          | `info`                 | Pino log level: `trace` / `debug` / `info` / `warn` / `error` / `fatal`.                |
| `TRUST_PROXY`        | unset                  | Set to `1` (or a CIDR list) when behind Fly / Render / nginx so `req.ip` is correct.    |

### Authentication

| Variable          | Default | Purpose                                                                                                                     |
|-------------------|---------|-----------------------------------------------------------------------------------------------------------------------------|
| `AUTH_TOKEN`      | unset   | Single bearer token. When unset all `/api/*` routes are open (warned at boot in production).                                |
| `AUTH_KEYS`       | unset   | Comma-separated `id:token` list for per-principal auth. Tokens are hashed once at boot.                                     |
| `AUTH_KEYS_FILE`  | unset   | Path to a JSON file with the same `id:token` mapping. Useful for secret managers that mount as files.                       |
| `ALLOWED_ORIGIN`  | unset   | CORS `Origin` allowlist (comma-separated). Default is no cross-origin; set this only if a different origin needs API access.|

### Render store + queue

| Variable                      | Default | Purpose                                                                                          |
|-------------------------------|---------|--------------------------------------------------------------------------------------------------|
| `RENDER_STORE_DIR`            | `./renders` | Disk path where saved renders live. Must be a persistent volume in production.                |
| `RENDER_STORE_BUDGET_MB`      | `512`   | Total disk budget for the render bank. New renders are rejected with `RENDER_STORE_FULL` when over.|
| `RENDER_PER_BUDGET_MB`        | `64`    | Per-render size cap. Larger renders are rejected with `RENDER_TOO_LARGE`.                        |
| `MAX_RENDER_DURATION_SEC`     | `300`   | Hard cap on score duration.                                                                      |
| `RENDER_QUEUE_MAX_DEPTH`      | `8`     | Max concurrent + queued render jobs. Excess is rejected with `RENDER_QUEUE_FULL`.                |
| `MAX_NOTES_PER_SCORE`         | `8192`  | Hard cap on `score.notes.length`.                                                                |

### Rate limiting

| Variable                | Default | Purpose                                                          |
|-------------------------|---------|------------------------------------------------------------------|
| `RATE_LIMIT_RPM`        | `20`    | Per-IP requests per minute on render + renders + phonemize.       |
| `RATE_LIMIT_MAX_IPS`    | `10000` | LRU cap on the per-IP counter map.                                |
| `JSON_BODY_LIMIT`       | `1mb`   | Express `body-parser` size cap.                                   |
| `SLOW_REQUEST_MS`       | `1000`  | Log threshold for `slow_request` warnings.                        |

### Live + jam

| Variable                  | Default | Purpose                                                              |
|---------------------------|---------|----------------------------------------------------------------------|
| `MAX_LIVE_SESSIONS`       | `4`     | Concurrent `/ws` connections.                                        |
| `MAX_JAM_SESSIONS`        | `8`     | Concurrent jam rooms.                                                |
| `MAX_JAM_PARTICIPANTS`    | `8`     | Per-room participant cap.                                            |
| `MAX_PHONEMIZE_NOTES`     | `512`   | Cap on `notes.length` per `/api/phonemize` request.                  |
| `MAX_LYRICS_LENGTH`       | `4096`  | Cap on lyric text length per request.                                |
| `WS_PING_INTERVAL_MS`     | `30000` | Heartbeat ping interval for `/ws` + `/ws/jam`.                       |
| `WS_MAX_MISSED_PINGS`     | `2`     | Disconnect after this many missed pongs.                             |

### Presets

| Variable         | Default        | Purpose                                                                |
|------------------|----------------|------------------------------------------------------------------------|
| `PRESET_DIR`     | `./presets`    | Directory containing `<presetId>/voicepreset.json` + assets.           |

## Health checks

Two endpoints:

- `GET /api/health` — public, returns `{ ok, version, uptimeSec }`. Use this for load-balancer probes.
- `GET /api/health/detailed` — auth-required (when `AUTH_TOKEN` is set). Returns commit hash, render store budget, queue depth, active sessions, and process resource usage.

Production deployments should expose only `/api/health` to the public edge. The shipped `fly.toml`, `render.yaml`, and Dockerfile all probe this endpoint.

## Graceful shutdown

The server listens for `SIGTERM` and `SIGINT` and performs a clean shutdown:

1. Stop accepting new HTTP connections.
2. Drain in-flight renders (waits up to `RENDER_QUEUE_MAX_DEPTH × MAX_RENDER_DURATION_SEC`).
3. Close `/ws` and `/ws/jam` sessions with a `1001 going_away`.
4. Flush logs and exit.

Platforms that send `SIGKILL` after a grace period (Fly's default is 30 s; Render's is 30 s) may cut this short — set `MAX_RENDER_DURATION_SEC` accordingly so an in-flight render finishes inside the grace window. Long renders should be backed by a queue worker, not a foreground HTTP call.

## CORS

If your cockpit is served from a different origin than the daemon, set `ALLOWED_ORIGIN` to the cockpit origin (comma-separated for multiple). When unset the server emits no CORS headers — same-origin requests work, cross-origin requests fail at the browser preflight.

## Persistence

The render store is the only stateful surface. Mount a persistent volume at `RENDER_STORE_DIR` in production:

- **Fly.io** — `[[mounts]]` block (already wired in `fly.toml`).
- **Render** — `disk:` block (already wired in `render.yaml`).
- **Docker** — `-v` flag at run time.

If you skip the volume, every redeploy / machine restart loses saved renders. The "Last Render" placeholder is in-memory only and is always lost on restart by design.

## See also

- [API Reference](/handbook/reference/) — REST + WebSocket contract.
- [Troubleshooting](/handbook/troubleshooting/) — error codes returned by the server and what to do about them.
