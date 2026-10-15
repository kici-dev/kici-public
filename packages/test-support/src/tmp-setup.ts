/**
 * The per-file half of the temp-directory cleanup contract in `tmp.ts`.
 *
 * Named in the `setupFiles` of each vitest config that adopts it, so vitest
 * evaluates it once per test file and the `afterAll` below attaches to that file's root
 * suite. That is what covers a directory created at module scope or in a
 * `beforeAll`, where `onTestFinished` has no test to attach to.
 *
 * It lives here rather than in `vitest-isolation.ts` because the two run in
 * different places: the isolation module is imported while the config is
 * evaluated, in the main vitest process, where no test runtime exists and a
 * hook cannot be registered. It cannot be a top-level `afterAll` inside
 * `tmp.ts` either — ESM caches that module, so the hook would attach only
 * to whichever test file imported it first in a given worker.
 */
import { afterAll } from 'vitest';

import { cleanupTestTempDirs } from './tmp.js';

afterAll(cleanupTestTempDirs);
