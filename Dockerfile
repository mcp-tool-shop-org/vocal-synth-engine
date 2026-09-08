# Pinned to the node:22 LTS line. The previous pin, node:20.18-slim, could
# not build at all: it ships Node v20.18.3, while vite@8 and rolldown@1 both
# require `^20.19.0 || >=22.12.0`. npm only warns EBADENGINE and installs
# anyway, so the failure surfaced late and unhelpfully, as rolldown's
# "Cannot find native binding" during `npm run build`.
#
# Track the major, not a patch: a patch pin sitting below a toolchain floor
# is exactly what broke this. For full reproducibility, pin to an immutable
# digest (`@sha256:<digest>`) — see SCORECARD.md "Open Items" (C-014).
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/cockpit/package.json apps/cockpit/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY apps/ apps/

RUN npm run build

FROM node:22-slim
RUN groupadd -r vsynth && useradd -r -g vsynth vsynth

WORKDIR /app

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/dist dist/
COPY --from=builder /app/apps/cockpit/dist apps/cockpit/dist/
COPY package.json ./

# Bake presets into the image
COPY presets/ presets/

RUN mkdir -p /data/renders && chown -R vsynth:vsynth /data

ENV NODE_ENV=production
ENV RENDER_STORE_DIR=/data/renders
ENV PRESET_DIR=/app/presets
ENV PORT=4321

USER vsynth
EXPOSE 4321

# Container-level health probe. This used to shell out to wget, under a
# comment asserting the base image ships it. It does not — node:20-slim,
# 22-slim, 24-slim and 26-slim carry no wget, curl, busybox or nc — so the
# probe could never succeed and the container reported unhealthy for its
# entire life. Probe with the one interpreter the image is guaranteed to
# have. fly/render still probe /api/health at their own edges (fly.toml,
# render.yaml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.prod.js"]
