/**
 * kici approve — resolve a run's held gate by `--job` / `--step` (or the sole
 * pending hold) and record the approval through the Platform dashboard API (PAT).
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveHeldRunContext, listHeldRunsForRun, postApprove } from './held-run-client.js';
import { resolveHeldRunId } from '@kici-dev/engine';

export interface ApproveOptions {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index. */
  step?: string;
  /**
   * Hold id: the escape hatch for an ambiguity nothing else resolves; the error
   * listing prints the ids.
   */
  hold?: string;
  /**
   * `reviewer` / `timer` / `concurrency` / `security`. Separates the two holds
   * of a job with both an SDK `requireApproval` and a security-typed context gate.
   */
  holdType?: string;
}

/** Returns true on success, false on error. */
export async function approveCommand(
  runId: string,
  options: ApproveOptions = {},
): Promise<boolean> {
  try {
    const ctx = await resolveHeldRunContext();
    if (!ctx) return false;

    const holds = await listHeldRunsForRun(ctx, runId);
    const resolution = resolveHeldRunId(holds, {
      job: options.job,
      step: options.step,
      holdId: options.hold,
      holdType: options.holdType,
    });
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
