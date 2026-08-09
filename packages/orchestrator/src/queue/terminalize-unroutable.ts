import { type Kysely, sql } from 'kysely';
import { ExecutionJobStatus, type LabelMatcher } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import { reportJobCheckRunCompletion } from '../reporting/job-check-run-completion.js';
import type { ExpiredJobInfo } from './job-queue.js';

const logger = createLogger({ prefix: 'terminalize-unroutable' });

/**
 * Whether ANYTHING could ever run a job with these selectors — a registered
 * agent (regardless of capacity) or a scaler backend able to spawn one.
 *
 * The predicate is allowed to answer "routable" conservatively: the scaler half
 * matches exact labels only, so a pattern-only `runsOn` reads routable on a
 * scaler-configured orchestrator. That costs precision on the status and on
 * how quickly the job settles, never safety — a job that reads routable simply
 * falls through to the queue-timeout backstop.
 */
export type CanRouteLabels = (
  requiredLabels: string[],
  requiredPatterns: LabelMatcher[],
  excludeLabels: string[],
  excludePatterns: LabelMatcher[],
) => boolean;

/** The routing facts a verdict is computed from. */
export type JobRoutingFacts = Pick<
  ExpiredJobInfo,
  | 'lastProvisioningError'
  | 'runsOnLabels'
  | 'runsOnPatterns'
  | 'excludeLabels'
  | 'excludePatterns'
>;

/** Everything {@link terminalizeUnroutableJob} needs to settle a job. */
export interface TerminalizeDeps {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  checkRunReporter?: Pick<CheckRunReporter, 'updateJobStatus'>;
  canRouteLabels?: CanRouteLabels;
}

const GENERIC_MESSAGE = 'Queue timeout expired (job was never dispatched to an agent)';

/**
 * The operator-facing reason a job is `unroutable`, naming the exact selectors
 * that went unmatched. Regex matchers are rendered as their source so the
 * message stays readable rather than printing `[object Object]`.
 */
function renderMatcher(m: LabelMatcher): string {
  return m.kind === 'exact' ? m.value : `/${m.source}/${m.flags}`;
}

export function unroutableMessage(job: JobRoutingFacts): string {
  const required = [...job.runsOnLabels, ...job.runsOnPatterns.map(renderMatcher)];
  const excluded = [...job.excludeLabels, ...job.excludePatterns.map(renderMatcher)];
  // `currently`, and both halves of the probe, because the same verdict covers a
  // fleet that is merely empty right now — a lone static agent that dropped off
  // for the whole window reaches this line too, and a message asserting the
  // labels are wrong would send its operator chasing a correct `runsOn`.
  const selector =
    required.length > 0
      ? `runsOn [${required.join(', ')}]`
      : 'this job (it declares no runsOn, so any agent would do)';
  const parts = [selector];
  if (excluded.length > 0) parts.push(`excluding [${excluded.join(', ')}]`);
  return `No connected agent or scaler backend currently matches ${parts.join(' ')} — the job was never dispatched`;
}

/**
 * Split the two reasons a queued job never ran: nothing in the fleet matched
 * its `runsOn` (`unroutable` — a label/fleet problem an operator has to fix)
 * versus something matched but never produced a usable agent
 * (`timed_out_stale` — a capacity or provisioning problem).
 *
 * Shared by the unroutable probe (which asks on a short tick, gated by a grace
 * window) and the queue-expiry sweep (which asks once at expiry, as the
 * backstop). One verdict, two moments in time — a second copy of this logic is
 * exactly the drift this module exists to prevent.
 */
export function classifyUnroutable(
  job: JobRoutingFacts,
  canRouteLabels?: CanRouteLabels,
): { status: ExecutionJobStatus; errorMessage: string; unroutable: boolean } {
  // A recorded provisioning error settles it on its own: the scaler got far
  // enough to attempt (and fail) a spawn, so the labels DID route and the real
  // cause is that failure. Calling that unroutable would send an operator to
  // fix a `runsOn` that is already correct.
  //
  // Without the probe wired in, every job keeps its historical
  // `timed_out_stale`.
  const unroutable =
    job.lastProvisioningError === null &&
    canRouteLabels !== undefined &&
    !canRouteLabels(job.runsOnLabels, job.runsOnPatterns, job.excludeLabels, job.excludePatterns);

  return {
    unroutable,
    status: unroutable
      ? ExecutionJobStatus.enum.unroutable
      : ExecutionJobStatus.enum.timed_out_stale,
    // An unroutable job has no provisioning error by construction (see the
    // guard above), so the two branches never contend.
    errorMessage: unroutable
      ? unroutableMessage(job)
      : (job.lastProvisioningError ?? GENERIC_MESSAGE),
  };
}

