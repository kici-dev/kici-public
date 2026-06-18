/** kici runs cancel — cancel a run or all in-progress runs on a branch. */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';

export interface RunsCancelOptions {
  force?: boolean;
  branch?: string;
}

export async function runsCancelCommand(
  runId: string | undefined,
  options: RunsCancelOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    if (options.branch) {
      logger.info(`Cancelling all in-progress runs on branch ${pc.cyan(options.branch)}...`);
      const { cancelledRuns = 0 } = await client.cancelByBranch(options.branch);
      console.log(
        cancelledRuns === 0
          ? pc.yellow(`No in-progress runs found on branch ${options.branch}.`)
          : pc.green(
              `Cancelled ${cancelledRuns} run${cancelledRuns !== 1 ? 's' : ''} on branch ${options.branch}.`,
            ),
      );
      return true;
    }
    if (!runId) {
      logger.error(pc.red('Please provide a run ID or use --branch to cancel by branch.'));
      return false;
    }
    logger.info(`${options.force ? 'Force-cancelling' : 'Cancelling'} run ${pc.cyan(runId)}...`);
    const { cancelledJobs = 0 } = await client.cancelRun(runId, options.force ?? false);
    console.log(
      pc.green(
        `Run ${runId} cancelled (${cancelledJobs} job${cancelledJobs !== 1 ? 's' : ''} affected).`,
      ),
    );
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
