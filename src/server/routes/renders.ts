import { Router } from "express";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  listRenders,
  getRenderDir,
  saveRender,
  updateRenderMeta,
  deleteRender,
  safeRenderDir,
  getRenderBudgetSnapshot,
  RenderBudgetError,
} from "../storage/renderStore.js";
import { getRenderQueue } from "../services/renderQueue.js";
import { validateBody } from "../middleware/validate.js";
import { renderBodySchema } from "./render.js";
import { HttpError } from "../middleware/errorHandler.js";

export const rendersRouter = Router();

/**
 * S-001 / S-002 — sanitise every :id path param BEFORE it reaches
 * fs.createReadStream / fs.readFileSync / fs.rmSync.  safeRenderDir validates
 * the id against /^[A-Za-z0-9_-]{1,64}$/ AND verifies the resolved path is
 * strictly inside the render store root.  Returns 400 on traversal attempts.
 *
 * Note: express 5's ParamsDictionary types path params as `string | string[]`
 * (e.g. duplicate params).  We narrow to string here; anything else is
 * rejected as an invalid id.
 */
function resolveRenderDirOr400(id: string | string[] | undefined, res: any): string | null {
  if (typeof id !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid render id', code: 'INVALID_RENDER_ID' });
    return null;
  }
  try {
    return safeRenderDir(id);
  } catch (err: any) {
    res.status(400).json({ ok: false, error: 'Invalid render id', code: err.code });
    return null;
  }
}

function asStringIdOr400(id: string | string[] | undefined, res: any): string | null {
  if (typeof id !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid render id', code: 'INVALID_RENDER_ID' });
    return null;
  }
  return id;
}

/**
 * FS-002 — read the meta.json for a render and 403 the caller if they're
 * not the owner (and not an admin).  Returns the meta object on success,
 * `null` on 4xx/5xx (after writing the response).  Centralises the
 * per-user gate so every artifact route enforces it identically.
 *
 * Renders without a `createdBy` field were written before FS-002 — only
 * admins can read those directly (the bank listing also hides them from
 * non-admin scopes).  This preserves the principle that user A can never
 * read user B's data even via direct id guess.
 */
async function authorizeRenderRead(req: any, res: any, dir: string): Promise<boolean> {
  const principal = req.principal;
  // Open-access mode (no auth configured) puts principal: { id:'anonymous', admin:true }
  // so this check is a no-op there.
  if (!principal || principal.admin) return true;
  const metaPath = path.join(dir, 'meta.json');
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    // Special-case: the `last` slot is shared globally (legacy behaviour —
    // every render the cockpit makes overwrites it, regardless of user).
    // Keeping it open here preserves existing UI flows.
    if (meta?.id === 'last') return true;
    const owner = meta?.createdBy;
    if (typeof owner === 'string' && owner === principal.id) return true;
    res.status(403).json({
      ok: false,
      code: 'FORBIDDEN',
      message: 'This render belongs to another user',
      hint: 'Use an admin key, or only access renders you authored',
      requestId: req.requestId,
    });
    return false;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      res.status(404).end();
      return false;
    }
    res.status(500).json({ ok: false, code: 'READ_ERROR', error: 'Failed to read meta.json' });
    return false;
  }
}

/**
 * S-015 — read + JSON.parse a file inside the render store, returning typed
 * responses for each failure mode instead of letting a synchronous throw
 * bubble through express:
 *   - 404 if the file does not exist
 *   - 500 with INVALID_JSON code if the file is corrupt (partial write,
 *     concurrent saveRender, etc.) — see S-016 / S-017
 *   - 500 with READ_ERROR code on any other I/O failure
 *
 * fs.readFile is async so a 100MB telemetry file does not block the event
 * loop for every other in-flight request.
 */
async function streamJsonFile(
  filePath: string,
  filename: string,
  res: any,
): Promise<void> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      res.json(JSON.parse(raw));
    } catch (parseErr: any) {
      res.status(500).json({
        ok: false,
        error: `Corrupt ${filename} for this render`,
        code: 'INVALID_JSON',
      });
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      res.status(404).end();
      return;
    }
    res.status(500).json({
      ok: false,
      error: `Failed to read ${filename}`,
      code: 'READ_ERROR',
    });
  }
}

rendersRouter.get("/", (req, res) => {
  // SB-002 humanization — expose the budget snapshot alongside the list
  // so cockpit UIs can show "3.2 GB / 4 GB used" and warn the user BEFORE
  // they queue another render that would fail.
  const budget = getRenderBudgetSnapshot();
  // FS-002 — non-admin keys only see renders they themselves authored.
  // Renders persisted before FS-002 have no `createdBy`; keep them visible
  // to the legacy/admin scope but hide them from per-user listings to avoid
  // accidental cross-user leakage of pre-existing bank entries.
  const all = listRenders();
  const principal = req.principal;
  const filtered =
    !principal || principal.admin
      ? all
      : all.filter((meta) => meta.createdBy === principal.id);
  res.json({ ok: true, renders: filtered, budget });
});

rendersRouter.get("/:id/audio.wav", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  if (!(await authorizeRenderRead(req, res, dir))) return;
  const p = path.join(dir, "audio.wav");
  if (!fs.existsSync(p)) return res.status(404).end();

  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

rendersRouter.get("/:id/meta", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  if (!(await authorizeRenderRead(req, res, dir))) return;
  await streamJsonFile(path.join(dir, "meta.json"), "meta.json", res);
});

rendersRouter.get("/:id/score", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  if (!(await authorizeRenderRead(req, res, dir))) return;
  await streamJsonFile(path.join(dir, "score.json"), "score.json", res);
});

