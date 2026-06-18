/** kici runs show — run summary + jobs/steps tree (replaces `kici status`). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import type { RunListItem, DashboardJobDetail } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { colorStatus, relativeTime, formatDuration } from '../../remote/render.js';
import { RunHistory } from '../../remote/history.js';

export interface RunsShowOptions {
  json?: boolean;
}

export async function runsShowCommand(
  runId: string,
  options: RunsShowOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    let run: RunListItem;
    try {
      run = await client.getRun(runId);
    } catch (err) {
      if (err instanceof DashboardClientError && err.kind === 'not_found') {
        return await showLocalFallback(runId, options.json ?? false);
      }
      throw err;
    }
    const detail = await client.getRunDetail(runId);
    if (options.json) {
      console.log(JSON.stringify({ run, detail }, null, 2));
      return true;
    }
    printHeader(run);
    printJobs(detail.jobs);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

function printHeader(run: RunListItem): void {
  const f = (v: string | undefined | null): string => (v == null ? '—' : v);
  console.log(pc.bold(`\nRun ${run.runId}`) + `  ${colorStatus(run.status)}`);
  console.log(
    pc.gray(
      `  workflow=${f(run.workflowName)} repo=${f(run.repoIdentifier)} branch=${f(run.ref)} ` +
        `sha=${f(run.sha)} trigger=${f(run.triggerEvent)} by=${f(run.triggeredBy)}`,
    ),
  );
  console.log(pc.gray(`  started=${relativeTime(run.startedAt ?? undefined)}`));
}

function printJobs(jobs: DashboardJobDetail[]): void {
  for (const j of jobs) {
    console.log(
      `\n  ${pc.bold(j.jobName)} ${colorStatus(j.status)} ` +
        pc.gray(j.durationMs ? formatDuration(j.durationMs) : ''),
    );
    for (const s of j.steps ?? []) {
      console.log(
        pc.gray('    └─ ') +
          `${s.stepName} ${colorStatus(s.status)} ` +
          pc.gray(
            `${s.durationMs ? formatDuration(s.durationMs) : ''}` +
              `${s.exitCode != null ? ` exit=${s.exitCode}` : ''}`,
          ),
      );
    }
  }
}

async function showLocalFallback(runId: string, json: boolean): Promise<boolean> {
  const history = new RunHistory();
  await history.load();
  const entry = history.getEntry(runId);
  if (!entry) {
    logger.error(pc.red(`Run not found: ${runId} (no remote run and no local history).`));
    return false;
  }
  if (json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    logger.info(pc.yellow('Run not found on the Platform. Showing local history:\n'));
    console.log(JSON.stringify(entry, null, 2));
  }
  return true;
}
