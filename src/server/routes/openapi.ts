/**
 * FS-004 — OpenAPI 3.1 spec generated from the existing Zod schemas.
 *
 * Exposed at GET /api/openapi.json (no auth — the spec itself is public).
 *
 * Strategy:
 *   - Re-declare the request/response schemas via @asteasolutions/zod-to-openapi
 *     `extendZodWithOpenApi` so we attach OpenAPI metadata (descriptions,
 *     examples) without touching the original validators that route
 *     handlers depend on.  We reference the existing schemas where the
 *     shapes are identical, but for the request schemas we generally
 *     re-declare with `.openapi(...)` calls so the rendered spec carries
 *     human-readable descriptions for each field.
 *   - The generator runs at server boot (lazy) and the result is cached
 *     so /api/openapi.json is a one-line buffer-send on every subsequent
 *     hit.  The spec is small enough (≈ tens of KB) that a single static
 *     buffer beats per-request regeneration.
 *
 * Cost vs benefit: registering ~10 schemas is ~50 lines.  The payoff is
 * a published contract every downstream client (cockpit, SDKs, MCP
 * wrapper, Godot plugin) can read without reverse-engineering source.
 */
import { Router } from 'express';
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { renderBodySchema } from './render.js';

// Attach .openapi() to the global zod prototype.  This is a no-op for
// validators; it just lets us add metadata.  Safe to call multiple times.
extendZodWithOpenApi(z);

export const openapiRouter = Router();

/**
 * Build (and cache) the OpenAPI document.  Lazy-built on first hit so the
 * server boot path doesn't pay the cost when nobody scrapes the endpoint.
 */
let cachedSpec: any | null = null;

