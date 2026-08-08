import '../../hack/lib/vitest-isolation.ts';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve the package's own name to source so a dogfood test that imports the
  // public specifier (`@kici-dev/sdk/testing`) exercises the current working
  // tree rather than a prebuilt `dist/`. Without this, the self-referencing
  // import would resolve through the package `exports` map to `dist/` and fail
  // whenever the SDK has not been built. The built-`dist/` path stays covered by
  // the build check + the devex E2E test.
  resolve: {
    alias: {
      '@kici-dev/sdk/testing': fileURLToPath(new URL('./src/testing/index.ts', import.meta.url)),
      '@kici-dev/sdk': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Type-level tests (`*.test-d.ts`) run through Vitest's typecheck runner so
    // a type regression in the public event-payload union fails the suite. Only
    // `*.test-d.ts` files go through the (slower) tsc-backed runner; regular
    // runtime tests are unaffected.
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
    },
  },
});
