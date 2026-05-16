import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getLogger } from "../util/logger.js";

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
    // S-017 — ignore dot-prefixed dirs (e.g. .last-staging-*, .last-trash-*)
    // so partially-written renders are never returned to API callers.
    if (d.startsWith('.')) return false;
    const p = path.join(root, d);
    try {
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "meta.json"));
    } catch {
      return false;
    }
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

/**
 * S-016 — concurrent saveRender calls used to collide three ways:
 *   1. Two ISO timestamps in the same millisecond produced identical ids,
 *      so both writers targeted the same directory; last write wins, first
 *      writer's files were clobbered.
 *   2. Two writers scanning `existingDirs` simultaneously computed the
 *      same `untitledCount`, both producing `Untitled-N+1`.
 *   3. mkdir({recursive:true}) silently accepted the collision.
 *
 * Mitigations:
 *   - Append an 8-char `randomUUID()` slug to the id.  randomUUID's high
 *     entropy makes same-millisecond collisions astronomically unlikely.
 *   - mkdir with {recursive:false} and retry on EEXIST with a fresh slug.
 *   - Decorate the Untitled-N base name with the same UUID slug used in
 *     the id so two concurrent writers picking the same N never collide
 *     on the user-visible name.  This avoids a fragile in-process mutex
 *     while still keeping names readable and unique.
 */
function nextUntitledBaseNum(): number {
  const existingDirs = fs.readdirSync(root);
  let maxNum = 0;
  for (const d of existingDirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, d, 'meta.json'), 'utf-8'));
      if (meta?.name && typeof meta.name === 'string' && meta.name.startsWith('Untitled-')) {
        const num = parseInt(meta.name.split('-')[1], 10);
        if (Number.isFinite(num) && num > maxNum) maxNum = num;
      }
    } catch {}
  }
  return maxNum + 1;
}

function mkdirExclusive(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: false });
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
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

  // SB-002 — disk-budget pre-check.  Throws RenderBudgetError (status 413,
  // code RENDER_TOO_LARGE | RENDER_STORE_FULL) BEFORE writing any bytes so
  // we never leave a half-written render on a full disk.  Approximate
  // incoming bytes from wav + JSON payloads.
  const approxIncoming =
    args.wavBytes.byteLength +
    JSON.stringify(args.score).length +
    JSON.stringify(args.config).length +
    JSON.stringify(args.telemetry).length +
    JSON.stringify(args.provenance).length +
    2_048; // meta.json + filesystem overhead
  assertRenderBudget(approxIncoming);

  // S-016 — id := ISO timestamp + 8-char UUID slug so two writers in the
  // same millisecond never collide on the directory name.  Retry up to 5
  // times against the (astronomically unlikely) slug collision.
  const createdAt = new Date().toISOString();
  let slug = crypto.randomUUID().slice(0, 8);
  let id = `${createdAt.replace(/[:.]/g, '-')}-${slug}`;
  let dir = getRenderDir(id);
  for (let attempt = 0; attempt < 5 && !mkdirExclusive(dir); attempt++) {
    slug = crypto.randomUUID().slice(0, 8);
    id = `${createdAt.replace(/[:.]/g, '-')}-${slug}`;
    dir = getRenderDir(id);
  }
  if (!fs.existsSync(dir)) {
    // Last attempt's race lost; fall back to recursive mkdir.
    fs.mkdirSync(dir, { recursive: true });
  }

  const scoreStr = JSON.stringify(args.score, null, 2);
  const configStr = JSON.stringify(args.config, null, 2);

  const scoreHash = sha256Short(scoreStr);
  const wavHash = sha256Short(args.wavBytes);
  const commit = (args.provenance?.commit ?? "unknown").slice(0, 7);

  let finalName = args.name?.trim();
  if (!finalName) {
    // S-016 — append the UUID slug to the user-visible Untitled name so
    // two concurrent renders that both picked Untitled-N don't end up
    // displaying the same name in the UI.  Numerically the next slot is
    // still computed off the highest existing N.
    const num = nextUntitledBaseNum();
    finalName = `Untitled-${num}-${slug}`;
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

  // SB-002: post-save heads-up if we crossed the warning threshold so the
  // operator sees pressure BEFORE the next save 413s at the budget ceiling.
  logBudgetIfNotable();

  return meta;
}

