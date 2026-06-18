/**
 * Resolve the writable base directory for orchestrator-local data (execution
 * log storage, cache).
 *
 * A system-level orchestrator owns `/var/lib/kici`; a user-level install
 * (e.g. `kici-admin orchestrator install --user-level`) does not and cannot
 * write there. Mirrors the scaler-ledger resolution in machine-ledger.ts so
 * both pieces of orchestrator state degrade the same way: explicit override →
 * `/var/lib/kici` if writable → XDG state dir → tmpdir.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Return the first candidate directory that can be created and written to.
 *
 * Each candidate is `mkdir -p`'d and probed with a sentinel write (removed
 * immediately) so "exists but not writable" is caught the same as "cannot be
 * created". Throws if none are usable.
 */
export function firstWritableDir(candidates: string[]): string {
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const sentinel = join(dir, `.write-probe-${process.pid}`);
      writeFileSync(sentinel, 'probe');
      rmSync(sentinel, { force: true });
      return dir;
    } catch {
      continue;
    }
  }
  throw new Error(`data-dir: no writable directory among candidates: ${candidates.join(', ')}`);
}

/**
 * Resolve the orchestrator data root.
 *
 * 1. `explicit` (KICI_DATA_DIR) wins — created if missing.
 * 2. `/var/lib/kici` if writable (system-level install).
 * 3. `${XDG_STATE_HOME:-$HOME/.local/state}/kici` (user-level install).
 * 4. `${tmpdir}/kici-data` (last resort, e.g. CI sandboxes).
 *
 * Callers append their own subdir (e.g. `${dataDir}/cache/logs`).
 */
export function resolveDataDir(explicit: string | undefined): string {
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return firstWritableDir(['/var/lib/kici', join(xdgState, 'kici'), join(tmpdir(), 'kici-data')]);
}
