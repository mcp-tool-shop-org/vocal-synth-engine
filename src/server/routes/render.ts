import { Router } from 'express';
import { z } from 'zod';
import { getRenderQueue, type RenderJobEvent } from '../services/renderQueue.js';
import { saveLastRender, RenderBudgetError } from '../storage/renderStore.js';
import { validateBody } from '../middleware/validate.js';
import { HttpError } from '../middleware/errorHandler.js';

export const renderRouter = Router();

const MAX_RENDER_DURATION_SEC = Number(process.env.MAX_RENDER_DURATION_SEC) || 60;
const MAX_NOTES_PER_SCORE = Number(process.env.MAX_NOTES_PER_SCORE) || 10_000;
const MAX_LYRICS_LENGTH = Number(process.env.MAX_LYRICS_LENGTH) || 10_000;

// S-014: presetId must be a safe filesystem segment.  Same pattern enforced
// inside resolvePresetPath as defence-in-depth.
const presetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'presetId must match /^[A-Za-z0-9_-]+$/');

const vocalNoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    startSec: z.number().finite().min(0).max(3600),
    durationSec: z.number().finite().min(0.001).max(3600),
    midi: z.number().int().min(0).max(127),
    velocity: z.number().finite().min(0).max(1).optional(),
    timbre: z.string().min(1).max(64).optional(),
    vibrato: z
      .object({
        rateHz: z.number().finite().min(0).max(50),
        depthCents: z.number().finite().min(0).max(1200),
        onsetSec: z.number().finite().min(0).max(60),
      })
      .strict()
      .optional(),
    portamentoSec: z.number().finite().min(0).max(10).optional(),
  })
  .passthrough();

const phonemeEventSchema = z
  .object({
    tSec: z.number().finite().min(0),
    durSec: z.number().finite().min(0),
    phoneme: z.string().min(1).max(8),
    kind: z.enum(['vowel', 'consonant']),
    timbreHint: z.string().min(1).max(64).optional(),
    strength: z.number().finite().min(0).max(1).optional(),
  })
  .passthrough();

const automationPointSchema = z
  .object({
    tSec: z.number().finite().min(0),
    value: z.number().finite(),
  })
  .strict();

