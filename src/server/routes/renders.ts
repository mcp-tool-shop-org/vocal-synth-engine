import { Router } from "express";
import fs from "fs";
import path from "path";
import { listRenders, getRenderDir, saveRender, updateRenderMeta, deleteRender } from "../storage/renderStore.js";
import { renderScoreToWav } from "../services/renderScoreToWav.js";

export const rendersRouter = Router();

rendersRouter.get("/", (req, res) => {
  res.json({ ok: true, renders: listRenders() });
});

rendersRouter.get("/:id/audio.wav", (req, res) => {
  const p = path.join(getRenderDir(req.params.id), "audio.wav");
  if (!fs.existsSync(p)) return res.status(404).end();

  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(p).pipe(res);
});

rendersRouter.get("/:id/meta", (req, res) => {
  const p = path.join(getRenderDir(req.params.id), "meta.json");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.json(JSON.parse(fs.readFileSync(p, "utf8")));
});

rendersRouter.get("/:id/score", (req, res) => {
  const p = path.join(getRenderDir(req.params.id), "score.json");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.json(JSON.parse(fs.readFileSync(p, "utf8")));
});

rendersRouter.get("/:id/telemetry", (req, res) => {
  const p = path.join(getRenderDir(req.params.id), "telemetry.json");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.json(JSON.parse(fs.readFileSync(p, "utf8")));
});

rendersRouter.get("/:id/provenance", (req, res) => {
  const p = path.join(getRenderDir(req.params.id), "provenance.json");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.json(JSON.parse(fs.readFileSync(p, "utf8")));
});

rendersRouter.patch("/:id", (req, res) => {
  try {
    const { name, pinned } = req.body;
    if (name === undefined && pinned === undefined) return res.status(400).json({ error: "Missing updates" });
    const updated = updateRenderMeta(req.params.id, { name, pinned });
    if (!updated) return res.status(404).json({ error: "Render not found" });
    res.json({ ok: true, meta: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

rendersRouter.delete("/:id", (req, res) => {
  try {
    deleteRender(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

rendersRouter.post("/promote-last", (req, res) => {
  try {
    const { name } = req.body;
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

rendersRouter.post("/", async (req, res) => {
  try {
    const { name, score, config } = req.body ?? {};
    if (!score) throw new Error("Missing score");
    if (!config) throw new Error("Missing config");

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
});
