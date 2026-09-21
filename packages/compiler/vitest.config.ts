import '../../hack/lib/vitest-isolation.ts';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Several compileFixtures tests do real ESM compilation via the SDK,
    // which can take >5s under heavy parallel load (e.g. `pnpm -r test`).
    // The default 5s timeout surfaces spurious "test took too long" failures
    // even though the same tests pass in <2s in isolation.
    testTimeout: 15_000,
    // Type-level tests (`*.test-d.ts`) run through Vitest's typecheck runner so
    // a lock-file union regaining a removed member fails the suite. Only
    // `*.test-d.ts` files go through the (slower) tsc-backed runner; regular
    // runtime tests are unaffected.
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
    },
  },
  resolve: {
    alias: [
      // Exact-match only: alias the bare barrel specifier to engine source, but
      // let subpath imports (e.g. @kici-dev/engine/protocol/messages/...)
      // resolve through the package's own `exports` map. A bare string key
      // would prefix-match and rewrite a subpath to `index.ts/<subpath>`.
      {
        find: /^@kici-dev\/engine$/,
        replacement: path.resolve(__dirname, '../engine/src/index.ts'),
      },
    ],
  },
});
