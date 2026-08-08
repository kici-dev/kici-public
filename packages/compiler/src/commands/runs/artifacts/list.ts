/** kici runs artifacts list — the artifacts a run uploaded (the rows the dashboard Artifacts tab shows). */
import pc from 'picocolors';
import { formatBytes, logger, toErrorMessage } from '@kici-dev/core';
import { DashboardClient, DashboardClientError } from '../../../remote/dashboard-client.js';
import { renderTable, relativeTime } from '../../../remote/render.js';

export interface RunsArtifactsListOptions {
  json?: boolean;
}

/** Number of leading sha-256 hex chars shown in the table (full digest via --json). */
const SHA_PREFIX_LENGTH = 12;

export async function runsArtifactsListCommand(
  runId: string,
  options: RunsArtifactsListOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const result = await client.listArtifacts(runId);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return true;
    }
    if (result.artifacts.length === 0) {
      console.log(pc.gray('No artifacts for this run.'));
      return true;
    }
    const rows = result.artifacts.map((a) => [
      a.name,
      a.jobId,
      formatBytes(a.sizeBytes),
      a.sha256.slice(0, SHA_PREFIX_LENGTH),
      relativeTime(a.createdAt),
      a.downloadUrl ? '' : pc.yellow('unavailable'),
    ]);
    console.log(renderTable(['name', 'job', 'size', 'sha-256', 'created', ''], rows));
    console.log(
      pc.gray(
        `\n${result.artifacts.length} artifact(s). ` +
          `Download with kici runs artifacts download ${runId} <name>`,
      ),
    );
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
