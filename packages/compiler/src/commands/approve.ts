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
import { resolveHeldRunId } from '@kici-dev/engine';

/** Options for the approve command. */
export interface ApproveOptions {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index. */
  step?: string;
  /**
   * Match one hold by its own id. The escape hatch for an ambiguity nothing
   * else resolves; the error listing prints the ids when it needs to.
   */
  hold?: string;
  /**
   * Narrow to holds of one type (`reviewer` / `timer` / `concurrency` /
   * `security`). A job carrying an SDK `requireApproval` AND a security-typed
   * context gate has two pending holds under one job name, and this is what
   * separates them.
   */
  holdType?: string;
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