/**
 * S-017 — saveLastRender used to write 6 files non-atomically into
 * `last/` while concurrent readers (GET /api/renders/last/audio.wav, etc.)
 * could see partially written JSON or truncated audio mid-stream.  Two
 * concurrent renders could also interleave their writes, producing a
 * `last/` whose meta points at one render but whose audio is from
 * another.
 *
 * Fix: stage every write inside a sibling `last.staging-<slug>/` directory
 * then atomically swap it into place via:
 *   1. If `last/` exists, rename it to `last.old-<slug>/`.
 *   2. Rename the staging directory to `last/`.
 *   3. Delete `last.old-<slug>/`.
 *
 * fs.renameSync of a directory is atomic on POSIX and on Windows when the
 * source and destination live on the same volume (always true here since
 * both are under `root`).  Readers therefore observe `last/` either at the
 * previous render's contents or the new one — never a half-written mix.
 */
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
  const finalDir = getRenderDir(id);

  // SB-002 — disk-budget pre-check.  Same envelope as saveRender; for the
  // `last/` slot we conservatively bill the NEW render's bytes against the
  // store even though the swap will delete the previous `last/` first.  An
  // operator hovering near the budget ceiling gets the 413 with a hint
  // BEFORE we stage anything.
  const approxIncoming =
    args.wavBytes.byteLength +
    JSON.stringify(args.score).length +
    JSON.stringify(args.config).length +
    JSON.stringify(args.telemetry).length +
    JSON.stringify(args.provenance).length +
    2_048;
  assertRenderBudget(approxIncoming);

  // Staging/trash dirs use names that DO NOT match the render-id allowlist
  // (`/^[A-Za-z0-9_-]{1,64}$/`) because they contain dots — so an API
  // caller cannot ever request `GET /api/renders/.last-staging-xxx/...`,
  // and `listRenders` further filters by `meta.json existing` (we write
  // meta.json LAST in the staging phase so the dir is invisible until the
  // atomic rename completes).
  const slug = crypto.randomUUID().slice(0, 8);
  const stagingDir = path.join(root, `.last-staging-${slug}`);
  const trashDir = path.join(root, `.last-trash-${slug}`);

  fs.mkdirSync(stagingDir, { recursive: true });

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

  try {
    // S-017 — write meta.json LAST so listRenders / any incidental
    // directory scan that happens to land in the (dot-prefixed) staging
    // dir cannot observe it as a complete render mid-write.
    fs.writeFileSync(path.join(stagingDir, "score.json"), scoreStr);
    fs.writeFileSync(path.join(stagingDir, "config.json"), configStr);
    fs.writeFileSync(path.join(stagingDir, "telemetry.json"), JSON.stringify(args.telemetry, null, 2));
    fs.writeFileSync(path.join(stagingDir, "provenance.json"), JSON.stringify(args.provenance, null, 2));
    fs.writeFileSync(path.join(stagingDir, "audio.wav"), args.wavBytes);
    fs.writeFileSync(path.join(stagingDir, "meta.json"), JSON.stringify(meta, null, 2));

    // Atomic swap: stash old `last/` (if any), promote staging to `last/`,
    // then delete the stash.  Each individual rename is atomic; readers
    // either see the old `last/` or the new one.
    const hadPrevious = fs.existsSync(finalDir);
    if (hadPrevious) {
      fs.renameSync(finalDir, trashDir);
    }
    try {
      fs.renameSync(stagingDir, finalDir);
    } catch (renameErr) {
      // Promotion failed — try to restore the previous `last/` so the
      // store isn't left empty.  If restoration also fails the original
      // error is the most useful one to surface.
      if (hadPrevious) {
        try { fs.renameSync(trashDir, finalDir); } catch {}
      }
      throw renameErr;
    }
    if (hadPrevious) {
      fs.rmSync(trashDir, { recursive: true, force: true });
    }
  } finally {
    // Clean up staging dir if promotion never moved it (e.g. mid-write throw).
    if (fs.existsSync(stagingDir)) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
  }

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

/**
 * SB-002 — Disk-budget bookkeeping for the render store.
 *
 * BEFORE: unlimited renders accumulated under .vscockpit/renders/ until the
 * disk filled, then EVERY save failed silently with ENOSPC and the user got
 * a generic 500.
 *
 * AFTER:
 *   - per-render hard cap (RENDER_PER_BUDGET_MB, default 256 MB) — rejected
 *     BEFORE we open the file
 *   - aggregate store cap (RENDER_STORE_BUDGET_MB, default 4096 MB) —
 *     enforced precheck on save with an actionable error code
 *
 * Both limits surface as 413 RENDER_STORE_FULL / RENDER_TOO_LARGE with a
 * hint that names the env var the operator would raise.  No more
 * "everything is broken" — operators get a one-line action.
 */
