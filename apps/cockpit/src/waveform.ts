/**
 * Waveform + live scope rendering (FCD-001).
 *
 * Two cheap visualizations on top of the existing canvas + RAF idiom already
 * proven by drawXyPad():
 *
 *  1. `drawStaticWaveform(canvas, audioBuffer)` — peak-bucket overview of a
 *     finished render.  Used under each Render Bank item and in the Compare
 *     modal so the operator can A/B by eye.
 *  2. `LiveScope` — RAF-driven AnalyserNode scope for the Live tab.  Wraps
 *     `AnalyserNode.getFloatTimeDomainData` against the existing
 *     `liveAudioCtx` (sample rate 48000, blockSize 512).  No new audio nodes
 *     enter the playback graph; the analyser is fan-out only.
 *
 * Everything here is vanilla canvas — no Wavesurfer.js, no Tone.js, no FFT
 * library.  The static peak-bucket renderer is O(n) over the PCM and the
 * spectrum is a single 1024-bin FFT done in WebAudio's analyser native code.
 *
 * Decoding contract: decodeAudio(blobUrl, fallbackCtx?) creates one
 * short-lived AudioContext per WAV (or reuses fallbackCtx) and returns the
 * AudioBuffer for re-use by drawStaticWaveform.  The AudioContext closes
 * itself; the caller never owns it.
 */

export interface WaveformOpts {
  /** Foreground waveform color.  Defaults to the cockpit accent. */
  color?: string;
  /** Background fill.  When omitted the canvas is transparent. */
  background?: string;
  /** Center reference-line color.  Empty string disables the line. */
  axisColor?: string;
}

let sharedDecodeCtx: AudioContext | null = null;

/** Lazily-allocated shared OfflineAudioContext for decoding WAV → AudioBuffer.
 *  We deliberately reuse one context across decodes to avoid the per-decode
 *  setup cost that fires when constructing AudioContexts in a loop. */
function getDecodeCtx(): AudioContext {
  if (!sharedDecodeCtx || sharedDecodeCtx.state === 'closed') {
    // 48000 matches the live mode and avoids resampling for live-recorded WAVs.
    sharedDecodeCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
  }
  return sharedDecodeCtx;
}

/**
 * Fetch a WAV from a same-origin URL using the supplied fetcher (typically
 * `authFetch`) and decode it to an AudioBuffer.  Returns null on any failure
 * so callers can degrade gracefully without try/catch noise.
 */
export async function decodeAudioFromUrl(
  url: string,
  fetcher: (u: string) => Promise<Response>,
): Promise<AudioBuffer | null> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    const ctx = getDecodeCtx();
    // decodeAudioData copies the input, so a single buffer can be decoded
    // many times without worrying about detach-on-transfer.
    return await ctx.decodeAudioData(arr.slice(0));
  } catch {
    return null;
  }
}

/**
 * Draw a peak-bucket waveform onto the supplied canvas.  The waveform takes
 * exactly the canvas's width × height in CSS pixels.  Pass DPR-scaled width
 * on a HiDPI display to avoid blur.
 *
 * Algorithm: divide the PCM length by canvas width into N buckets, take the
 * min/max sample per bucket, and draw a vertical line for each bucket between
 * those extremes.  This is the canonical "DAW overview" pattern and is O(n).
 */
export function drawStaticWaveform(
  canvas: HTMLCanvasElement,
  audioBuffer: AudioBuffer,
  opts: WaveformOpts = {},
): void {
  const color = opts.color ?? '#4a90e2';
  const axisColor = opts.axisColor ?? '#444';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h / 2;

  // Clear (or paint background).
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  // Axis line through 0-amplitude — gives the operator a baseline.
  if (axisColor) {
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
  }

  // Use the first channel only — for a typical mono synth output this is the
  // whole signal; for stereo it's the left channel which is fine as overview.
  const data = audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(data.length / w));

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const start = x * samplesPerPixel;
    const end = Math.min(start + samplesPerPixel, data.length);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Map [-1, 1] → [h, 0].
    const yMin = midY - min * (h / 2);
    const yMax = midY - max * (h / 2);
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  ctx.stroke();
}

