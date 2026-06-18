/** kici runs list — mirrors the dashboard Runs page list. */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import {
  DashboardClient,
  DashboardClientError,
  type RunsListFilters,
} from '../../remote/dashboard-client.js';
import { renderTable, colorStatus, relativeTime, formatDuration } from '../../remote/render.js';

export interface RunsListOptions extends RunsListFilters {
  json?: boolean;
}

export async function runsListCommand(options: RunsListOptions = {}): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const { json, ...filters } = options;
    const page = await client.listRuns(filters);
    if (json) {
      console.log(JSON.stringify(page, null, 2));
      return true;
    }
    if (page.runs.length === 0) {
      console.log(pc.gray('No runs found.'));
      return true;
    }
    const rows = page.runs.map((r) => [
      r.runId,
      r.workflowName ?? '—',
      colorStatus(r.status),
      r.ref ?? '—',
      r.triggerEvent ?? '—',
      relativeTime(r.startedAt ?? undefined),
      r.durationMs ? formatDuration(r.durationMs) : '—',
    ]);
    console.log(
      renderTable(
        ['run-id', 'workflow', 'status', 'branch', 'trigger', 'started', 'duration'],
        rows,
      ),
    );
    console.log(
      pc.gray(
        `\nPage ${page.page} · ${page.runs.length} of ${page.total}${
          page.hasMore ? ' (more — use --page)' : ''
        }`,
      ),
    );
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
