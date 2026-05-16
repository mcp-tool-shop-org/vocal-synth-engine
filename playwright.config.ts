/**
 * Playwright config for cockpit browser tests.
 *
 * Tests live under `apps/cockpit/tests/`. They spin up the Vite dev server
 * via `webServer` and load index.html in a chromium browser.
 *
 * Why a single browser (chromium): the cockpit ships a vanilla Web Audio +
 * WebSocket + canvas-free DOM UI — there's no per-browser polyfill drift
 * to catch. Cross-browser would triple CI minutes for near-zero signal.
 * If Firefox-specific Web Audio quirks bite later, add the `firefox`
 * project then.
 *
 * Decision (FTC-002): cockpit tests live at `apps/cockpit/tests/` and
 * are invoked via `npm run test:cockpit` from the repo root. They are
 * NOT pulled into `npm test` (vitest excludes apps/cockpit/**) because
 * Playwright tests need browser-install + a running webserver which is
 * heavier than the vitest gate should be. CI runs them as a separate
 * `cockpit-tests` job.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/cockpit/tests',
  // We don't need the file pattern to match `*.spec.ts` strictly — keep
  // it permissive so test files can be either *.test.ts or *.spec.ts.
  testMatch: /.*\.(test|spec)\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    // Vite dev server URL — set explicitly so tests can use page.goto('/').
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm --prefix apps/cockpit run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    // Vite cold-start on CI runners can be slow.
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
