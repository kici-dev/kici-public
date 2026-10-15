/**
 * `kici reject`: reject a run's held approval gate (requires `--reason`), found
 * by `--job` / `--step` or as the sole pending hold, via the Platform API.
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { resolveHeldRunContext, listHeldRunsForRun, postReject } from './held-run-client.js';
import { resolveHeldRunId } from '@kici-dev/engine';

export interface RejectOptions {
  job?: string;
  /** A step-scoped hold's step index. */
  step?: string;
  /** A hold id: the escape hatch for an ambiguity nothing else resolves (the error lists ids). */
  hold?: string;
  /**
   * `reviewer` / `timer` / `concurrency` / `security`. It separates the two
   * holds of a job with both an SDK `requireApproval` and a security context gate.
   */
  holdType?: string;
  /** Required. */
  reason?: string;
}

export async function rejectCommand(runId: string, options: RejectOptions = {}): Promise<boolean> {
  try {
    if (!options.reason) {
      logger.error(pc.red('A rejection reason is required. Pass --reason <text>.'));
      return false;
    }

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
