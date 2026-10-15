/**
 * Temp directories for the test suites: one shared parent, cleanup by
 * default.
 *
 * Two properties, both of which a bare `mkdtempSync(join(tmpdir(), prefix))`
 * lacks:
 *
 *  1. **One parent.** Every tree lands under `TEST_TMP_ROOT`, so the host's
 *     leak sweeper needs a single tight pattern instead of one per suite. The
 *     caller's readable prefix is preserved inside it —
 *     `/tmp/kici-test/drain-rules-a7f3k2` — so a tree left behind by a run that
 *     was killed mid-test still names the suite that made it.
 *  2. **Registered cleanup.** `makeTempDir` registers the tree itself. A suite
 *     cannot leak by forgetting an `afterEach`, because there is nothing for
 *     the author to remember.
 *
 * Cleanup fires from whichever of these comes first:
 *
 *  - `onTestFinished`, when the call happens inside a test or a `beforeEach` —
 *    the tree goes away as soon as that test ends, pass or throw.
 *  - `cleanupTestTempDirs()`, run by `tmp-setup.ts` in an `afterAll` that a
 *    vitest config installs through `setupFiles` (`hack/vitest.config.ts`
 *    does). It covers a directory made at module scope or in `beforeAll`,
 *    where no test context exists to attach to.
 *  - a `process.on('exit')` handler, for a worker that ends without running
 *    hooks at all.
 *
 * The registry is per module instance, and every directory name comes from
 * `mkdtempSync`, so parallel workers neither see nor remove each other's trees.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * The parent's name inside the system temp directory. The host leak sweeper
 * matches on this, so it is a constant here rather than a literal at each end.
 */
export const TEST_TMP_DIR_NAME = 'kici-test';

/** The single parent every test temp directory lives under. */
export const TEST_TMP_ROOT = path.join(tmpdir(), TEST_TMP_DIR_NAME);

/** Trees created but not yet removed, in this module instance. */
const pending = new Set<string>();

function remove(dir: string): void {
  pending.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A tree a test deliberately made unreadable, or one a concurrent sweep
    // already took. Cleanup is best-effort by design: throwing here would turn
    // a housekeeping failure into a test failure.
  }
}

/**
 * Create a temp directory under {@link TEST_TMP_ROOT} and register its removal.
 *
 * `prefix` is the readable suite marker, e.g. `'drain-rules-'`. It must be a
 * single path segment — a prefix containing a separator would place the tree
 * outside the parent and defeat the whole arrangement.
 */
export function makeTempDir(prefix: string): string {
  if (prefix.length === 0) throw new Error('test temp prefix must not be empty');
  if (prefix.includes('/') || prefix.includes(path.sep) || prefix.includes('\0')) {
    throw new Error(`test temp prefix must be a single path segment: ${JSON.stringify(prefix)}`);
  }

  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
  pending.add(dir);

  try {
    onTestFinished(() => remove(dir));
  } catch {
    // No test is running — the call came from module scope or `beforeAll`. The
    // `afterAll` in `tmp-setup.ts` and the exit handler below still cover
    // it; only the moment of removal differs.
  }

  return dir;
}

/** Remove every tree this module instance still holds. */
export function cleanupTestTempDirs(): void {
  for (const dir of [...pending]) remove(dir);
}

process.on('exit', cleanupTestTempDirs);