rendersRouter.get("/:id/telemetry", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  if (!(await authorizeRenderRead(req, res, dir))) return;
  await streamJsonFile(path.join(dir, "telemetry.json"), "telemetry.json", res);
});

rendersRouter.get("/:id/provenance", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  if (!(await authorizeRenderRead(req, res, dir))) return;
  await streamJsonFile(path.join(dir, "provenance.json"), "provenance.json", res);
});

const renderPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

rendersRouter.patch("/:id", validateBody(renderPatchSchema), async (req, res) => {
  const id = asStringIdOr400(req.params.id, res);
  if (id === null) return;
  try {
    const dir = safeRenderDir(id);
    if (!(await authorizeRenderRead(req, res, dir))) return;
    const { name, pinned } = req.body as z.infer<typeof renderPatchSchema>;
    if (name === undefined && pinned === undefined) {
      return res.status(400).json({ error: "Missing updates" });
    }
    const updated = updateRenderMeta(id, { name, pinned });
    if (!updated) return res.status(404).json({ error: "Render not found" });
    res.json({ ok: true, meta: updated });
  } catch (err: any) {
    if (err?.code === 'INVALID_RENDER_ID') {
      return res.status(400).json({ ok: false, error: 'Invalid render id' });
    }
    res.status(500).json({ error: err.message });
  }
});

rendersRouter.delete("/:id", async (req, res, next) => {
  const id = asStringIdOr400(req.params.id, res);
  if (id === null) return;
  try {
    const dir = safeRenderDir(id);
    if (!(await authorizeRenderRead(req, res, dir))) return;
    deleteRender(id);
    // SB-002 humanization — return the post-delete budget snapshot so the
    // cockpit can refresh its "store full" banner immediately.
    res.json({ ok: true, budget: getRenderBudgetSnapshot() });
  } catch (err: any) {
    if (err?.code === 'INVALID_RENDER_ID') {
      return next(new HttpError(400, 'INVALID_RENDER_ID', 'Invalid render id', {
        hint: 'Render id must match /^[A-Za-z0-9_-]{1,64}$/',
      }));
    }
    next(err);
  }
});

const promoteLastSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .strict();

rendersRouter.post("/promote-last", validateBody(promoteLastSchema), (req, res) => {
  try {
    const { name } = req.body as z.infer<typeof promoteLastSchema>;
    const lastDir = getRenderDir("last");
    if (!fs.existsSync(lastDir)) return res.status(404).json({ error: "No last render found" });

    // S-016 / R-003 — promote-last must also use ISO timestamp + UUID slug
    // so two concurrent promote-last calls in the same millisecond don't
    // collide on directory name (the same race S-016 fixed in saveRender).
    const createdAt = new Date().toISOString();
    const slug = randomUUID().slice(0, 8);
    let id = `${createdAt.replace(/[:.]/g, "-")}-${slug}`;
    let newDir = getRenderDir(id);
    // Retry once with a fresh slug if EEXIST somehow occurs (very rare given UUID).
    if (fs.existsSync(newDir)) {
      const altSlug = randomUUID().slice(0, 8);
      id = `${createdAt.replace(/[:.]/g, "-")}-${altSlug}`;
      newDir = getRenderDir(id);
    }

    fs.mkdirSync(newDir, { recursive: false });
    fs.cpSync(lastDir, newDir, { recursive: true, force: false, errorOnExist: true });

    const metaPath = path.join(newDir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.id = id;
    meta.name = name || `Untitled-${id}`;
    meta.createdAt = createdAt;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ ok: true, meta });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// S-008: /api/renders POST is just as expensive as /api/render — it MUST be
// rate-limited (mount-level rateLimit in app.ts already provides this) AND
// validated against the same body schema so a malformed/oversized score
// can't trigger the engine.  We import renderBodySchema from ./render so
// both endpoints share one source of truth.
rendersRouter.post(
  "/",
  validateBody(
    z.object({
      name: z.string().trim().min(1).max(200).optional(),
    }).passthrough().and(renderBodySchema)
  ),
  async (req, res, next) => {
    try {
      const { name, score, config } = req.body as any;

      // SB-001 — queue + yield-per-block (see services/renderQueue.ts).
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

      const meta = saveRender({
        name,
        score,
        config,
        telemetry: result.telemetry,
        provenance: result.provenance,
        wavBytes: result.wavBytes,
        durationSec: result.durationSec,
        // FS-002 — attribute the render to the authenticated principal so
        // the bank listing can filter per-user (admins still see all).
        createdBy: req.userId,
      });

      res.json({ ok: true, jobId: queued.jobId, meta });
    } catch (err: any) {
      if (err instanceof RenderBudgetError) {
        return next(new HttpError(err.status, err.code, err.message, { hint: err.hint, details: err.details }));
      }
      if (err?.code === 'PRESET_NOT_FOUND') {
        return next(new HttpError(404, 'PRESET_NOT_FOUND', err.message, {
          hint: `Use one of: ${err.available?.join(', ') || '(none — deploy presets)'}`,
          details: {
            presetId: err.presetId,
            presetDir: err.presetDir,
            available: err.available,
          },
        }));
      }
      if (err?.code === 'INVALID_PRESET_ID') {
        return next(new HttpError(400, 'INVALID_PRESET_ID', err.message, {
          hint: 'presetId must match /^[A-Za-z0-9_-]{1,64}$/',
        }));
      }
      if (err?.code === 'CANCELLED') {
        return next(new HttpError(499, 'RENDER_CANCELLED', 'Render was cancelled', {
          hint: 'Resubmit the render',
        }));
      }
      next(err);
    }
  }
);
