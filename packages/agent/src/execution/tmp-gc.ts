/**
 * Startup garbage collection for this agent's own temp-directory families.
 *
 * Job workdirs (`kici-<6 random chars>`, see job-runner.ts) and isolated
 * pnpm stores (`kici-pnpm-store-*`, see dep-installer.ts) clean themselves
 * up in `finally` blocks — but a hard process death (SIGKILL, OOM kill)
 * skips those, and on a long-lived bare-metal agent the leftovers then
 * accumulate forever. Collecting anything older than a day at startup is
 * safe on shared hosts: no job lives remotely that long (job timeouts are
 * minutes), so a concurrent agent's in-flight dirs are never eligible.
 */

import { tmpdir } from 'node:os';
import { gcStaleTmpDirs } from '@kici-dev/core/tmp-gc';
import { logger } from '@kici-dev/shared';

const AGENT_TMP_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** mkdtemp's 6-char suffix on the bare `kici-` prefix — job workdirs only. */
const AGENT_WORKDIR_PATTERN = /^kici-[A-Za-z0-9]{6}$/;
const PNPM_STORE_PATTERN = /^kici-pnpm-store-/;

/**
 * Collect this agent's stale temp dirs. `base` is overridable for tests;
 * production callers use the default temp root. Never throws.
 */
export async function gcStaleAgentTmpDirs(base: string = tmpdir()): Promise<string[]> {
  const log = (m: string) => logger.info(m);
  const removed = [
    ...(await gcStaleTmpDirs({
      base,
      pattern: AGENT_WORKDIR_PATTERN,
      maxAgeMs: AGENT_TMP_GC_MAX_AGE_MS,
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
