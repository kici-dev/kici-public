/**
 * The restore-or-fall-back policy every job kind shares (runner child, init
 * jobs, dynamic evaluations, global evaluation rounds).
 *
 * - A hash mismatch fails the job: installing over it would hide a corrupted or
 *   tampered cache behind a green run.
 * - Any other failure (download, extraction, an unsupported URL) is logged and
 *   the caller installs inline, so a cache problem costs time, never the run.
 */

import { restoreDeps, type DepRestoreLimits } from './dep-restore.js';
import { DepRestoreError, DepTarballHashMismatchError } from './dep-restore-errors.js';
import { formatRestoredLine, type DepRestoreReport } from './dep-restore-report.js';

export interface TryRestoreDepsArgs {
  workDir: string;
  depsUrl: string;
  depsHash?: string;
  /** Run-log sink for the job's setup output. */
  log: (line: string) => void;
  /** Receives the restore's report, on success and on failure. */
  onReport?: (report: DepRestoreReport) => void;
  limits?: Partial<DepRestoreLimits>;
}

/** `false` when the caller must install inline; rejects only on a hash mismatch. */
export async function tryRestoreDeps(args: TryRestoreDepsArgs): Promise<boolean> {
  try {
    const report = await restoreDeps(args.workDir, args.depsUrl, args.depsHash, {
      limits: args.limits,
      onProgress: args.log,
    });
    args.onReport?.(report);
    args.log(formatRestoredLine(report));
    return true;
  } catch (err) {
    if (err instanceof DepRestoreError) args.onReport?.(err.report);
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DepTarballHashMismatchError) {
      args.log(`${message}; failing the job instead of installing over a corrupted cache entry`);
      throw err;
    }
    args.log(`Cache restore failed (${message}), falling back to inline install`);
    return false;
  }
}
