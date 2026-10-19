import { defineConfig } from 'vitest/config';
import { TEST_TIMEOUT_MS } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: TEST_TIMEOUT_MS,
    pool: 'forks',
  },
});