const scoreSchema = z
  .object({
    bpm: z.number().finite().min(20).max(400),
    notes: z.array(vocalNoteSchema).max(MAX_NOTES_PER_SCORE),
    lyrics: z
      .object({
        text: z.string().max(MAX_LYRICS_LENGTH),
        language: z.string().min(2).max(16).optional(),
      })
      .strict()
      .optional(),
    phonemes: z.array(phonemeEventSchema).max(MAX_NOTES_PER_SCORE * 4).optional(),
    lanes: z
      .object({
        dynamics: z.array(automationPointSchema).max(10_000).optional(),
        breathiness: z.array(automationPointSchema).max(10_000).optional(),
        timbreMorph: z
          .record(z.string().max(64), z.array(automationPointSchema).max(10_000))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

const configSchema = z
  .object({
    presetId: presetIdSchema.optional(),
    blockSize: z
      .number()
      .int()
      .refine((v) => [128, 256, 512, 1024, 2048].includes(v), {
        message: 'blockSize must be one of 128, 256, 512, 1024, 2048',
      })
      .optional(),
    deterministic: z.enum(['exact', 'fast']).optional(),
    rngSeed: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    defaultTimbre: z.string().min(1).max(64).optional(),
    maxPolyphony: z.number().int().min(1).max(64).optional(),
  })
  .passthrough();

// S-010 — validated body schema for /api/render.  Exported so /api/renders
// POST can reuse the same `score` + `config` shape (S-008 path).
export const renderBodySchema = z
  .object({
    score: scoreSchema,
    config: configSchema,
  })
  .passthrough();

renderRouter.post('/', validateBody(renderBodySchema), async (req, res, next) => {
  try {
    const { score, config } = req.body as z.infer<typeof renderBodySchema>;

    // Safety: cap render duration
    const notes = score.notes || [];
    let maxEndSec = 0;
    for (const n of notes) {
      const end = (n.startSec || 0) + (n.durationSec || 0);
      if (end > maxEndSec) maxEndSec = end;
    }
    if (maxEndSec > MAX_RENDER_DURATION_SEC) {
      throw new HttpError(
        400,
        'RENDER_TOO_LONG',
        `Score duration ${maxEndSec.toFixed(1)}s exceeds max ${MAX_RENDER_DURATION_SEC}s`,
        {
          hint: `Trim the score or raise MAX_RENDER_DURATION_SEC (currently ${MAX_RENDER_DURATION_SEC})`,
          details: { scoreDurationSec: maxEndSec, maxRenderDurationSec: MAX_RENDER_DURATION_SEC },
        },
      );
    }

    // SB-001 — submit to the render queue; the worker yields to the event
    // loop every block so other API/WS callers stay responsive.  The
    // `X-Render-Job-Id` header lets clients subscribe to progress via
    // GET /api/renders/events?jobId=… (SSE).
    const queue = getRenderQueue();
    let queued;
    try {
      queued = queue.submit({ score, config, requestId: req.requestId });
    } catch (err: any) {
      if (err?.code === 'RENDER_QUEUE_FULL') {
        throw new HttpError(503, err.code, err.message, {
          hint: err.hint,
          details: { queueDepth: queue.depth },
        });
      }
      if (err?.code === 'RENDER_QUEUE_CLOSED') {
        throw new HttpError(503, err.code, err.message, { hint: err.hint });
      }
      throw err;
    }
    res.setHeader('X-Render-Job-Id', queued.jobId);
    const result = await queued.promise;

    // Auto-save to the "last" slot
    saveLastRender({
      score,
      config,
      telemetry: result.telemetry,
      provenance: result.provenance,
      wavBytes: result.wavBytes,
      durationSec: result.durationSec,
    });

    // Return the URL to the last render instead of base64
    res.json({
      ok: true,
      jobId: queued.jobId,
      durationSec: result.durationSec,
      telemetry: result.telemetry,
      provenance: result.provenance,
      audioUrl: '/api/renders/last/audio.wav',
    });
  } catch (err: any) {
    // Phase 5: human-readable preset errors
    if (err?.code === 'PRESET_NOT_FOUND') {
      return next(
        new HttpError(404, 'PRESET_NOT_FOUND', err.message, {
          hint: `Use one of: ${err.available?.join(', ') || '(none — deploy presets)'}`,
          details: {
            presetId: err.presetId,
            presetDir: err.presetDir,
            available: err.available,
          },
        }),
      );
    }
    if (err?.code === 'INVALID_PRESET_ID') {
      return next(
        new HttpError(400, 'INVALID_PRESET_ID', err.message, {
          hint: 'presetId must match /^[A-Za-z0-9_-]{1,64}$/',
        }),
      );
    }
    if (err instanceof RenderBudgetError) {
      return next(new HttpError(err.status, err.code, err.message, { hint: err.hint, details: err.details }));
    }
    if (err?.code === 'CANCELLED') {
      return next(new HttpError(499, 'RENDER_CANCELLED', 'Render was cancelled', {
        hint: 'Resubmit the render',
      }));
    }
    if (err?.code === 'ENOENT') {
      return next(
        new HttpError(500, 'ASSET_NOT_FOUND', `File not found: ${err.path}. The preset assets may be missing from the deployment.`, {
          hint: 'Verify all preset files are present in PRESET_DIR',
          details: { missingPath: err.path },
        }),
      );
    }
    next(err);
  }
});

/**
 * FS-001 — HTTP cancel surface for an in-flight or queued render job.
 *
 * The queue has always exposed `cancel(jobId)` internally but it was
 * unreachable from clients.  This route closes that gap:
 *   - 200 { ok:true, cancelled:true,  state:'queued_removed'  } — job was
 *     waiting and has been removed before the worker started.
 *   - 200 { ok:true, cancelled:true,  state:'running_flagged' } — job is
 *     in-flight; cancellation flag is set, the worker stops at its next
 *     per-block check and a `cancelled` SSE event will follow.
 *   - 404 { code:'JOB_NOT_FOUND' } — no queued or in-flight job matches
 *     the id (already done, never existed, or already cancelled).
 *
 * The jobId path param is bound by the safe-id allowlist used everywhere
 * else (`/^[A-Za-z0-9_-]{1,80}$/` — slightly looser than render ids since
 * job ids include a `job_` prefix).
 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

renderRouter.delete('/jobs/:jobId', (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      throw new HttpError(400, 'INVALID_JOB_ID', 'Invalid jobId', {
        hint: 'jobId must match /^[A-Za-z0-9_-]{1,80}$/',
      });
    }
    const queue = getRenderQueue();
    const outcome = queue.cancel(jobId);
    if (outcome === 'unknown') {
      throw new HttpError(404, 'JOB_NOT_FOUND', `No queued or in-flight job matches ${jobId}`, {
        hint: 'The job may have already finished, been cancelled, or never existed',
      });
    }
    res.json({ ok: true, cancelled: true, jobId, state: outcome });
  } catch (err) {
    next(err);
  }
});

// Aliased POST surface — some clients (and CORS-preflight-averse browsers)
// prefer POST over DELETE for write operations.  Both routes resolve to the
// same handler under the hood; this thin wrapper exists so cockpit and
// future SDKs can choose whichever fits.
renderRouter.post('/jobs/:jobId/cancel', (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      throw new HttpError(400, 'INVALID_JOB_ID', 'Invalid jobId', {
        hint: 'jobId must match /^[A-Za-z0-9_-]{1,80}$/',
      });
    }
    const queue = getRenderQueue();
    const outcome = queue.cancel(jobId);
    if (outcome === 'unknown') {
      throw new HttpError(404, 'JOB_NOT_FOUND', `No queued or in-flight job matches ${jobId}`, {
        hint: 'The job may have already finished, been cancelled, or never existed',
      });
    }
    res.json({ ok: true, cancelled: true, jobId, state: outcome });
  } catch (err) {
    next(err);
  }
});

/**
 * SB-001 humanization — Server-Sent Events stream so clients can render a
 * progress bar instead of staring at a spinner.  The stream lives until the
 * client disconnects or the job emits `done`/`failed`/`cancelled`.
 *
 * Why SSE not WS here?  This endpoint is HTTP-native (the cockpit can hit
 * it from a plain EventSource), composes with the existing auth+rate-limit
 * middleware, and doesn't need bidirectional traffic.  The existing /ws
 * channel stays focused on Live Mode audio.
 */
renderRouter.get('/events', (req, res) => {
  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx response buffering
  res.flushHeaders?.();

  const queue = getRenderQueue();
  // Send an initial comment so the client knows the stream is live.
  res.write(`: connected to render queue (depth=${queue.depth})\n\n`);

  const onEvent = (ev: RenderJobEvent) => {
    if (jobId && ev.jobId !== jobId) return;
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (jobId && (ev.type === 'done' || ev.type === 'failed' || ev.type === 'cancelled')) {
      cleanup();
      res.end();
    }
  };

  // SB-004 echo: 15s heartbeat so proxies don't reap an idle SSE stream.
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    queue.off('event', onEvent);
  };

  queue.on('event', onEvent);
  req.on('close', cleanup);
});
