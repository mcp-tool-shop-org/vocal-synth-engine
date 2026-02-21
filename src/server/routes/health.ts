import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (req, res) => {
  res.json({
    ok: true,
    version: process.env.APP_VERSION ?? "dev",
    commit: process.env.GIT_COMMIT ?? "unknown",
    node: process.version,
  });
});
