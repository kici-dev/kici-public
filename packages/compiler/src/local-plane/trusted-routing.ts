/**
 * `--trusted` appends `self-hosted` to every job's `runsOn` in the workdir lock;
 * only the trusted label set carries it (the scaler matcher does subset match,
 * smallest set wins). A default run leaves the lock byte-identical. The patch
 * adds a label requirement, never the trusted flag: `KICI_TRUSTED_ENV` lives
 * only in the plane's own label-set env, never on a dispatch payload.
 */

import fs from 'node:fs';

interface RunsOnMatcher {
  kind: string;
  value?: string;
}

interface LockJob {
  runsOn?: RunsOnMatcher[];
  [k: string]: unknown;
}

interface LockWorkflow {
  jobs?: LockJob[];
  [k: string]: unknown;
}

interface LockFile {
  workflows?: LockWorkflow[];
  [k: string]: unknown;
}

export interface RunsOnLabelInjection {
  /** Rewrites the pre-patch bytes. */
  restore: () => void;
}

/**
 * Call `restore()` in a `finally`: for an in-place run it un-dirties the
 * developer's tree (an isolated clone is removed anyway).
 */
export function injectRunsOnLabel(lockPath: string, label: string): RunsOnLabelInjection {
  const original = fs.readFileSync(lockPath, 'utf-8');
  const lock = JSON.parse(original) as LockFile;

  for (const workflow of lock.workflows ?? []) {
    for (const job of workflow.jobs ?? []) {
      const runsOn = (job.runsOn ??= []);
      const already = runsOn.some((m) => m.kind === 'exact' && m.value === label);
      if (!already) runsOn.push({ kind: 'exact', value: label });
    }
  }

  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

  return {
    restore: () => {
      fs.writeFileSync(lockPath, original);
    },
  };
}
