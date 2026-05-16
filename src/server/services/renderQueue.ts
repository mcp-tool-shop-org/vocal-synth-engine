/**
 * SB-001 — Single-flight render queue with progress events.
 *
 * BEFORE: every POST /api/render synchronously ran renderScoreToWav, which
 * loops over thousands of audio blocks on the main thread.  Two concurrent
 * renders could starve health checks, WS heartbeats, and every other API
 * call for several seconds.  Operators saw a "frozen server."
 *
 * AFTER: jobs enter a FIFO queue.  The worker processes ONE job at a time
 * and yields back to the event loop between every block (via setImmediate)
 * so the rest of the server stays responsive — health checks return in
 * milliseconds even mid-render.  Subscribers receive `progress` events
 * with the completed fraction so a long render isn't a black box.
 *
 * Humanization lens: every job carries a stable `jobId` and emits
 * `queued / started / progress / done / failed` events the cockpit can
 * surface in a progress bar.  No more "spinner spinning forever."
 *
 * Why not a true worker_thread?  The synth engine doesn't currently support
 * structuredClone of its full state across thread boundaries — moving the
 * engine off-thread is a multi-day refactor.  The event-loop-yielding
 * variant gives us 90% of the win (no head-of-line blocking) with a 50-line
 * surgical change, and the queue API is the right seam for a real
 * worker-thread upgrade later.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import wavefile from 'wavefile';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { loadVoicePreset } from '../../preset/loader.js';
import { StreamingVocalSynthEngine, StreamingVocalSynthConfig } from '../../engine/StreamingVocalSynthEngine.js';
import { getGitCommit } from '../util/gitCommit.js';
import { resolvePresetPath } from './renderScoreToWav.js';
import { getLogger } from '../util/logger.js';

const { WaveFile } = wavefile;

export interface RenderJobRequest {
  jobId?: string;
  score: any;
  config: any;
  requestId?: string;
}

export interface RenderJobResult {
  wavBytes: Buffer;
  telemetry: any;
  provenance: any;
  durationSec: number;
}

export interface RenderJobProgress {
  jobId: string;
  fraction: number;       // 0..1
  blocksRendered: number;
  totalBlocks: number;
  elapsedMs: number;
}

export type RenderJobEvent =
  | { type: 'queued'; jobId: string; position: number }
  | { type: 'started'; jobId: string }
  | { type: 'progress'; jobId: string; progress: RenderJobProgress }
  | { type: 'done'; jobId: string; result: RenderJobResult }
  | { type: 'failed'; jobId: string; error: { code: string; message: string; hint?: string } }
  | { type: 'cancelled'; jobId: string };

interface QueuedJob {
  jobId: string;
  req: RenderJobRequest;
  enqueuedAt: number;
  cancelled: boolean;
  presetCache: Map<string, any>;
  resolve: (r: RenderJobResult) => void;
  reject: (e: any) => void;
}

const PROGRESS_THROTTLE_MS = 250;

/**
 * The queue is process-singleton — there is one render worker.  The cockpit
 * may submit jobs from multiple sources (HTTP, WS, jam) and they all line up
 * in order.  The single-worker rule prevents two renders from competing for
 * CPU and producing the SAME starvation we are trying to fix.
 */
export class RenderQueue extends EventEmitter {
  private queue: QueuedJob[] = [];
  private currentJob: QueuedJob | null = null;
  private shuttingDown = false;
  // Hard cap so a misbehaving client can't flood the queue and OOM us.
  private readonly maxQueueDepth: number;
  private readonly presetCache: Map<string, any> = new Map();

  constructor() {
    super();
    this.maxQueueDepth = Number(process.env.RENDER_QUEUE_MAX_DEPTH || 16);
  }

  /** Number of jobs waiting + the one in flight. */
  get depth(): number {
    return this.queue.length + (this.currentJob ? 1 : 0);
  }

  get inFlight(): boolean {
    return this.currentJob !== null;
  }

  /**
   * FS-003 — readiness probe: true iff the queue can accept a new submit().
   * Flips to false the moment `drain()` is called, so /readyz can return
   * 503 and k8s can stop routing new traffic before the graceful-shutdown
   * window expires.
   */
  isAcceptingJobs(): boolean {
    return !this.shuttingDown;
  }

