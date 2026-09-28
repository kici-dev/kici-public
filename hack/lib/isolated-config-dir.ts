/**
 * The isolated KICI_CONFIG_DIR every vitest process in this repository runs
 * with, and its removal.
 *
 * `vitest-isolation.ts` calls `isolateConfigDir()` at config-evaluation time.
 * It fills KICI_CONFIG_DIR only when the run has not named one, and removes the
 * directory it created when the process exits, whatever a test wrote into it.
 * A process killed before its exit handler runs still leaves one behind; a
 * cleanup job recognises it by `TEST_CONFIG_DIR_NAME_RE`, so the name lives here
 * as a constant rather than as a literal at each end.
 *
 * Side-effect free, unlike `vitest-isolation.ts`, so a cleanup job can import it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_CONFIG_DIR_PREFIX = 'kici-test-config-';

/** `mkdtemp` appends six characters of `[A-Za-z0-9]` to the prefix. */
export const TEST_CONFIG_DIR_NAME_RE = /^kici-test-config-[A-Za-z0-9]{6}$/;

/**
 * Point `env.KICI_CONFIG_DIR` at a fresh, empty directory under `tmpRoot`
 * unless it already names one, and register the removal of that directory.
 * Returns the directory it created, or undefined when it created none.
 */
export function isolateConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  tmpRoot: string = os.tmpdir(),
  onExit: (fn: () => void) => void = (fn) => process.once('exit', fn),
): string | undefined {
  if (env.KICI_CONFIG_DIR) return undefined;
  const dir = fs.mkdtempSync(path.join(tmpRoot, TEST_CONFIG_DIR_PREFIX));
  env.KICI_CONFIG_DIR = dir;
  onExit(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort, like every other test-temp cleanup here: a throw from an
      // `exit` listener would turn a passing run into exit code 1, and a
      // cleanup job reaps what is left.
    }
  });
  return dir;
}
