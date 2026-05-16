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
      // Conservative starting threshold given current coverage scope.
      // Intent is to grow this as the suite expands.
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 10,
        statements: 10,
      },
    },
  },
});
