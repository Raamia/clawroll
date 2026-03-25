import { defineConfig } from 'vitest/config';

/**
 * Root config.
 *
 * Test selection lives in `vitest.workspace.ts`, which splits the suite into a parallel
 * "pure" project and a serialised "database" project — see the reasoning there.
 */
export default defineConfig({
  test: {
    // Integration suites start real servers and wait on real drains.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
