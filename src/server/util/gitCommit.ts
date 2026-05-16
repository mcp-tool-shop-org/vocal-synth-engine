/**
 * S-022 — Capture the git commit ONCE at module load instead of spawning
 * `git rev-parse HEAD` per recording/render.  On Windows the spawn was
 * ~50ms per call; replicated across LiveSession, jamExport, and
 * renderScoreToWav.  All three modules now import GIT_COMMIT from here.
 *
 * Resolution order:
 *   1. process.env.GIT_COMMIT (already used in /api/health and recommended
 *      for prod deployments where the deployed binary lives outside the
 *      repo).
 *   2. `git rev-parse HEAD` invoked once on this module's first import.
 *   3. 'unknown' if neither is available (e.g. the binary is shipped
 *      outside of a git checkout).
 */

import { execSync } from 'node:child_process';

function resolveCommit(): string {
  const envCommit = process.env.GIT_COMMIT?.trim();
  if (envCommit) return envCommit;

  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export const GIT_COMMIT: string = resolveCommit();

/**
 * Back-compat function shape for call sites that previously had a local
 * `getGitCommit()` helper.  Returns the cached value; no spawn cost.
 */
export function getGitCommit(): string {
  return GIT_COMMIT;
}