/**
 * Settle one never-dispatched job: write the terminal status locally, surface
 * the reason at run level, forward to Platform, and resolve its check run.
 *
 * @returns the run id when this call actually terminalized the job (so the
 * caller can complete the run), or null when another coordinator got there
 * first or the job was no longer pending.
 */
export async function terminalizeUnroutableJob(
  deps: TerminalizeDeps,
  job: ExpiredJobInfo,
): Promise<string | null> {
  const { status, errorMessage, unroutable } = classifyUnroutable(job, deps.canRouteLabels);

  try {
    // The status guard is what makes this safe to run from several coordinators
    // at once: the loser updates zero rows and returns null rather than
    // double-forwarding a terminal status.
    const ejResult = await deps.db
      .updateTable('execution_jobs')
      .set({
        status,
        completed_at: new Date(),
        error_message: errorMessage,
      })
      .where('run_id', '=', sql<string>`${job.runId}::uuid`)
      .where('job_name', '=', job.jobName)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .executeTakeFirst();

    if (!ejResult.numUpdatedRows || ejResult.numUpdatedRows === 0n) return null;

    // Surface the provisioning error as the run-level failure reason so
    // `kici status`, `kici-admin runs show`, and the dashboard banner show the
    // real cause. Only set it when no real step-failure reason has been
    // recorded yet — never clobber an existing reason.
    // An unroutable job's message carries the same weight: it is the only
    // statement of WHICH selectors went unmatched, and a run whose reason
    // stayed NULL would render the generic `Failed jobs: <name>` roll-up on
    // every surface the comment above names.
    const runReason = unroutable ? errorMessage : job.lastProvisioningError;
    if (runReason) {
      await deps.db
        .updateTable('execution_runs')
        .set({ failure_reason: runReason })
        .where('run_id', '=', sql<string>`${job.runId}::uuid`)
        .where('failure_reason', 'is', null)
        .execute();
    }

    // Look up the job_id (dispatch_queue.id !== execution_jobs.job_id)
    const ejRow = await deps.db
      .selectFrom('execution_jobs')
      .select(['job_id'])
      .where('run_id', '=', sql<string>`${job.runId}::uuid`)
      .where('job_name', '=', job.jobName)
      .executeTakeFirst();

    if (ejRow) {
      deps.executionTracker.updateInMemoryJob(job.runId, ejRow.job_id, status);

      deps.executionTracker.forwardJobTerminalStatus(
        job.runId,
        ejRow.job_id,
        job.jobName,
        status,
        errorMessage,
      );

      deps.executionTracker.emitInfraEvent(job.runId, 'orchestrator.job.queue_expired', {
        jobId: ejRow.job_id,
        metadata: { jobName: job.jobName, reason: errorMessage },
      });

      // Resolve the job's check run — see `CleanupExtras.checkRunReporter` for
      // why this path has to post it itself. `errorMessage` is passed as the
      // description because it is the only text naming the unmatched `runsOn`
      // selectors (or the provisioning failure).
      if (deps.checkRunReporter) {
        reportJobCheckRunCompletion(
          {
            checkRunReporter: deps.checkRunReporter,
            getExecutionContext: (runId) => deps.executionTracker.getExecutionContext(runId),
          },
          {
            runId: job.runId,
            jobId: ejRow.job_id,
            jobName: job.jobName,
            status,
            description: errorMessage,
          },
        );
      }
    }

    return job.runId;
  } catch (err) {
    logger.error('Failed to forward never-dispatched job status', {
      runId: job.runId,
      jobName: job.jobName,
      error: toErrorMessage(err),
    });
    return null;
  }
}
