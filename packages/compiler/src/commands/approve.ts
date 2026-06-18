/**
 * kici approve command
 *
 * Approves a held approval gate for a run. Resolves the held element by
 * `--job` / `--step` (or the sole pending hold), then records the approval via
 * the Platform dashboard API (PAT auth).
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveHeldRunContext, listHeldRunsForRun, postApprove } from './held-run-client.js';
import { resolveHeldRunId } from './held-run-resolve.js';

/** Options for the approve command. */
export interface ApproveOptions {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index. */
  step?: string;
}

/**
 * Approve a held approval gate.
 *
 * @param runId - The run whose hold to approve.
 * @param options - Job/step filters to disambiguate the held element.
 * @returns true on success, false on error.
 */
export async function approveCommand(
  runId: string,
  options: ApproveOptions = {},
): Promise<boolean> {
  try {
    const ctx = await resolveHeldRunContext();
    if (!ctx) return false;

    const holds = await listHeldRunsForRun(ctx, runId);
    const resolution = resolveHeldRunId(holds, { job: options.job, step: options.step });
    if (!resolution.ok) {
      logger.error(pc.red(resolution.error));
      return false;
    }

    logger.info(`Approving held run ${pc.cyan(resolution.heldRunId)} for run ${pc.cyan(runId)}...`);
    const ok = await postApprove(ctx, resolution.heldRunId);
    if (!ok) return false;

    logger.info(pc.green('Approval recorded.'));
    logger.info(
      pc.dim(
        'If the requirement still has unsatisfied clauses, the run stays held until they are.',
      ),
    );
    return true;
  } catch (error) {
    logger.error(pc.red(`Error: ${toErrorMessage(error)}`));
    return false;
  }
}
