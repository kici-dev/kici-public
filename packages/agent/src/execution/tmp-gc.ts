/**
 * Startup garbage collection for this agent's temp-directory families: bare job
 * workdirs (`kici-<6 random chars>`, job-runner.ts), labeled allocator dirs
 * (`kici-<label>-<6 random chars>` from `@kici-dev/core/tmp`, which guarantees
 * the `kici-` prefix) and isolated pnpm stores (`kici-pnpm-store-*`,
 * dep-installer.ts). Each cleans itself up in `finally`, but a hard process
 * death (SIGKILL, OOM kill) skips that, and on a long-lived bare-metal agent
 * the leftovers accumulate forever. Collecting anything older than a day is
 * safe on shared hosts: job timeouts are minutes, so a concurrent agent's
 * in-flight dirs are never eligible.
 */

import { gcStaleTmpDirs } from '@kici-dev/core/tmp-gc';
import { kiciTmpBase, logger } from '@kici-dev/shared';

const AGENT_TMP_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The optional label group makes both bare workdirs and labeled allocator dirs eligible. */
const AGENT_WORKDIR_PATTERN = /^kici-([a-z0-9-]+-)?[A-Za-z0-9]{6}$/;
const PNPM_STORE_PATTERN = /^kici-pnpm-store-/;

/**
 * Persistent caches under the same temp root, often older than a day, that
 * must never be collected. `kici-scaler-ledger` matches the allocator pattern
 * (`ledger` is a 6-char suffix), so a basename exclude, not a regex, is the
 * only correct guard.
 */
const PERSISTENT_CACHES = new Set(['kici-agent-payloads', 'kici-data', 'kici-scaler-ledger']);

/**
 * Never throws; `base` is overridable for tests. The default is
 * `kiciTmpBase()`, not the OS temp root: the temp allocator and payload cache
 * honor `KICI_TMPDIR` through the same helper, so scanning another root would
 * silently stop reaping whenever `KICI_TMPDIR` is set.
 */
export async function gcStaleAgentTmpDirs(base: string = kiciTmpBase()): Promise<string[]> {
  const log = (m: string) => logger.info(m);
  const removed = [
    ...(await gcStaleTmpDirs({
      base,
      pattern: AGENT_WORKDIR_PATTERN,
      maxAgeMs: AGENT_TMP_GC_MAX_AGE_MS,
      exclude: PERSISTENT_CACHES,
      log,
    })),
    ...(await gcStaleTmpDirs({
      base,
      pattern: PNPM_STORE_PATTERN,
      maxAgeMs: AGENT_TMP_GC_MAX_AGE_MS,
      log,
    })),
  ];
  return removed;
}
