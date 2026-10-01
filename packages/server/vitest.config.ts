import { defineConfig } from 'vitest/config';
import { workspaceSrcAliases } from '../../tests/setup/workspace-src-aliases.ts';
import { MAX_WORKERS, TEST_TIMEOUT_MS } from '../../vitest.shared.ts';

export default defineConfig({
  // Workspace imports resolve to src, never to gitignored dist/ (mirrors the root config; a
  // package-local vitest run inherits nothing from it). See tests/setup/workspace-src-aliases.ts.
  resolve: { alias: workspaceSrcAliases },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Inherited from nothing: a package-local run reads only THIS file, so the root's tuned
    // ceiling never reached `pnpm -r test`. See vitest.shared.ts for the measurement.
    testTimeout: TEST_TIMEOUT_MS,
    // A beforeEach that opens the PGlite double pays the worker's first migration; same ceiling.
    hookTimeout: TEST_TIMEOUT_MS,
    maxWorkers: MAX_WORKERS,
    pool: 'forks',
    env: { MUSTERD_SILENT: '1' },
  },
});
