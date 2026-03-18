import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Game-logic suites are pure and deterministic, so they parallelise freely.
    // Suites that touch Postgres opt out per-file with `describe.sequential`.
    pool: 'threads',
  },
});
