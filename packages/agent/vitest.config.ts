import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Some agent tests await child-process IPC microtask settling (fork-runner)
    // or real macrotask flushes between fake-timer ticks (metrics-reporter), plus
    // dynamic `await import()` of the module under test. Under heavy parallel load
    // (e.g. `pnpm -r test`, which oversubscribes the box with ~4 packages x
    // CPU-count worker threads) the default 5s per-test timeout surfaces spurious
    // "test took too long" failures even though the same tests pass in <2s in
    // isolation. Mirrors packages/compiler/vitest.config.ts.
    testTimeout: 15_000,
  },
});
