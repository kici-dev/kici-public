/**
 * Route a `kici run --local --trusted` run onto the plane's trusted label set
 * by appending a routing label to every job's `runsOn` in the workdir lock the
 * plane orchestrator reads.
 *
 * The orchestrator resolves each job's target agent from the lock's `runsOn`
 * selectors (subset match + smallest-set-wins in the scaler label matcher).
 * A default run leaves `runsOn` untouched, so a `runsOn: ['default']` job lands
 * on the sandboxed `['default']` label set — byte-identical to a non-trusted
 * run. `--trusted` appends the non-reserved `self-hosted` label, which only the
 * trusted `['default','self-hosted']` label set carries, forcing every job onto
 * the trusted profile.
 *
 * This is routing-by-label to a PRE-CONFIGURED trusted scaler label set — the
 * `KICI_TRUSTED_ENV` value lives only in that label set's env (the plane's own
 * config), never on a dispatch payload. The lock patch adds a label
 * requirement, not the trusted flag itself.
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

/** Handle to restore the lock to its pre-patch bytes. */
export interface RunsOnLabelInjection {
  /** Rewrite the original bytes captured before the patch. */
  restore: () => void;
}

/**
 * Append an exact-match `runsOn` selector for `label` to every job in the lock
 * at `lockPath`, unless the job already requires it. Returns a `restore()` that
 * rewrites the original file bytes (call it in a `finally` — for an in-place run
 * it un-dirties the developer's tree; for an isolated run the throwaway clone is
 * removed anyway).
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
