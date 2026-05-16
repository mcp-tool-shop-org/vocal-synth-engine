# Minor-pinned to node:20.18-slim. Dependabot docker ecosystem will
# auto-bump this on minor/patch advisories. For full reproducibility,
# pin to an immutable digest (`@sha256:<digest>`) — current setting is
# defense-in-depth without that strict guarantee. See SCORECARD.md
# "Open Items" for the digest-pin upgrade path.
FROM node:20.18-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/cockpit/package.json apps/cockpit/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY apps/ apps/

RUN npm run build

FROM node:20.18-slim
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

CMD ["node", "dist/server/index.prod.js"]