function buildSpec(): any {
  if (cachedSpec) return cachedSpec;

  const registry = new OpenAPIRegistry();

  // Bearer security scheme — registered as a raw component because the
  // generator can't infer it from a zod schema (it's not a request body).
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'opaque',
  });

  // ─── Shared error envelope (SB-005) ─────────────────────────────────
  const errorEnvelope = registry.register(
    'ErrorEnvelope',
    z
      .object({
        ok: z.literal(false).openapi({ description: 'Always false for an error response' }),
        code: z.string().openapi({ description: 'Stable machine-readable error code (e.g. UNAUTHORIZED, INVALID_BODY, RENDER_QUEUE_FULL)' }),
        message: z.string().openapi({ description: 'Human-readable summary suitable for surfacing to end users' }),
        hint: z.string().optional().openapi({ description: 'Actionable next step written for an operator' }),
        requestId: z.string().optional().openapi({ description: 'X-Request-Id correlation token for log search' }),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .openapi('ErrorEnvelope', { description: 'JSON error envelope — common to every 4xx/5xx response.' }),
  );

  // ─── Health ──────────────────────────────────────────────────────────
  const healthBody = registry.register(
    'HealthSummary',
    z.object({
      ok: z.literal(true),
      version: z.string().openapi({ description: 'Application version (defaults to "dev" if APP_VERSION is unset)' }),
      uptimeSec: z.number().openapi({ description: 'Seconds since the server process started' }),
    }).openapi('HealthSummary'),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/v1/health',
    summary: 'Server liveness summary (open)',
    description: 'No auth required. Suitable for load-balancer health checks.',
    tags: ['health'],
    responses: {
      200: {
        description: 'Server is alive',
        content: { 'application/json': { schema: healthBody } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/livez',
    summary: 'Liveness probe (open)',
    description: 'Returns 200 OK with body "ok" when the process is alive.',
    tags: ['health'],
    responses: { 200: { description: 'Process is alive' } },
  });

  registry.registerPath({
    method: 'get',
    path: '/readyz',
    summary: 'Readiness probe (open)',
    description: 'Returns 200 when the server can accept traffic, 503 with a `failing` array otherwise.',
    tags: ['health'],
    responses: {
      200: { description: 'Ready' },
      503: { description: 'Not ready' },
    },
  });

  // ─── Render ─────────────────────────────────────────────────────────
  const renderBody = registry.register('RenderBody', renderBodySchema.openapi('RenderBody', {
    description: 'A score + render config.  Same shape POSTed to /api/v1/render and /api/v1/renders.',
  }));

  const renderResponse = registry.register(
    'RenderResponse',
    z.object({
      ok: z.literal(true),
      jobId: z.string().openapi({ description: 'Queue job id; echo of X-Render-Job-Id response header' }),
      durationSec: z.number().openapi({ description: 'Audio duration of the rendered output' }),
      telemetry: z.record(z.string(), z.unknown()).openapi({ description: 'Render telemetry (RTF, peakDbfs, voicesMax, etc.)' }),
      provenance: z.record(z.string(), z.unknown()).openapi({ description: 'Reproducibility provenance (commit, hashes, config)' }),
      audioUrl: z.string().openapi({ description: 'Relative URL to fetch the rendered WAV' }),
    }).openapi('RenderResponse'),
  );

  registry.registerPath({
    method: 'post',
    path: '/api/v1/render',
    summary: 'Render a score to WAV (auto-save to the `last` slot)',
    tags: ['render'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: { 'application/json': { schema: renderBody } },
      },
    },
    responses: {
      200: { description: 'Render succeeded', content: { 'application/json': { schema: renderResponse } } },
      400: { description: 'Validation failure', content: { 'application/json': { schema: errorEnvelope } } },
      401: { description: 'Missing/invalid auth', content: { 'application/json': { schema: errorEnvelope } } },
      404: { description: 'Preset not found', content: { 'application/json': { schema: errorEnvelope } } },
      413: { description: 'Render too large or store full', content: { 'application/json': { schema: errorEnvelope } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: errorEnvelope } } },
      499: { description: 'Render cancelled', content: { 'application/json': { schema: errorEnvelope } } },
      503: { description: 'Queue full or shutting down', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/render/jobs/{jobId}',
    summary: 'Cancel a queued or in-flight render job (FS-001)',
    tags: ['render'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ jobId: z.string().openapi({ description: 'Render job id (returned in X-Render-Job-Id)' }) }),
    },
    responses: {
      200: {
        description: 'Job removed from queue or flagged for cancellation mid-render',
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              cancelled: z.literal(true),
              jobId: z.string(),
              state: z.enum(['queued_removed', 'running_flagged']),
            }),
          },
        },
      },
      404: { description: 'Job id not found', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/render/jobs/{jobId}/cancel',
    summary: 'POST alias for the cancel route (FS-001)',
    tags: ['render'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ jobId: z.string() }),
    },
    responses: {
      200: { description: 'Cancellation accepted' },
      404: { description: 'Job id not found', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/render/events',
    summary: 'SSE progress stream for a render job',
    description: 'Server-Sent Events.  Emits queued / started / progress / done / failed / cancelled events.',
    tags: ['render'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({ jobId: z.string().optional().openapi({ description: 'Filter the stream to a single job id' }) }),
    },
    responses: { 200: { description: 'SSE stream' } },
  });

  // ─── Renders (bank) ─────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/renders',
    summary: 'List saved renders (filtered to the authenticated user unless admin)',
    tags: ['renders'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Render list + budget snapshot' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/renders',
    summary: 'Render and persist into the bank',
    tags: ['renders'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ name: z.string().optional() }).and(renderBody as any),
          },
        },
      },
    },
    responses: {
      200: { description: 'Saved render meta' },
      400: { description: 'Validation failure', content: { 'application/json': { schema: errorEnvelope } } },
      413: { description: 'Render too large or store full', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  for (const sub of ['audio.wav', 'meta', 'score', 'telemetry', 'provenance'] as const) {
    registry.registerPath({
      method: 'get',
      path: `/api/v1/renders/{id}/${sub}`,
      summary: `Read ${sub} for a render`,
      tags: ['renders'],
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: 'OK' },
        403: { description: 'Render belongs to another user', content: { 'application/json': { schema: errorEnvelope } } },
        404: { description: 'Render not found' },
      },
    });
  }

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/renders/{id}',
    summary: 'Delete a saved render',
    tags: ['renders'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'Deleted; returns updated budget' },
      400: { description: 'Invalid render id', content: { 'application/json': { schema: errorEnvelope } } },
      403: { description: 'Render belongs to another user', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/renders/{id}',
    summary: 'Update a saved render (name, pinned)',
    tags: ['renders'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ name: z.string().optional(), pinned: z.boolean().optional() }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated meta' },
      400: { description: 'Invalid body', content: { 'application/json': { schema: errorEnvelope } } },
      403: { description: 'Render belongs to another user', content: { 'application/json': { schema: errorEnvelope } } },
      404: { description: 'Render not found' },
    },
  });

  // ─── Presets ────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/presets',
    summary: 'List installed voice presets (open)',
    tags: ['presets'],
    responses: { 200: { description: 'Preset list' } },
  });

  // ─── Phonemize ──────────────────────────────────────────────────────
  registry.registerPath({
    method: 'post',
    path: '/api/v1/phonemize',
    summary: 'Convert lyrics + notes into phoneme events',
    tags: ['phonemize'],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              text: z.string(),
              notes: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Phoneme events + warnings' },
      400: { description: 'Validation failure', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  // ─── Metrics ────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/metrics',
    summary: 'Prometheus metrics exposition (admin auth required)',
    tags: ['ops'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Prometheus text-format exposition' },
      401: { description: 'Missing/invalid auth', content: { 'application/json': { schema: errorEnvelope } } },
      403: { description: 'Caller is not admin', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  // Generate the final document.
  const generator = new OpenApiGeneratorV31(registry.definitions);
  cachedSpec = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: '@mcptoolshop/vocal-synth-engine HTTP API',
      version: process.env.APP_VERSION ?? 'dev',
      description:
        'HTTP API for the deterministic vocal synthesis engine.  ' +
        'All non-public routes require Authorization: Bearer <api-key>.  ' +
        'Errors share a common envelope (see #/components/schemas/ErrorEnvelope).',
    },
    servers: [
      { url: '/', description: 'Same-origin (default cockpit deployment)' },
    ],
  });
  return cachedSpec;
}

openapiRouter.get('/', (_req, res) => {
  try {
    res.json(buildSpec());
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      code: 'OPENAPI_BUILD_FAILED',
      message: err?.message || String(err),
    });
  }
});

/** Test-only — flush cached spec so a re-import sees fresh registry state. */
export function _resetOpenApiCacheForTests(): void {
  cachedSpec = null;
}
