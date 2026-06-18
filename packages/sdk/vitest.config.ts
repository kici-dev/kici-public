import { defineConfig } from 'vitest/config';

export default defineConfig({
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
