import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts a throwaway PostgreSQL container and points the real-Postgres
    // suites at it, but only when the run's selection actually contains one.
    // Shared with the Platform package by relative path rather than by an
    // import, so neither package depends on the other's code.
    globalSetup: ['../../scripts/db-test-postgres.ts'],
    testTimeout: 10000,
    server: {
      deps: {
        external: ['hashi-vault-js'],
      },
    },
  },
});
