/** `kici runs logs`: step logs for a run. */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { TERMINAL_RUN_STATES, type DashboardJobDetail, sleep } from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { unwrapStoredLogLine } from '../../remote/output/streaming.js';
import { colorStatus } from '../../remote/render.js';
import { printNotes, ranOnAnAgent, stepDetailNotes } from './detail-notes.js';
import { resolveRunRef } from './run-ref.js';
import { stepDisplayName, stepsInRunOrder } from './step-order.js';

export interface RunsLogsOptions {
  job?: string;
  follow?: boolean;
  json?: boolean;
}

const POLL_INTERVAL_MS = 2000;

/**
 * A job's workflow-level log: setup narration (clone, dependency install,
 * workflow module load) written before and between its steps.
 */
const SETUP_STEP_INDEX = -1;
/** The parentheses keep it apart from a step named `setup`. */
const SETUP_HEADING = '(setup)';
const SETUP_JSON_KEY_PREFIX = 'setup:';

/**
 * `setup:` plus the job name with `%` and `/` percent-encoded. A step key
 * `<job>/<step>` always contains a `/` and this never does, so no step can take
 * it. Encoding `%` keeps apart a job name that already reads like an encoded `/`.
 */
function setupJsonKey(jobName: string): string {
  return SETUP_JSON_KEY_PREFIX + jobName.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**
 * `kici runs logs --json`: each step's lines under `<job>/<step>`, and each
 * job's setup lines, when it wrote any, under {@link setupJsonKey}.
 */
type RunLogsJson = Record<string, string[]>;
export async function runsLogsCommand(
  runRef: string,
  options: RunsLogsOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const runId = await resolveRunRef(client, runRef);
    // Each note prints once, however many polls or jobs bring it back.
    const printed = new Set<string>();
    if (options.json) {
      const read = await client.getRunDetailWithSource(runId);
      printNotes(stepDetailNotes(read), printed);
      const out = await collectAllLogs(client, runId, read.detail.jobs, printed, options.job);
      console.log(JSON.stringify(out, null, 2));
      return true;
    }
    if (options.follow) {
      return await followLogs(client, runId, printed, options.job);
    }
    const read = await client.getRunDetailWithSource(runId);
    printNotes(stepDetailNotes(read), printed);
    await printAllLogs(client, runId, read.detail.jobs, printed, options.job);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

function selectJobs(jobs: DashboardJobDetail[], jobFilter?: string): DashboardJobDetail[] {
  return jobFilter ? jobs.filter((j) => j.jobName === jobFilter) : jobs;
}

interface SetupLog {
  lines: string[];
  /** Whether the orchestrator stored one; absent when it does not report it. */
  recorded?: boolean;
  /** Why it could not be read; absent when it was. */
  error?: string;
}

/**
 * A job's setup log. A failed read yields no lines and its error, which the
 * caller reports on stderr; it never fails the command.
 */
async function fetchSetupLog(
  client: DashboardClient,
  runId: string,
  jobId: string,
): Promise<SetupLog> {
  try {
    const { lines, recorded } = await client.getStepLogs(runId, jobId, SETUP_STEP_INDEX);
    return { lines, recorded };
  } catch (err) {
    return {
      lines: [],
      error: err instanceof DashboardClientError ? err.message : toErrorMessage(err),
    };
  }
}

/** The stderr note for a setup log that could not be read. */
function setupLogErrorNotes(job: DashboardJobDetail, setup: SetupLog): string[] {
  return setup.error === undefined
    ? []
    : [`setup log unavailable for job ${job.jobName}: ${setup.error}`];
}

/**
 * Says whether an empty setup log was never recorded or is stored empty. `null`
 * when there are lines, the job never ran on an agent, or the orchestrator does
 * not report which case applies.
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
  printed: Set<string>,
  jobFilter?: string,
): Promise<void> {
  for (const j of selectJobs(jobs, jobFilter)) {
    const setup = await fetchSetupLog(client, runId, j.jobId);
    printNotes(setupLogErrorNotes(j, setup), printed);
    const note = emptySetupLogNote(j, setup);
    if (setup.lines.length > 0 || note) {
      console.log(pc.bold(`\n=== ${j.jobName} › ${SETUP_HEADING} ===`));
      for (const line of setup.lines) console.log(unwrapStoredLogLine(line));
      if (note) console.log(pc.gray(note));
    }
    for (const s of stepsInRunOrder(j.steps)) {
      console.log(
        pc.bold(`\n=== ${j.jobName} › ${stepDisplayName(s)} `) +
          colorStatus(s.status) +
          pc.bold(' ==='),
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
  printed: Set<string>,
  jobFilter?: string,
): Promise<RunLogsJson> {
  const out: RunLogsJson = {};
  for (const j of selectJobs(jobs, jobFilter)) {
    const setupLog = await fetchSetupLog(client, runId, j.jobId);
    printNotes(setupLogErrorNotes(j, setupLog), printed);
    const setup = setupLog.lines;
    // fails-when: a job's setup lines share the `<job>/<step>` keyspace, so a step named
    // `setup` overwrites them
    // breaks-if-wrong: a run whose jobs wrote no setup log keeps the step-only shape
    if (setup.length > 0) out[setupJsonKey(j.jobName)] = setup;
    for (const s of stepsInRunOrder(j.steps)) {
      out[`${j.jobName}/${s.stepName}`] = (
        await client.getStepLogs(runId, j.jobId, s.stepIndex)
      ).lines;
    }
  }
  return out;
}

/** Prints the lines of `key` not printed yet, with a heading before the first. */
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
  notesPrinted: Set<string>,
  jobFilter?: string,
): Promise<boolean> {
  const printed: Record<string, number> = {};
  for (;;) {
    const run = await client.getRun(runId);
    const read = await client.getRunDetailWithSource(runId);
    printNotes(stepDetailNotes(read), notesPrinted);
    for (const j of selectJobs(read.detail.jobs, jobFilter)) {
      const setupKey = `${j.jobId}:${SETUP_STEP_INDEX}`;
      const setup = await fetchSetupLog(client, runId, j.jobId);
      printNotes(setupLogErrorNotes(j, setup), notesPrinted);
      printNewLines(printed, setupKey, `${j.jobName} › ${SETUP_HEADING}`, setup.lines);
      for (const s of stepsInRunOrder(j.steps)) {
        const logs = await client.getStepLogs(runId, j.jobId, s.stepIndex);
        printNewLines(
          printed,
          `${j.jobId}:${s.stepIndex}`,
          `${j.jobName} › ${stepDisplayName(s)}`,
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