const RENDER_PER_BUDGET_MB = Number(process.env.RENDER_PER_BUDGET_MB || 256);
const RENDER_STORE_BUDGET_MB = Number(process.env.RENDER_STORE_BUDGET_MB || 4096);
const MB = 1024 * 1024;

export class RenderBudgetError extends Error {
  status: number;
  code: string;
  hint: string;
  details: Record<string, unknown>;

  constructor(
    code: 'RENDER_TOO_LARGE' | 'RENDER_STORE_FULL',
    message: string,
    details: Record<string, unknown>,
    hint: string,
  ) {
    super(message);
    this.name = 'RenderBudgetError';
    this.status = 413;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

/**
 * Compute the current on-disk size of the render store.  Walks meta.json +
 * audio.wav per render — fast enough for thousands of renders.
 */
export function getRenderStoreSizeBytes(): number {
  ensureRoot();
  let total = 0;
  for (const d of fs.readdirSync(root)) {
    const renderDir = path.join(root, d);
    try {
      const stat = fs.statSync(renderDir);
      if (!stat.isDirectory()) continue;
      for (const f of fs.readdirSync(renderDir)) {
        try {
          total += fs.statSync(path.join(renderDir, f)).size;
        } catch {}
      }
    } catch {}
  }
  return total;
}

export interface RenderBudgetSnapshot {
  perRenderBudgetBytes: number;
  storeBudgetBytes: number;
  usedBytes: number;
  freeBytes: number;
  utilizationFraction: number;
}

export function getRenderBudgetSnapshot(): RenderBudgetSnapshot {
  const usedBytes = getRenderStoreSizeBytes();
  const storeBudgetBytes = RENDER_STORE_BUDGET_MB * MB;
  return {
    perRenderBudgetBytes: RENDER_PER_BUDGET_MB * MB,
    storeBudgetBytes,
    usedBytes,
    freeBytes: Math.max(0, storeBudgetBytes - usedBytes),
    utilizationFraction: storeBudgetBytes > 0 ? usedBytes / storeBudgetBytes : 0,
  };
}

/**
 * Throw a humanized RenderBudgetError if `incomingBytes` would exceed
 * either budget.  Call BEFORE writing any of the staged files.
 */
export function assertRenderBudget(incomingBytes: number): void {
  const perBudget = RENDER_PER_BUDGET_MB * MB;
  if (incomingBytes > perBudget) {
    throw new RenderBudgetError(
      'RENDER_TOO_LARGE',
      `Render is ${(incomingBytes / MB).toFixed(1)} MB — exceeds RENDER_PER_BUDGET_MB (${RENDER_PER_BUDGET_MB} MB)`,
      { renderBytes: incomingBytes, perRenderBudgetBytes: perBudget },
      'Reduce the render duration or raise RENDER_PER_BUDGET_MB',
    );
  }
  const snap = getRenderBudgetSnapshot();
  if (snap.usedBytes + incomingBytes > snap.storeBudgetBytes) {
    throw new RenderBudgetError(
      'RENDER_STORE_FULL',
      `Render store full: ${(snap.usedBytes / MB).toFixed(1)} / ${(snap.storeBudgetBytes / MB).toFixed(1)} MB used, incoming ${(incomingBytes / MB).toFixed(1)} MB`,
      {
        usedBytes: snap.usedBytes,
        storeBudgetBytes: snap.storeBudgetBytes,
        incomingBytes,
      },
      'Delete old renders via DELETE /api/renders/:id or raise RENDER_STORE_BUDGET_MB',
    );
  }
}

/**
 * Emit a warning log line if utilization crosses well-known thresholds.
 * Operators see a heads-up at 80% before the next request 413s at 100%.
 */
export function logBudgetIfNotable(): void {
  const snap = getRenderBudgetSnapshot();
  if (snap.utilizationFraction >= 0.8) {
    getLogger().warn(
      {
        usedMb: Math.round(snap.usedBytes / MB),
        budgetMb: Math.round(snap.storeBudgetBytes / MB),
        utilization: Math.round(snap.utilizationFraction * 100),
      },
      'render_store_high_utilization',
    );
  }
}
