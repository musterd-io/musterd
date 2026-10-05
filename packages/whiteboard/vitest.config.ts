import { defineConfig } from 'vitest/config';

// Without this file vitest would read vite.config.ts, whose `root: 'web'` (the browser page
// build) hides every src/**/*.test.ts. Tests are node-side; the web page is build-only.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    // The service picks Squig whenever a checkout exists on the machine (ADR 524); the suite
    // must not depend on what a laptop has installed. Squig tests opt in explicitly.
    env: { WHITEBOARD_PROVIDER: 'tldraw' },
  },
});