/**
 * Stacked-pair comparison: two waveforms in one canvas, A on top, B on bottom,
 * sharing a midpoint axis.  Used by the Compare modal so the operator can spot
 * dynamics / clipping / silence-tail differences without playing both.
 */
export function drawComparisonWaveforms(
  canvas: HTMLCanvasElement,
  bufA: AudioBuffer,
  bufB: AudioBuffer,
  opts: { colorA?: string; colorB?: string } = {},
): void {
  const colorA = opts.colorA ?? '#4a90e2';
  const colorB = opts.colorB ?? '#f39c12';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Divider line between A and B halves.
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Render each half by drawing into a sub-canvas via the existing helper.
  // Cheap-and-cheerful: temporarily clip the drawing context.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h / 2);
  ctx.clip();
  // Stretch the A waveform to top half by adjusting the canvas region: we
  // pass a fake canvas whose height = h/2 by drawing into a backing canvas.
  drawHalf(ctx, bufA, w, h / 2, 0, colorA);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h / 2, w, h / 2);
  ctx.clip();
  drawHalf(ctx, bufB, w, h / 2, h / 2, colorB);
  ctx.restore();
}

function drawHalf(
  ctx: CanvasRenderingContext2D,
  audio: AudioBuffer,
  width: number,
  height: number,
  yOffset: number,
  color: string,
): void {
  const midY = yOffset + height / 2;
  const data = audio.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(data.length / width));

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let min = 1;
    let max = -1;
    const start = x * samplesPerPixel;
    const end = Math.min(start + samplesPerPixel, data.length);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMin = midY - min * (height / 2);
    const yMax = midY - max * (height / 2);
    ctx.moveTo(x + 0.5, yMin);
    ctx.lineTo(x + 0.5, yMax);
  }
  ctx.stroke();
}

/**
 * RAF-driven oscilloscope tied to an existing AudioContext.  Insert an
 * AnalyserNode between an upstream source and the destination so the scope
 * shows what the operator hears, not the raw worklet output.
 *
 * Usage:
 *
 *   const scope = new LiveScope(canvas, liveAudioCtx);
 *   scope.attach(liveWorkletNode);   // taps the same node that feeds destination
 *   scope.start();
 *   // ...later on disconnect:
 *   scope.stop();
 *
 * Stop tears down the analyser AND cancels the RAF.  Safe to start/stop many
 * times during a single session.
 */
export class LiveScope {
  private canvas: HTMLCanvasElement;
  private ctx: AudioContext;
  private analyser: AnalyserNode | null = null;
  // The AnalyserNode.getFloatTimeDomainData signature wants Float32Array
  // backed by a plain ArrayBuffer (not SharedArrayBuffer).  Using `any` to
  // sidestep the lib.d.ts generic narrowing — the runtime contract is
  // identical.
  private data: any = null;
  private raf = 0;
  private color: string;

  constructor(canvas: HTMLCanvasElement, audioCtx: AudioContext, opts: { color?: string } = {}) {
    this.canvas = canvas;
    this.ctx = audioCtx;
    this.color = opts.color ?? '#4a90e2';
  }

  attach(source: AudioNode): void {
    this.detach();
    const a = this.ctx.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.6;
    this.data = new Float32Array(a.fftSize);
    // Connect the source to the analyser (fan-out — the source's existing
    // connections to destination still apply).
    source.connect(a);
    this.analyser = a;
  }

  detach(): void {
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch { /* ignore */ }
      this.analyser = null;
    }
    this.data = null;
  }

  start(): void {
    if (!this.analyser) return;
    const tick = () => {
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.detach();
    const g = this.canvas.getContext('2d');
    if (g) g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(): void {
    const a = this.analyser;
    const d = this.data;
    if (!a || !d) return;
    a.getFloatTimeDomainData(d);
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#333';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();

    g.strokeStyle = this.color;
    g.lineWidth = 1.25;
    g.beginPath();
    const step = w / d.length;
    for (let i = 0; i < d.length; i++) {
      const x = i * step;
      const y = h / 2 - d[i] * (h / 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
}
