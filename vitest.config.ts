import { defineConfig } from 'vitest/config';

/**
 * vitest configuration for @mcptoolshop/vocal-synth-engine.
 *
 * Pins test inclusion globs, timeout policy, and the v8 coverage provider
 * so `npm test`, `npm run test:watch`, and `npm run test:coverage` all
 * produce identical test selection and consistent reporting.
 *
 * Coverage provider (`@vitest/coverage-v8`) must be installed as a devDep
 * for `npm run test:coverage` to work. The provider is OPTIONAL — `npm
 * test` runs without it.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'apps/cockpit/**', 'site/**'],
    environment: 'node',
    // Server / engine integration tests can take longer than the default
    // 5 s (preset load + spawn + render). Pin a generous-but-bounded ceiling.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/cli/**',           // CLI demos are exercised by separate runs
        'src/server/index.*.ts', // bootstrap entrypoints
        'src/types/**',         // pure types
      ],
      // Stage C TSB-003: post-Stage-C ratchet — raise as coverage actually
      // grows. Pre-Stage-C floor was 10 / 10 / 10 / 10 against real
      // coverage of 35.3% stmts / 28.81% branches / 27.84% funcs / 34.71%
      // lines — that meant a refactor could delete 60% of the suite and
      // still pass the gate. The new floors are ~5 points below the
      // measured Stage-A coverage; Stage-C adds (auth, jam, ws-schema,
      // cross-domain) push real coverage materially higher, so these are
      // a safe floor that trips on real test-deletion regressions.
      //
      // NEXT RATCHET (post-Stage-C): once `npm run test:coverage` reports
      // the Stage-C baseline, raise these thresholds again to ~5 points
      // below the new measured floor. The threshold's job is to be just
      // below current — close enough that any meaningful test deletion
      // trips it, never far enough behind to be a paperwork lie.
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 25,
        statements: 30,
      },
    },
  },
});
