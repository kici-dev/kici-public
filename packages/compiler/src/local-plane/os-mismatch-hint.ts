/**
 * Detect when a routed local run cannot match the host OS.
 *
 * The local dev plane satisfies the host's own `kici:os:*` label (the scaler
 * injects the host's derived OS labels into its bare-metal label sets). A job
 * that requests a DIFFERENT OS than the host — e.g. a workflow authored on Linux
 * run on a Mac — matches no local backend and dispatches nothing. This surfaces
 * that as an honest hint instead of a silent "nothing happened".
 */

import { deriveOsArchLabels } from '@kici-dev/engine';

const OS_LABEL_PREFIX = 'kici:os:';

interface RunsOnMatcher {
  kind?: string;
  value?: string;
}
interface LockJob {
  name?: string;
  runsOn?: RunsOnMatcher[];
}
interface LockWorkflow {
  jobs?: LockJob[];
}
interface LockFile {
  workflows?: LockWorkflow[];
}

/**
 * One hint per job whose `runsOn` requires a `kici:os:*` label the host does not
 * provide. Empty when every job either omits an OS selector or requests the
 * host's own OS.
 */
export function detectOsMismatchHints(lock: unknown, platform: string, arch: string): string[] {
  const hostOsLabels = new Set(
    deriveOsArchLabels(platform, arch).filter((l) => l.startsWith(OS_LABEL_PREFIX)),
  );
  const hostPrimary = [...hostOsLabels][0] ?? `${OS_LABEL_PREFIX}${platform}`;
  const hints: string[] = [];

  for (const workflow of (lock as LockFile).workflows ?? []) {
    for (const job of workflow.jobs ?? []) {
      const requestedOs = (job.runsOn ?? [])
        .filter((m) => m.kind === 'exact' && m.value?.startsWith(OS_LABEL_PREFIX))
        .map((m) => m.value as string);
      if (requestedOs.length === 0) continue;
      if (requestedOs.some((l) => hostOsLabels.has(l))) continue;
      hints.push(
        `Job '${job.name ?? 'job'}' wants ${requestedOs.join(', ')} but this host is ` +
          `${platform} — nothing will dispatch locally. Retry with ${hostPrimary} ` +
          `or edit the job's runsOn in .kici/workflows/.`,
      );
    }
  }
  return hints;
}
