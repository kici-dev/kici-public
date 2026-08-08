/**
 * Startup garbage collection for this agent's own temp-directory families.
 *
 * Bare job workdirs (`kici-<6 random chars>`, see job-runner.ts), labeled
 * allocator dirs (`kici-<label>-<6 random chars>`, minted by the global temp
 * allocator `@kici-dev/core/tmp`, which guarantees every allocation carries
 * the `kici-` prefix), and isolated pnpm stores (`kici-pnpm-store-*`, see
 * dep-installer.ts) clean themselves up in `finally` blocks — but a hard
 * process death (SIGKILL, OOM kill) skips those, and on a long-lived
 * bare-metal agent the leftovers then accumulate forever. Collecting anything
 * older than a day at startup is safe on shared hosts: no job lives remotely
 * that long (job timeouts are minutes), so a concurrent agent's in-flight
 * dirs are never eligible.
 *
 * The deterministic persistent caches (`kici-agent-payloads`, `kici-data`,
 * `kici-scaler-ledger`) also live directly under the temp root and can be far
 * older than a day, so they are explicitly excluded — `kici-scaler-ledger`
 * even structurally matches the allocator pattern (`ledger` is a 6-char label
 * suffix), which a regex alone cannot distinguish.
 */

import { gcStaleTmpDirs } from '@kici-dev/core/tmp-gc';
import { kiciTmpBase, logger } from '@kici-dev/shared';

const AGENT_TMP_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Bare `kici-<6 chars>` workdirs and labeled `kici-<label>-<6 chars>`
 * allocator dirs. The optional label group makes both families eligible.
 */
const AGENT_WORKDIR_PATTERN = /^kici-([a-z0-9-]+-)?[A-Za-z0-9]{6}$/;
const PNPM_STORE_PATTERN = /^kici-pnpm-store-/;

/**
 * Deterministic persistent caches that share the `kici-` prefix but must
 * never be collected — `kici-scaler-ledger` even matches the allocator
 * pattern, so a basename exclude (not a regex) is the only correct guard.
 */
const PERSISTENT_CACHES = new Set(['kici-agent-payloads', 'kici-data', 'kici-scaler-ledger']);

/**
 * Collect this agent's stale temp dirs. `base` is overridable for tests;
 * production callers use the default temp root. Never throws.
 *
 * The default base is `kiciTmpBase()`, not the OS temp root, so it scans the
 * exact directory the agent now writes payloads/clones/pnpm stores into: the
 * global temp allocator and the payload cache both honor `KICI_TMPDIR` via the
 * same helper. If the GC scanned a different root, stale-temp reaping would
 * silently stop working whenever `KICI_TMPDIR` is set.
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
