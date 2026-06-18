/**
 * kici reject command
 *
 * Rejects a held approval gate for a run (requires `--reason`). Resolves the
 * held element by `--job` / `--step` (or the sole pending hold), then records
 * the rejection via the Platform dashboard API (PAT auth).
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveHeldRunContext, listHeldRunsForRun, postReject } from './held-run-client.js';
import { resolveHeldRunId } from './held-run-resolve.js';

/** Options for the reject command. */
export interface RejectOptions {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index. */
  step?: string;
  /** Required rejection reason. */
  reason?: string;
}

/**
 * Reject a held approval gate.
 *
 * @param runId - The run whose hold to reject.
 * @param options - Job/step filters plus the required reason.
 * @returns true on success, false on error.
 */
export async function rejectCommand(runId: string, options: RejectOptions = {}): Promise<boolean> {
  try {
    if (!options.reason) {
      logger.error(pc.red('A rejection reason is required. Pass --reason <text>.'));
      return false;
    }

    const ctx = await resolveHeldRunContext();
    if (!ctx) return false;

    const holds = await listHeldRunsForRun(ctx, runId);
    const resolution = resolveHeldRunId(holds, { job: options.job, step: options.step });
    if (!resolution.ok) {
      logger.error(pc.red(resolution.error));
      return false;
    }

    logger.info(`Rejecting held run ${pc.cyan(resolution.heldRunId)} for run ${pc.cyan(runId)}...`);
    const ok = await postReject(ctx, resolution.heldRunId, options.reason);
    if (!ok) return false;

    logger.info(pc.yellow('Rejection recorded. The held element will fail.'));
    return true;
  } catch (error) {
    logger.error(pc.red(`Error: ${toErrorMessage(error)}`));
    return false;
  }
}