  submit(req: RenderJobRequest): { jobId: string; promise: Promise<RenderJobResult> } {
    if (this.shuttingDown) {
      const err: any = new Error('Server is shutting down — render queue closed');
      err.code = 'RENDER_QUEUE_CLOSED';
      err.hint = 'Wait for the server to restart, then retry';
      throw err;
    }
    if (this.depth >= this.maxQueueDepth) {
      const err: any = new Error(
        `Render queue full (${this.depth}/${this.maxQueueDepth})`
      );
      err.code = 'RENDER_QUEUE_FULL';
      err.hint =
        'Retry after a few seconds, or raise RENDER_QUEUE_MAX_DEPTH for higher concurrency';
      throw err;
    }
    const jobId = req.jobId || `job_${randomUUID().slice(0, 12)}`;
    const promise = new Promise<RenderJobResult>((resolve, reject) => {
      const job: QueuedJob = {
        jobId,
        req,
        enqueuedAt: Date.now(),
        cancelled: false,
        presetCache: this.presetCache,
        resolve,
        reject,
      };
      this.queue.push(job);
      this.emit('event', {
        type: 'queued',
        jobId,
        position: this.queue.length,
      } satisfies RenderJobEvent);
      this.pump();
    });
    return { jobId, promise };
  }

  /**
   * Result of a cancel request.
   *  - 'queued_removed':  job was waiting and has been removed before start.
   *  - 'running_flagged': job is in-flight; cancellation flag set, worker
   *                      will throw CANCELLED at its next per-block check
   *                      and emit the cancelled event.
   *  - 'unknown':         no queued or in-flight job matches jobId (already
   *                      done, never existed, or already cancelled).
   */
  cancel(jobId: string): 'queued_removed' | 'running_flagged' | 'unknown' {
    // Cancel a queued (not-yet-started) job synchronously by splicing it
    // out of the queue.  No worker has touched it, so we can reject the
    // promise immediately and emit `cancelled`.
    const idx = this.queue.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) {
      const [job] = this.queue.splice(idx, 1);
      job.cancelled = true;
      job.reject(Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' }));
      this.emit('event', { type: 'cancelled', jobId } satisfies RenderJobEvent);
      return 'queued_removed';
    }
    // FS-001 — also flag the currently-running job so the worker's per-block
    // cancellation check (`if (job.cancelled) throw CANCELLED`) stops it at
    // its next yield point (≤ blockSize / sampleRate seconds — typically a
    // few ms for blockSize=1024 @ 48 kHz).  The synth state isn't unwound
    // cleanly but the buffer is discarded; the caller's awaited promise
    // rejects with CANCELLED and an event fires from the catch/run paths.
    if (this.currentJob && this.currentJob.jobId === jobId && !this.currentJob.cancelled) {
      this.currentJob.cancelled = true;
      return 'running_flagged';
    }
    return 'unknown';
  }

