/** kici runs show — run summary + jobs/steps tree (replaces `kici status`). */
import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';
import type {
  RunListItem,
  DashboardJobDetail,
  HeldRunSummary,
  InitFailure,
} from '@kici-dev/engine';
import { DashboardClient, DashboardClientError } from '../../remote/dashboard-client.js';
import { colorStatus, relativeTime, formatDuration } from '../../remote/render.js';
import { RunHistory } from '../../remote/history.js';
import {
  resolveHeldRunContext,
  listHeldRunsForRun,
  HeldRunRequestError,
} from '../held-run-client.js';

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
    const holds = await loadHolds(runId);
    if (options.json) {
      // `heldRunsUnavailable` is what separates "this run has no holds" from
      // "the holds could not be read" — both render as an empty array, and a
      // machine consumer cannot tell them apart without it.
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
    printJobs(detail.jobs);
    printHolds(holds);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

/** The holds for a run, or the reason they could not be read. */
interface HoldsResult {
  holds: HeldRunSummary[];
  /** Why the held-runs surface could not be reached; undefined when it was. */
  unavailable?: string;
  /**
   * True when the reason is that this caller may not read held runs at all.
   * Such a caller will never have the data, so the human-readable note is
   * suppressed — it would print on every invocation, including successful runs
   * with nothing held. The reason still reaches `--json` via `unavailable`.
   */
  unavailableSilently?: boolean;
}

/**
 * Read the approval holds recorded for a run.
 *
 * The holds are extra detail on a run this command can already display, so a
 * failure here degrades to a note rather than failing the command: an operator
 * asking why a job did not run still gets the run, its jobs and its init
 * failure. The auth context is resolved quietly for the same reason — a config
 * that cannot reach the held-runs API is not an error for `runs show`.
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

/**
 * The run-scoped init failure — why the run never started a step (an
 * unresolvable lock file, a secret it could not read, a gate it never passed).
 * Nothing is printed when the run started normally.
 */
function printInitFailure(initFailure: InitFailure | undefined): void {
  if (!initFailure) return;
  console.log(`\n  ${pc.yellow('Init failure')} ${pc.gray(`(${initFailure.category})`)}`);
  console.log(`    ${initFailure.message}`);
}

function printJobs(jobs: DashboardJobDetail[]): void {
  for (const j of jobs) {
    console.log(
      `\n  ${pc.bold(j.jobName)} ${colorStatus(j.status)} ` +
        pc.gray(j.durationMs ? formatDuration(j.durationMs) : ''),
    );
    printJobFailure(j);
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

/**
 * Why a single job failed: its job-scoped init failure (a job the context rules
 * rejected carries `context_rules` plus the context and rule that rejected it),
 * or its plain error message. The init failure wins when both are present —
 * the two carry the same text on a rejected job, and the category is the part
 * that tells the reader whether a gate or a step failed.
 */
function printJobFailure(job: DashboardJobDetail): void {
  if (job.initFailure) {
    console.log(
      `    ${pc.yellow('init failure')} ${pc.gray(`(${job.initFailure.category})`)}: ` +
        job.initFailure.message,
    );
    return;
  }
  if (job.errorMessage) console.log(`    ${pc.red('error')}: ${job.errorMessage}`);
}

/** The approval holds recorded against the run, or a note when unreadable. */
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
