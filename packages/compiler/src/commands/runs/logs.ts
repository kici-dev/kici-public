/** kici runs logs — step logs for a run (replaces `kici status --logs`). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { JobKind, TERMINAL_RUN_STATES, type DashboardJobDetail } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { unwrapStoredLogLine } from '../../remote/output/streaming.js';
import { colorStatus } from '../../remote/render.js';

export interface RunsLogsOptions {
  job?: string;
  follow?: boolean;
  json?: boolean;
}

const POLL_INTERVAL_MS = 2000;

/**
 * A job's workflow-level log: the setup narration (clone, dependency install,
 * workflow module load) written before and between its steps.
 */
const SETUP_STEP_INDEX = -1;
/**
 * The label a job's setup log prints under, after the job name. A step name is
 * any string, so a step can be named `setup`; the parentheses keep that step's
 * heading apart from the setup log's.
 */
const SETUP_HEADING = '(setup)';
/** The prefix of the `--json` key a job's setup lines print under. */
const SETUP_JSON_KEY_PREFIX = 'setup:';

/**
 * The `--json` key of a job's setup lines: `setup:` and the job name, with `%`
 * and `/` percent-encoded. A step's key `<job>/<step>` always contains a `/`
 * and this key never does, so no step key can take it, whatever the job and
 * step are named. Encoding `%` keeps two job names apart when one of them
 * already reads like an encoded `/`.
 */
function setupJsonKey(jobName: string): string {
  return SETUP_JSON_KEY_PREFIX + jobName.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**
 * `kici runs logs --json`: each step's lines under `<job>/<step>`, and each
 * job's setup lines, when it wrote any, under {@link setupJsonKey}.
 */
type RunLogsJson = Record<string, string[]>;
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

/**
 * A job's setup log: its lines, and whether the orchestrator stored one at all
 * (`recorded`, absent when the orchestrator does not report it).
 */
interface SetupLog {
  lines: string[];
  recorded?: boolean;
}

/**
 * A job's setup log. An orchestrator that serves no setup log answers the
 * request with an error; that reads as "no setup lines", never as a failure.
 */
async function fetchSetupLog(
  client: DashboardClient,
  runId: string,
  jobId: string,
): Promise<SetupLog> {
  try {
    const { lines, recorded } = await client.getStepLogs(runId, jobId, SETUP_STEP_INDEX);
    return { lines, recorded };
  } catch {
    return { lines: [] };
  }
}

/**
 * Whether the job started on an agent, and so could have written a setup log.
 * A job that never started (queued, skipped, cancelled first) or that runs on
 * no agent (an invoke gate, a summoned-run proxy) has none to report on.
 */
function ranOnAnAgent(job: DashboardJobDetail): boolean {
  return job.startedAt !== null && (job.jobKind ?? JobKind.enum.standard) === JobKind.enum.standard;
}

/**
 * The note printed under a job's setup heading when its setup log has no lines:
 * none was recorded, or the stored log is empty. `null` when there are lines,
 * when the job never ran on an agent, or when the orchestrator does not report
 * which case applies.
 */
function emptySetupLogNote(job: DashboardJobDetail, setup: SetupLog): string | null {
  if (setup.lines.length > 0 || setup.recorded === undefined) return null;
  // fails-when: every queued or skipped job prints a "no setup log" note
  if (!ranOnAnAgent(job)) return null;
  return setup.recorded
    ? '(the setup log for this job is empty)'
    : '(no setup log recorded for this job)';
}

async function printAllLogs(
  client: DashboardClient,
  runId: string,
  jobs: DashboardJobDetail[],
  jobFilter?: string,
): Promise<void> {
  for (const j of selectJobs(jobs, jobFilter)) {
    const setup = await fetchSetupLog(client, runId, j.jobId);
    const note = emptySetupLogNote(j, setup);
    if (setup.lines.length > 0 || note) {
      console.log(pc.bold(`\n=== ${j.jobName} › ${SETUP_HEADING} ===`));
      for (const line of setup.lines) console.log(unwrapStoredLogLine(line));
      if (note) console.log(pc.gray(note));
    }
    for (const s of j.steps ?? []) {
      console.log(
        pc.bold(`\n=== ${j.jobName} › ${s.stepName} `) + colorStatus(s.status) + pc.bold(' ==='),
      );
      const logs = await client.getStepLogs(runId, j.jobId, s.stepIndex);
      // The orchestrator stores each line as a JSON envelope; print its text.
      for (const line of logs.lines) console.log(unwrapStoredLogLine(line));
    }
  }
}

async function collectAllLogs(
  client: DashboardClient,
  runId: string,
  jobs: DashboardJobDetail[],
  jobFilter?: string,
): Promise<RunLogsJson> {
  const out: RunLogsJson = {};
  for (const j of selectJobs(jobs, jobFilter)) {
    const { lines: setup } = await fetchSetupLog(client, runId, j.jobId);
    // fails-when: a job's setup lines share the `<job>/<step>` keyspace, so a step named
    // `setup` overwrites them
    // breaks-if-wrong: a run whose jobs wrote no setup log keeps the step-only shape
    if (setup.length > 0) out[setupJsonKey(j.jobName)] = setup;
    for (const s of j.steps ?? []) {
      out[`${j.jobName}/${s.stepName}`] = (
        await client.getStepLogs(runId, j.jobId, s.stepIndex)
      ).lines;
    }
  }
  return out;
}

/** Print the lines of `key` not printed yet, with a heading before the first. */
function printNewLines(
  printed: Record<string, number>,
  key: string,
  heading: string,
  lines: string[],
): void {
  const seen = printed[key] ?? 0;
  if (lines.length <= seen) return;
  if (seen === 0) console.log(pc.bold(`\n=== ${heading} ===`));
  for (const line of lines.slice(seen)) console.log(unwrapStoredLogLine(line));
  printed[key] = lines.length;
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
      const setupKey = `${j.jobId}:${SETUP_STEP_INDEX}`;
      printNewLines(
        printed,
        setupKey,
        `${j.jobName} › ${SETUP_HEADING}`,
        (await fetchSetupLog(client, runId, j.jobId)).lines,
      );
      for (const s of j.steps ?? []) {
        const logs = await client.getStepLogs(runId, j.jobId, s.stepIndex);
        printNewLines(
          printed,
          `${j.jobId}:${s.stepIndex}`,
          `${j.jobName} › ${s.stepName}`,
          logs.lines,
        );
      }
    }
    if (TERMINAL_RUN_STATES.has(run.status)) {
      console.log(pc.gray(`\nrun ${colorStatus(run.status)}`));
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
