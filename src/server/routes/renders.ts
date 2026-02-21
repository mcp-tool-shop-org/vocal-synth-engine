import { Router } from "express";
import fs from "fs";
import path from "path";
import { listRenders, getRenderDir, saveRender, updateRenderName, deleteRender } from "../storage/renderStore.js";
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

rendersRouter.patch("/:id", (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });
    const updated = updateRenderName(req.params.id, name);
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
