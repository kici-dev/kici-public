import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The public mirror's CI sets CI=true, which turns colored output on.
    // Match it so an assertion on plain text fails here when the output is colored.
    env: { CI: 'true' },
    include: ['src/**/*.test.ts'],
    // Starts a throwaway PostgreSQL container and points the real-Postgres
    // suites at it, but only when the run's selection actually contains one.
    // Shared with the orchestrator and Platform packages by relative path.
    globalSetup: ['../../scripts/db-test-postgres.ts'],
  },
});
