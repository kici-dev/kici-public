/** kici runs rerun — re-trigger a run (mirrors the dashboard rerun button). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { resolveRunRef } from './run-ref.js';

export interface RunsRerunOptions {
  json?: boolean;
}

export async function runsRerunCommand(
  runRef: string,
  options: RunsRerunOptions = {},
): Promise<boolean> {
  const startedAt = new Date();
  try {
    const client = await DashboardClient.load();
    const runId = await resolveRunRef(client, runRef);
    try {
      const out = await client.rerunRun(runId);
      if (options.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        // A retry of an unconfirmed rerun returns the run the first request started.
        const queued = out.alreadyAccepted
          ? 'Rerun already queued by an earlier request'
          : 'Rerun queued';
        console.log(pc.green(`${queued}: ${pc.bold(out.newRunId)}`));
        console.log(`Follow it with: kici runs show ${out.newRunId}`);
      }
      return true;
    } catch (err) {
      // The orchestrator answers once it accepts the rerun, so a timeout does
      // not mean the rerun failed. A retry could start a second run.
      if (err instanceof DashboardClientError && err.status === 504) {
        logger.warn(
          pc.yellow(
            `Could not confirm that the rerun of ${runId} started: the orchestrator did not ` +
              `answer in time. It may still start. Before you retry, look for it with: ` +
              `kici runs list --trigger rerun --since ${startedAt.toISOString()}`,
          ),
        );
        return false;
      }
      throw err;
    }
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