  /**
   * Begin a graceful shutdown.  No new jobs accepted; in-flight job is
   * allowed to finish.  Resolves when the queue is fully drained.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.shuttingDown = true;
    const logger = getLogger();
    logger.info({ depth: this.depth }, 'render_queue_drain_start');
    const start = Date.now();
    while (this.inFlight && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Reject anything still queued.
    for (const job of this.queue.splice(0)) {
      job.reject(Object.assign(new Error('Server shutting down'), { code: 'SERVER_SHUTDOWN' }));
      this.emit('event', { type: 'cancelled', jobId: job.jobId } satisfies RenderJobEvent);
    }
    logger.info({}, 'render_queue_drained');
  }

  private pump() {
    if (this.currentJob) return;
    const next = this.queue.shift();
    if (!next) return;
    this.currentJob = next;
    // Defer with setImmediate so the caller's submit() returns BEFORE the
    // worker starts — keeps the call site predictable.
    setImmediate(() => this.run(next));
  }

  private async run(job: QueuedJob) {
    const logger = getLogger({ jobId: job.jobId, requestId: job.req.requestId });
    this.emit('event', { type: 'started', jobId: job.jobId } satisfies RenderJobEvent);
    logger.info({ enqueuedAt: job.enqueuedAt }, 'render_job_started');
    try {
      const result = await this.executeJob(job, logger);
      job.resolve(result);
      this.emit('event', { type: 'done', jobId: job.jobId, result } satisfies RenderJobEvent);
      logger.info(
        {
          durationSec: result.durationSec,
          rtf: result.telemetry?.rtf,
          waitMs: Date.now() - job.enqueuedAt,
        },
        'render_job_done',
      );
    } catch (err: any) {
      const code = err?.code || 'RENDER_FAILED';
      const message = err?.message || String(err);
      const hint = err?.hint;
      // FS-001 — a mid-render cancellation throws CANCELLED; emit a
      // `cancelled` event (not `failed`) so SSE subscribers see the same
      // event type regardless of whether the job was queued-and-removed or
      // running-and-flagged.  The promise still rejects with CANCELLED so
      // the HTTP handler turns it into a 499.
      if (code === 'CANCELLED') {
        logger.info({ code, message }, 'render_job_cancelled');
        job.reject(err);
        this.emit('event', {
          type: 'cancelled',
          jobId: job.jobId,
        } satisfies RenderJobEvent);
      } else {
        logger.error({ code, message }, 'render_job_failed');
        job.reject(err);
        this.emit('event', {
          type: 'failed',
          jobId: job.jobId,
          error: { code, message, hint },
        } satisfies RenderJobEvent);
      }
    } finally {
      this.currentJob = null;
      // Process the next queued job, if any.
      this.pump();
    }
  }

  private async getPreset(presetId: string): Promise<any> {
    if (!this.presetCache.has(presetId)) {
      const manifestPath = resolvePresetPath(presetId);
      this.presetCache.set(presetId, await loadVoicePreset(manifestPath));
    }
    return this.presetCache.get(presetId)!;
  }

  private async executeJob(job: QueuedJob, logger: ReturnType<typeof getLogger>): Promise<RenderJobResult> {
    const { score, config } = job.req;

    // Auto-phonemize lyrics if present and no manual phonemes provided
    if (score.lyrics?.text && !score.phonemes) {
      const { phonemizeLyrics } = await import('../../phonemize/index.js');
      const g2pResult = phonemizeLyrics(score.lyrics.text, score.notes || []);
      score.phonemes = g2pResult.events;
      for (const w of g2pResult.warnings) {
        logger.warn({ source: 'g2p', warning: w }, 'phonemize_warning');
      }
    }

    const presetId = config.presetId || 'default-voice';
    const preset = await this.getPreset(presetId);
    const presetPath = resolvePresetPath(presetId);

    const synthConfig: StreamingVocalSynthConfig = {
      sampleRateHz: preset.manifest.sampleRateHz,
      blockSize: config.blockSize || 1024,
      presetPath,
      deterministic: config.deterministic || 'exact',
      rngSeed: config.rngSeed !== undefined ? config.rngSeed : 123456789,
      defaultTimbre: config.defaultTimbre || Object.keys(preset.timbres)[0],
      maxPolyphony: config.maxPolyphony || 4,
    };

    const engine = new StreamingVocalSynthEngine(synthConfig, preset, score);

    let maxEndSec = 0;
    const events: { time: number; type: 'start' | 'end' }[] = [];
    for (const note of score.notes || []) {
      const endSec = note.startSec + note.durationSec;
      if (endSec > maxEndSec) maxEndSec = endSec;
      events.push({ time: note.startSec, type: 'start' });
      events.push({ time: endSec, type: 'end' });
    }
    events.sort((a, b) => (a.time === b.time ? (a.type === 'end' ? -1 : 1) : a.time - b.time));
    let currentVoices = 0;
    let voicesMax = 0;
    for (const ev of events) {
      if (ev.type === 'start') currentVoices++;
      else currentVoices--;
      if (currentVoices > voicesMax) voicesMax = currentVoices;
    }

    const tailSec = 0.3;
    const maxTimeSec = maxEndSec + tailSec;
    const totalSamples =
      Math.ceil((maxTimeSec * synthConfig.sampleRateHz) / synthConfig.blockSize) *
      synthConfig.blockSize;
    const actualDurationSec = totalSamples / synthConfig.sampleRateHz;
    const totalBlocks = Math.max(1, Math.ceil(totalSamples / synthConfig.blockSize));

    const outBuffer = new Float32Array(totalSamples);
    const startTime = performance.now();

    let offset = 0;
    let blocksRendered = 0;
    let lastProgressAt = 0;

    while (offset < totalSamples) {
      if (job.cancelled) {
        throw Object.assign(new Error('Job cancelled mid-render'), { code: 'CANCELLED' });
      }
      const blockSamples = Math.min(synthConfig.blockSize, totalSamples - offset);
      const block = engine.render(blockSamples);
      outBuffer.set(block, offset);
      offset += blockSamples;
      blocksRendered++;

      // SB-001: yield to the event loop every block.  setImmediate is cheap
      // and lets health checks, WS frames, and other handlers run between
      // synth blocks.  Without this, a 30-second render blocks for ~3
      // seconds of wall time end-to-end with zero responsiveness.
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
        lastProgressAt = now;
        this.emit('event', {
          type: 'progress',
          jobId: job.jobId,
          progress: {
            jobId: job.jobId,
            fraction: blocksRendered / totalBlocks,
            blocksRendered,
            totalBlocks,
            elapsedMs: performance.now() - startTime,
          },
        } satisfies RenderJobEvent);
      }
      await new Promise<void>((r) => setImmediate(r));
    }

    // Final progress = 1.0
    this.emit('event', {
      type: 'progress',
      jobId: job.jobId,
      progress: {
        jobId: job.jobId,
        fraction: 1,
        blocksRendered,
        totalBlocks,
        elapsedMs: performance.now() - startTime,
      },
    } satisfies RenderJobEvent);

    const renderTimeMs = performance.now() - startTime;
    const rtf = actualDurationSec > 0 ? renderTimeMs / 1000 / actualDurationSec : 0;

    let maxVal = 0;
    for (let i = 0; i < totalSamples; i++) {
      if (Math.abs(outBuffer[i]) > maxVal) maxVal = Math.abs(outBuffer[i]);
    }
    const peakDbfs = maxVal > 0 ? 20 * Math.log10(maxVal) : -Infinity;

    if (maxVal > 0) {
      for (let i = 0; i < totalSamples; i++) outBuffer[i] /= maxVal;
    }

    let maxAbsDelta = 0;
    let maxDeltaIndex = 0;
    for (let i = 1; i < totalSamples; i++) {
      const delta = Math.abs(outBuffer[i] - outBuffer[i - 1]);
      if (delta > maxAbsDelta) {
        maxAbsDelta = delta;
        maxDeltaIndex = i;
      }
    }

    const wav = new WaveFile();
    wav.fromScratch(1, synthConfig.sampleRateHz, '32f', outBuffer);
    const wavBuffer = wav.toBuffer();

    const commit = getGitCommit();
    const scoreHash = createHash('sha256').update(JSON.stringify(score)).digest('hex');
    const wavHash = createHash('sha256').update(wavBuffer).digest('hex');
    const provenance = { commit, scoreHash, wavHash, config: synthConfig, presetId };
    const telemetry = {
      maxAbsDelta,
      maxDeltaIndex,
      maxDeltaTimeSec: maxDeltaIndex / synthConfig.sampleRateHz,
      totalSamples,
      blocksRendered,
      durationSec: actualDurationSec,
      scoreDurationSec: maxEndSec,
      notesEndSec: maxEndSec,
      tailSec,
      renderTimeMs,
      rtf,
      peakDbfs,
      voicesMax,
    };

    return {
      wavBytes: Buffer.from(wavBuffer),
      telemetry,
      provenance,
      durationSec: actualDurationSec,
    };
  }
}

// Process singleton — the queue holds state across requests.
let _queue: RenderQueue | null = null;
export function getRenderQueue(): RenderQueue {
  if (!_queue) {
    _queue = new RenderQueue();
    // FS-003 — bind metrics observers to the queue's event stream so each
    // terminal event increments the right Prometheus counter/histogram.
    // Done here (not in the class constructor) to keep prom-client an
    // optional concern: importing renderQueue doesn't drag the metrics
    // module in unless getRenderQueue() is actually invoked at runtime.
    // Lazy-import is dynamic so the symbol resolution happens only once.
    import('../util/metrics.js').then(({ renderJobsTotal, renderDurationSeconds, renderRtf }) => {
      _queue!.on('event', (ev: RenderJobEvent) => {
        if (ev.type === 'done') {
          renderJobsTotal.inc({ outcome: 'done' });
          const dur = ev.result?.durationSec;
          if (typeof dur === 'number' && Number.isFinite(dur) && dur >= 0) {
            renderDurationSeconds.observe(dur);
          }
          const rtfVal = ev.result?.telemetry?.rtf;
          if (typeof rtfVal === 'number' && Number.isFinite(rtfVal) && rtfVal >= 0) {
            renderRtf.observe(rtfVal);
          }
        } else if (ev.type === 'failed') {
          renderJobsTotal.inc({ outcome: 'failed' });
        } else if (ev.type === 'cancelled') {
          renderJobsTotal.inc({ outcome: 'cancelled' });
        }
      });
    }).catch(() => {
      // prom-client unavailable — render queue continues without metrics.
      // This branch should not occur in practice (prom-client is a dep) but
      // we keep the queue functional regardless of metrics availability.
    });
  }
  return _queue;
}
