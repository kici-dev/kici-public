/** `kici runs show`: run summary plus the jobs/steps tree. */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import { isRunId } from '@kici-dev/engine';
import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  toCanonicalStatus,
  type RunListItem,
  type DashboardJobDetail,
  type HeldRunSummary,
  type InitFailure,
} from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { colorStatus, relativeTime, formatDuration } from '../../remote/render.js';
import { RunHistory } from '../../remote/history.js';
import {
  resolveHeldRunContext,
  listHeldRunsForRun,
  HeldRunRequestError,
} from '../held-run-client.js';
import { printNotes, stepDetailNotes } from './detail-notes.js';
import { resolveRunRef } from './run-ref.js';
import { stepDisplayName, stepsInRunOrder } from './step-order.js';

export interface RunsShowOptions {
  json?: boolean;
}

export async function runsShowCommand(
  runRef: string,
  options: RunsShowOptions = {},
): Promise<boolean> {
  try {
    const client = await DashboardClient.load();
    const runId = await resolveRunRef(client, runRef, await localRunIdsFor(runRef));
    let run: RunListItem;
    try {
      run = await client.getRun(runId);
    } catch (err) {
      if (err instanceof DashboardClientError && err.kind === 'not_found') {
        return await showLocalFallback(runId, options.json ?? false);
      }
      throw err;
    }
    const read = await client.getRunDetailWithSource(runId);
    const detail = read.detail;
    printNotes(stepDetailNotes(read), new Set());
    const holds = await loadHolds(runId);
    if (options.json) {
      // `heldRunsUnavailable` separates "no holds" from "holds unreadable": both
      // are an empty array.
      console.log(
        JSON.stringify(
          {
            run,
            detail,
            heldRuns: holds.holds,
            ...(holds.unavailable && { heldRunsUnavailable: holds.unavailable }),
          },
          null,
          2,
        ),
      );
      return true;
    }
    printHeader(run);
    printInitFailure(detail.initFailure);
    printJobs(detail.jobs, runWorkflows(run).length > 1);
    printHolds(holds);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

interface HoldsResult {
  holds: HeldRunSummary[];
  /** Why the held-runs surface could not be reached; undefined when it was. */
  unavailable?: string;
  /**
   * The caller may not read held runs at all, so it never will: the note is
   * suppressed, or it would print on every invocation. `--json` still gets the
   * reason via `unavailable`.
   */
  unavailableSilently?: boolean;
}

/**
 * Holds are extra detail, so a failure degrades to a note: an operator asking
 * why a job did not run still gets the run, its jobs and its init failure. The
 * auth context resolves quietly for the same reason.
 */
async function loadHolds(runId: string): Promise<HoldsResult> {
  try {
    const ctx = await resolveHeldRunContext({ quiet: true });
    if (!ctx) {
      return {
        holds: [],
        unavailable: 'not authenticated for held-run lookup',
        unavailableSilently: true,
      };
    }
    return { holds: await listHeldRunsForRun(ctx, runId) };
  } catch (err) {
    const denied = err instanceof HeldRunRequestError && err.isPermissionDenied;
    return {
      holds: [],
      unavailable: toErrorMessage(err),
      ...(denied && { unavailableSilently: true }),
    };
  }
}

function runWorkflows(run: RunListItem): string[] {
  return run.workflowNames?.length ? run.workflowNames : [run.workflowName];
}

function printHeader(run: RunListItem): void {
  const f = (v: string | undefined | null): string => (v == null ? '—' : v);
  const workflows = runWorkflows(run);
  const workflowField =
    workflows.length > 1 ? `workflows=${workflows.join(',')}` : `workflow=${f(run.workflowName)}`;
  console.log(pc.bold(`\nRun ${run.runId}`) + `  ${colorStatus(run.status)}`);
  console.log(
    pc.gray(
      `  ${workflowField} repo=${f(run.repoIdentifier)} branch=${f(run.ref)} ` +
        `sha=${f(run.sha)} trigger=${f(run.triggerEvent)} by=${f(run.triggeredBy)}`,
    ),
  );
  console.log(pc.gray(`  started=${relativeTime(run.startedAt ?? undefined)}`));
}

/**
 * Why the run never started a step: an unresolvable lock file, an unreadable
 * secret, a gate it never passed.
 */
function printInitFailure(initFailure: InitFailure | undefined): void {
  if (!initFailure) return;
  console.log(`\n  ${pc.yellow('Init failure')} ${pc.gray(`(${initFailure.category})`)}`);
  console.log(`    ${initFailure.message}`);
}

function printJobs(jobs: DashboardJobDetail[], spansWorkflows: boolean): void {
  for (const j of jobs) {
    const label = spansWorkflows && j.workflowName ? `${j.workflowName} / ${j.jobName}` : j.jobName;
    console.log(
      `\n  ${pc.bold(label)} ${colorStatus(j.status)} ` +
        pc.gray(j.durationMs ? formatDuration(j.durationMs) : ''),
    );
    printJobFailure(j);
    for (const s of stepsInRunOrder(j.steps)) {
      console.log(
        pc.gray('    └─ ') +
          `${stepDisplayName(s)} ${colorStatus(s.status)} ` +
          pc.gray(
            `${s.durationMs ? formatDuration(s.durationMs) : ''}` +
              `${s.exitCode != null ? ` exit=${s.exitCode}` : ''}`,
          ),
      );
    }
  }
}

/**
 * The job-scoped init failure (a context-rules rejection carries
 * `context_rules` plus the context and rule), else a skipped job's reason, else
 * the job's error message, else its failed step. The init failure wins: on a rejected job both carry
 * the same text, and only the category tells whether a gate or a step failed.
 * A job that failed in a step usually records no job error message, so the
 * failed step names the error.
 */
function printJobFailure(job: DashboardJobDetail): void {
  if (job.initFailure) {
    console.log(
      `    ${pc.yellow('init failure')} ${pc.gray(`(${job.initFailure.category})`)}: ` +
        job.initFailure.message,
    );
    return;
  }
  if (
    job.errorMessage &&
    toCanonicalStatus(job.status.toLowerCase()) === ExecutionJobStatus.enum.skipped
  ) {
    console.log(`    ${pc.gray('skipped')}: ${job.errorMessage}`);
    return;
  }
  if (job.errorMessage) {
    console.log(`    ${pc.red('error')}: ${job.errorMessage}`);
    return;
  }
  const step = (job.steps ?? []).find(
    (s) => toCanonicalStatus(s.status.toLowerCase()) === ExecutionStepStatus.enum.failed,
  );
  if (!step) return;
  const message = step.errorMessage?.trim();
  const why = message
    ? `: ${message}`
    : step.exitCode != null
      ? ` exited with code ${step.exitCode}`
      : ' failed';
  console.log(`    ${pc.red('error')}: step ${step.stepName}${why}`);
}

function printHolds(result: HoldsResult): void {
  if (result.unavailable) {
    if (!result.unavailableSilently) {
      console.log(pc.gray(`\n  Approval-hold detail unavailable: ${result.unavailable}`));
    }
    return;
  }
  if (result.holds.length === 0) return;
  console.log(`\n  ${pc.bold(`Approval holds (${result.holds.length})`)}`);
  for (const h of result.holds) {
    const parts = [
      h.jobId || '(workflow)',
      h.holdType ?? '—',
      h.contextName ? `context=${h.contextName}` : undefined,
      h.queueType ? `queue=${h.queueType}` : undefined,
      colorStatus(h.status),
    ].filter((p): p is string => p != null);
    console.log(`    ${parts.join('  ')}`);
    if (h.reason) console.log(pc.gray(`      reason: ${h.reason}`));
    if (h.expiresAt) console.log(pc.gray(`      expires: ${relativeTime(h.expiresAt)}`));
  }
}

/** The local run history's run ids, read only for a short id, which may name one. */
async function localRunIdsFor(runRef: string): Promise<string[]> {
  if (isRunId(runRef.trim())) return [];
  const history = new RunHistory();
  await history.load();
  return history.getEntries().map((e) => e.runId);
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
