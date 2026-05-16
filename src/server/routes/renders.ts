import { Router } from "express";
import fs from "fs";
import path from "path";
import { z } from "zod";
import {
  listRenders,
  getRenderDir,
  saveRender,
  updateRenderMeta,
  deleteRender,
  safeRenderDir,
} from "../storage/renderStore.js";
import { renderScoreToWav } from "../services/renderScoreToWav.js";
import { validateBody } from "../middleware/validate.js";
import { renderBodySchema } from "./render.js";

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

rendersRouter.get("/", (_req, res) => {
  res.json({ ok: true, renders: listRenders() });
});

rendersRouter.get("/:id/audio.wav", (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  const p = path.join(dir, "audio.wav");
  if (!fs.existsSync(p)) return res.status(404).end();

  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

rendersRouter.get("/:id/meta", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  await streamJsonFile(path.join(dir, "meta.json"), "meta.json", res);
});

rendersRouter.get("/:id/score", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  await streamJsonFile(path.join(dir, "score.json"), "score.json", res);
});

rendersRouter.get("/:id/telemetry", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  await streamJsonFile(path.join(dir, "telemetry.json"), "telemetry.json", res);
});

rendersRouter.get("/:id/provenance", async (req, res) => {
  const dir = resolveRenderDirOr400(req.params.id, res);
  if (!dir) return;
  await streamJsonFile(path.join(dir, "provenance.json"), "provenance.json", res);
});

const renderPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

rendersRouter.patch("/:id", validateBody(renderPatchSchema), (req, res) => {
  const id = asStringIdOr400(req.params.id, res);
  if (id === null) return;
  try {
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

rendersRouter.delete("/:id", (req, res) => {
  const id = asStringIdOr400(req.params.id, res);
  if (id === null) return;
  try {
    deleteRender(id);
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.code === 'INVALID_RENDER_ID') {
      return res.status(400).json({ ok: false, error: 'Invalid render id' });
    }
    res.status(500).json({ error: err.message });
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

    const createdAt = new Date().toISOString();
    const id = createdAt.replace(/[:.]/g, "-");
    const newDir = getRenderDir(id);

    fs.cpSync(lastDir, newDir, { recursive: true });

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
  async (req, res) => {
    try {
      const { name, score, config } = req.body as any;

      const result = await renderScoreToWav({ score, config });

      const meta = saveRender({
        name,
        score,
        config,
        telemetry: result.telemetry,
        provenance: result.provenance,
        wavBytes: result.wavBytes,
        durationSec: result.durationSec,
      });

      res.json({ ok: true, meta });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err) });
    }
  }
);
