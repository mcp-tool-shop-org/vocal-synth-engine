import fs from "fs";
import path from "path";
import crypto from "crypto";

export type RenderMeta = {
  id: string;
  name: string;
  createdAt: string;
  commit: string;
  scoreHash: string;
  wavHash: string;
  durationSec: number;
  pinned?: boolean;
  summary?: {
    polyphony?: number;
    deterministic?: string;
    bpm?: number;
    preset?: string;
  };
};

const root = path.resolve(process.env.RENDER_STORE_DIR || ".vscockpit/renders");

// S-001 / S-002: every render id from external input must match this
// pattern.  Allows alnum, underscore, dash, up to 64 chars; the special
// reserved id 'last' (no special chars) is covered.
const RENDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRenderId(id: unknown): id is string {
  return typeof id === 'string' && RENDER_ID_PATTERN.test(id);
}

/**
 * Defence-in-depth: resolve a render id to its directory and assert the
 * resolved path is strictly inside the configured render store root.
 * Throws RangeError on traversal attempts so callers cannot silently leak
 * arbitrary filesystem content (e.g. ../../etc/passwd).
 */
export function safeRenderDir(id: string): string {
  if (!isValidRenderId(id)) {
    const err = new RangeError(`Invalid render id: ${id}`);
    (err as any).code = 'INVALID_RENDER_ID';
    throw err;
  }
  const joined = path.resolve(root, id);
  // path.resolve normalizes any `..` segments; verify the result is still
  // under the root.  Adding path.sep prevents prefix-collision attacks
  // (e.g. root='/renders', resolved='/renders-other/...').
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    const err = new RangeError(`Render id resolves outside store: ${id}`);
    (err as any).code = 'INVALID_RENDER_ID';
    throw err;
  }
  return joined;
}

function ensureRoot() {
  fs.mkdirSync(root, { recursive: true });
}

function sha256Short(buf: Buffer | string) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);
}

export function listRenders(): RenderMeta[] {
  ensureRoot();
  const dirs = fs.readdirSync(root).filter((d) => {
    const p = path.join(root, d);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "meta.json"));
  });

  const metas = dirs.map((d) => {
    const metaPath = path.join(root, d, "meta.json");
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8")) as RenderMeta;
    } catch (e) { return null; }
  }).filter(Boolean) as RenderMeta[];

  metas.sort((a, b) => {
    if (a.id === "last" && b.id !== "last") return -1;
    if (a.id !== "last" && b.id === "last") return 1;
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return metas;
}

/**
 * Internal helper for trusted callers (e.g. saveRender generating a fresh id
 * from new Date().toISOString()).  External request handlers MUST use
 * safeRenderDir() so a malicious `id` cannot escape the render store.
 */
export function getRenderDir(id: string) {
  return path.join(root, id);
}

export function saveRender(args: {
  name?: string;
  score: any;
  config: any;
  telemetry: any;
  provenance: any;
  wavBytes: Buffer;
  durationSec: number;
}): RenderMeta {
  ensureRoot();

  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, "-");

  const dir = getRenderDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const scoreStr = JSON.stringify(args.score, null, 2);
  const configStr = JSON.stringify(args.config, null, 2);

  const scoreHash = sha256Short(scoreStr);
  const wavHash = sha256Short(args.wavBytes);
  const commit = (args.provenance?.commit ?? "unknown").slice(0, 7);

  let finalName = args.name?.trim();
  if (!finalName) {
    const existingDirs = fs.readdirSync(root);
    let untitledCount = 0;
    for (const d of existingDirs) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, d, 'meta.json'), 'utf-8'));
        if (meta.name && meta.name.startsWith('Untitled-')) {
          const num = parseInt(meta.name.split('-')[1]);
          if (!isNaN(num) && num > untitledCount) untitledCount = num;
        }
      } catch (e) {}
    }
    finalName = `Untitled-${untitledCount + 1}`;
  }

  const meta: RenderMeta = {
    id,
    name: finalName,
    createdAt,
    commit,
    scoreHash,
    wavHash,
    durationSec: args.durationSec,
    summary: {
      polyphony: args.config?.maxPolyphony,
      deterministic: args.config?.deterministic,
      bpm: args.score?.bpm,
      preset: args.config?.presetPath,
    },
  };

  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, "score.json"), scoreStr);
  fs.writeFileSync(path.join(dir, "config.json"), configStr);
  fs.writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(args.telemetry, null, 2));
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(args.provenance, null, 2));
  fs.writeFileSync(path.join(dir, "audio.wav"), args.wavBytes);

  return meta;
}

export function saveLastRender(args: {
  score: any;
  config: any;
  telemetry: any;
  provenance: any;
  wavBytes: Buffer;
  durationSec: number;
}): RenderMeta {
  ensureRoot();
  const id = "last";
  const dir = getRenderDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const scoreStr = JSON.stringify(args.score, null, 2);
  const configStr = JSON.stringify(args.config, null, 2);

  const scoreHash = sha256Short(scoreStr);
  const wavHash = sha256Short(args.wavBytes);
  const commit = (args.provenance?.commit ?? "unknown").slice(0, 7);

  const meta: RenderMeta = {
    id,
    name: "Last Render",
    createdAt: new Date().toISOString(),
    commit,
    scoreHash,
    wavHash,
    durationSec: args.durationSec,
    summary: {
      polyphony: args.config?.maxPolyphony,
      deterministic: args.config?.deterministic,
      bpm: args.score?.bpm,
      preset: args.config?.presetPath,
    },
  };

  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, "score.json"), scoreStr);
  fs.writeFileSync(path.join(dir, "config.json"), configStr);
  fs.writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(args.telemetry, null, 2));
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(args.provenance, null, 2));
  fs.writeFileSync(path.join(dir, "audio.wav"), args.wavBytes);

  return meta;
}

export function updateRenderMeta(id: string, updates: Partial<RenderMeta>) {
  // safeRenderDir asserts the id is valid AND that the resolved path is
  // inside the render store root (S-001 / S-002).
  const metaPath = path.join(safeRenderDir(id), "meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (updates.name !== undefined) meta.name = updates.name;
    if (updates.pinned !== undefined) meta.pinned = updates.pinned;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }
  return null;
}

export function deleteRender(id: string) {
  // S-002: hard-stop on traversal attempts BEFORE rmSync({recursive,force}).
  // safeRenderDir throws INVALID_RENDER_ID if the resolved path escapes the
  // store root.
  const dir = safeRenderDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
