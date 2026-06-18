/** kici runs rerun — re-trigger a run (mirrors the dashboard rerun button). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';

export interface RunsRerunOptions {
  json?: boolean;
}

export async function runsRerunCommand(
  runId: string,
  options: RunsRerunOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const out = await client.rerunRun(runId);
    if (options.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(pc.green(`Rerun queued: ${pc.bold(out.newRunId)}`));
    }
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
