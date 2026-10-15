/**
 * The local plane offers only the host's own `kici:os:*` labels (the scaler
 * injects them into its bare-metal label sets), so a job requesting another OS
 * dispatches nothing. This turns that silence into a hint.
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

/** One hint per job whose `runsOn` requires a `kici:os:*` label the host lacks. */
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
