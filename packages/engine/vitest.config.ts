import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The public mirror's CI sets CI=true, which turns colored output on.
    // Match it so an assertion on plain text fails here when the output is colored.
    env: { CI: 'true' },
    include: ['src/**/*.test.ts'],
    // Type-level tests (`*.test-d.ts`) run through Vitest's typecheck runner so
    // a removed type returning to a barrel fails the suite. Only `*.test-d.ts`
    // files go through the (slower) tsc-backed runner; regular runtime tests
    // are unaffected.
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
    },
  },
});
