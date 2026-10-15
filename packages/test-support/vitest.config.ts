import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Starts a throwaway PostgreSQL container for the real-Postgres harness
    // tests, but only when the run's selection actually contains one. Shared
    // with the other packages by relative path.
    globalSetup: ['../../scripts/db-test-postgres.ts'],
  },
});
