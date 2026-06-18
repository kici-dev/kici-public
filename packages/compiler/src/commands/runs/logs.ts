/** kici runs logs — step logs for a run (replaces `kici status --logs`). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { TERMINAL_RUN_STATES, type DashboardJobDetail } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { colorStatus } from '../../remote/render.js';

export interface RunsLogsOptions {
  job?: string;
  follow?: boolean;
  json?: boolean;
}

const POLL_INTERVAL_MS = 2000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runsLogsCommand(
  runId: string,
  options: RunsLogsOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    if (options.json) {
      const detail = await client.getRunDetail(runId);
      const out = await collectAllLogs(client, runId, detail.jobs, options.job);
      console.log(JSON.stringify(out, null, 2));
      return true;
    }
    if (options.follow) {
      return await followLogs(client, runId, options.job);
    }
    const detail = await client.getRunDetail(runId);
    await printAllLogs(client, runId, detail.jobs, options.job);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

function selectJobs(jobs: DashboardJobDetail[], jobFilter?: string): DashboardJobDetail[] {
  return jobFilter ? jobs.filter((j) => j.jobName === jobFilter) : jobs;
}

async function printAllLogs(
  client: DashboardClient,
  runId: string,
  jobs: DashboardJobDetail[],
  jobFilter?: string,
): Promise<void> {
  for (const j of selectJobs(jobs, jobFilter)) {
    for (const s of j.steps ?? []) {
      console.log(
        pc.bold(`\n=== ${j.jobName} › ${s.stepName} `) + colorStatus(s.status) + pc.bold(' ==='),
      );
      const logs = await client.getStepLogs(runId, j.jobId, s.stepIndex);
      for (const line of logs.lines) console.log(line);
    }
  }
}

async function collectAllLogs(
  client: DashboardClient,
  runId: string,
  jobs: DashboardJobDetail[],
  jobFilter?: string,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const j of selectJobs(jobs, jobFilter)) {
    for (const s of j.steps ?? []) {
      out[`${j.jobName}/${s.stepName}`] = (
        await client.getStepLogs(runId, j.jobId, s.stepIndex)
      ).lines;
    }
  }
  return out;
}

async function followLogs(
  client: DashboardClient,
  runId: string,
  jobFilter?: string,
): Promise<boolean> {
  const printed: Record<string, number> = {};
  for (;;) {
    const run = await client.getRun(runId);
    const detail = await client.getRunDetail(runId);
    for (const j of selectJobs(detail.jobs, jobFilter)) {
      for (const s of j.steps ?? []) {
        const key = `${j.jobId}:${s.stepIndex}`;
        const logs = await client.getStepLogs(runId, j.jobId, s.stepIndex);
        const seen = printed[key] ?? 0;
        if (logs.lines.length > seen) {
          if (seen === 0) console.log(pc.bold(`\n=== ${j.jobName} › ${s.stepName} ===`));
          for (const line of logs.lines.slice(seen)) console.log(line);
          printed[key] = logs.lines.length;
        }
      }
    }
    if (TERMINAL_RUN_STATES.has(run.status)) {
      console.log(pc.gray(`\nrun ${colorStatus(run.status)}`));
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
