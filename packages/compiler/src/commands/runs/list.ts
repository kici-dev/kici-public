/** `kici runs list`: mirrors the dashboard Runs page list. */
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
      // Show recent webhook activity, so an "almost there" evaluator sees
      // webhooks arrived but nothing matched, plus how to test triggers locally.
      const activity = await client.getWebhookActivity();
      if (activity.received > 0) {
        const win =
          activity.windowMinutes === 60
            ? 'the last hour'
            : `the last ${activity.windowMinutes} minutes`;
        // Mirrors the dashboard strip: "N received in <win>, M matched", or with
        // no matched count, "N received in <win> but none produced a run".
        const headline =
          activity.orchestratorUnavailable || activity.matched === undefined
            ? `${activity.received} webhooks received in ${win} but none produced a run`
            : `${activity.received} webhooks received in ${win}, ${activity.matched} matched`;
        console.log(pc.yellow(`${headline}.`));
        console.log(pc.gray(`Run ${pc.cyan('kici preview push')} to test your triggers locally.`));
      } else {
        console.log(pc.gray('No runs found.'));
      }
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
        `\n${page.runs.length} of ~${page.approxTotal} runs${
          page.nextCursor ? `  (more — use --cursor ${page.nextCursor})` : ''
        }`,
      ),
    );
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
