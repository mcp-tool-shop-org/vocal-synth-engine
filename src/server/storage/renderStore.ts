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
  summary?: {
    polyphony?: number;
    deterministic?: string;
    bpm?: number;
    preset?: string;
  };
};

const root = path.resolve(process.cwd(), ".vscockpit/renders");

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

  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return metas;
}

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

export function updateRenderName(id: string, name: string) {
  const metaPath = path.join(getRenderDir(id), "meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.name = name;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }
  return null;
}

export function deleteRender(id: string) {
  const dir = getRenderDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
