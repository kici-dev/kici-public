import { type Kysely, sql } from 'kysely';
import { ExecutionJobStatus, formatLabelMatcher, type LabelMatcher } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import { reportJobCheckRunCompletion } from '../reporting/job-check-run-completion.js';
import type { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import type { AgentRegistry } from '../agent/registry.js';
import {
  canAgentRunJob,
  CONTAINER_RUNTIME_LABELS,
  fitAgentFor,
  JobContainerNeed,
  type AgentFitJob,
  type ScalerAgentView,
} from '../scaler/agent-fit.js';
import type { ExpiredJobInfo } from './job-queue.js';

const logger = createLogger({ prefix: 'terminalize-unroutable' });

/**
 * Whether ANYTHING could ever run a job with these selectors: a registered
 * agent (regardless of capacity) that can run it, or a scaler backend able to
 * spawn one.
 *
 * `job`, when given, is what the agent must do beyond its labels, above all
 * start the job's container (`canAgentRunJob`). Absent, any label-matching
 * agent counts.
 *
 * It may answer "routable" conservatively: the scaler half matches exact
 * labels only, so a pattern-only `runsOn` reads routable on a
 * scaler-configured orchestrator. That costs precision on the status and on
 * settle time, never safety — such a job falls through to the queue-timeout
 * backstop.
 */
export type CanRouteLabels = (
  requiredLabels: string[],
  requiredPatterns: LabelMatcher[],
  excludeLabels: string[],
  excludePatterns: LabelMatcher[],
  job?: AgentFitJob,
) => boolean;

/**
 * The one routability predicate, built on the registry and the scaler: the
 * unroutable probe and the queue-expiry sweep both ask it.
 */
export function makeCanRouteLabels(deps: {
  registry: Pick<AgentRegistry, 'hasMatchingAgent'>;
  scaler?: {
    hasBackendForLabels(labels: string[], excludeLabels: string[]): boolean;
    agentView(agentId: string): ScalerAgentView | undefined;
  };
}): CanRouteLabels {
  const scalerAgentView = deps.scaler
    ? (agentId: string) => deps.scaler!.agentView(agentId)
    : undefined;
  return (labels, patterns, excludeLabels, excludePatterns, job) =>
    deps.registry.hasMatchingAgent(
      labels,
      patterns,
      excludeLabels,
      excludePatterns,
      job ? (entry) => canAgentRunJob(fitAgentFor(entry, scalerAgentView), job) : undefined,
    ) ||
    (deps.scaler?.hasBackendForLabels(labels, excludeLabels) ?? false);
}

/** The routing facts a verdict is computed from. */
export type JobRoutingFacts = Pick<
  ExpiredJobInfo,
  'lastProvisioningError' | 'runsOnLabels' | 'runsOnPatterns' | 'excludeLabels' | 'excludePatterns'
> &
  Partial<Pick<ExpiredJobInfo, 'id' | 'container'>>;

/** Everything {@link terminalizeUnroutableJob} needs to settle a job. */
export interface TerminalizeDeps {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  checkRunReporter?: Pick<CheckRunReporter, 'updateJobStatus'>;
  canRouteLabels?: CanRouteLabels;
  /**
   * The Tier-2 global-eval tracker, so a round job settled here also settles
   * the webhook request awaiting its verdict.
   *
   * A round job is the one queue entry with an in-process awaiter and no
   * `execution_runs` row (the round decides whether any run exists), so the
   * rest of this function skips it and the awaiter would otherwise wait out
   * its full ceiling for a dead job: with the shipped defaults, a 120s
   * definitive fast-fail followed by a 240s wait, twice.
   */
  pendingGlobalEvals?: Pick<PendingGlobalEvalTracker, 'reject'>;
}

const GENERIC_MESSAGE = 'Queue timeout expired (job was never dispatched to an agent)';

/** Why nothing can run a job. */
export enum UnroutableCause {
  /** No agent or scaler backend matches its labels. */
  NoMatch = 'no-match',
  /**
   * Agents match its labels, but it is a container job and none of them can
   * start a container.
   */
  NoContainerRuntime = 'no-container-runtime',
  /**
   * Agents match its labels, but each was started inside another job's image
   * and runs only that job.
   */
  OnlyOtherJobImageAgents = 'only-other-job-image-agents',
}

/**
 * The operator-facing reason a job is `unroutable`, naming the exact selectors
 * that went unmatched. Regex matchers are rendered as their source so the
 * message stays readable rather than printing `[object Object]`.
 */
export function unroutableMessage(job: JobRoutingFacts, cause = UnroutableCause.NoMatch): string {
  const required = [...job.runsOnLabels, ...job.runsOnPatterns.map(formatLabelMatcher)];
  const excluded = [...job.excludeLabels, ...job.excludePatterns.map(formatLabelMatcher)];
  const matching =
    (required.length > 0 ? `the agents that match runsOn [${required.join(', ')}]` : 'the agents') +
    (excluded.length > 0 ? ` excluding [${excluded.join(', ')}]` : '');
  if (cause === UnroutableCause.NoContainerRuntime) {
    return (
      `No connected agent can start this job's container: ${matching} ` +
      `report neither ${CONTAINER_RUNTIME_LABELS.join(' nor ')}, and no scaler backend ` +
      `matches — the job was never dispatched`
    );
  }
  if (cause === UnroutableCause.OnlyOtherJobImageAgents) {
    return (
      `No connected agent can take this job: ${matching} were each started inside ` +
      `another job's image and run only that job, and no scaler backend matches — ` +
      `the job was never dispatched`
    );
  }
  // `currently`, and both halves of the probe: the same verdict covers a fleet
  // that is merely empty right now (a lone static agent offline for the whole
  // window), and blaming the labels would send its operator chasing a correct
  // `runsOn`.
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
 * its `runsOn` (`unroutable` — a label/fleet problem an operator must fix)
 * versus something matched but never produced a usable agent
 * (`timed_out_stale` — a capacity or provisioning problem).
 *
 * Shared by the unroutable probe (short tick, gated by a grace window) and the
 * queue-expiry sweep (once at expiry, as the backstop): one verdict, two
 * moments, so never copy this logic.
 */
export function classifyUnroutable(
  job: JobRoutingFacts,
  canRouteLabels?: CanRouteLabels,
): { status: ExecutionJobStatus; errorMessage: string; unroutable: boolean } {
  // A recorded provisioning error settles it: the scaler attempted (and failed)
  // a spawn, so the labels DID route; calling it unroutable would send an
  // operator to fix a correct `runsOn`. Without the probe wired in, every job
  // stays `timed_out_stale`.
  const container = job.container ?? JobContainerNeed.None;
  const routes = (need: JobContainerNeed): boolean =>
    canRouteLabels!(job.runsOnLabels, job.runsOnPatterns, job.excludeLabels, job.excludePatterns, {
      ...(job.id !== undefined ? { jobId: job.id } : {}),
      container: need,
    });
  const unroutable =
    job.lastProvisioningError === null && canRouteLabels !== undefined && !routes(container);
  const cause = unroutable
    ? unroutableCause(container, routes, () =>
        canRouteLabels!(
          job.runsOnLabels,
          job.runsOnPatterns,
          job.excludeLabels,
          job.excludePatterns,
        ),
      )
    : UnroutableCause.NoMatch;

  return {
    unroutable,
    status: unroutable
      ? ExecutionJobStatus.enum.unroutable
      : ExecutionJobStatus.enum.timed_out_stale,
    // An unroutable job has no provisioning error by construction (see the
    // guard above), so the two branches never contend.
    errorMessage: unroutable
      ? unroutableMessage(job, cause)
      : (job.lastProvisioningError ?? GENERIC_MESSAGE),
  };
}

/**
 * Why nothing can run a job no agent or scaler backend can take.
 *
 * `routes` asks whether some agent could run the job with a given container
 * need; `labelsMatch` asks only whether a connected agent carries its labels.
 * When agents match the labels, the job is told apart from one whose labels
 * match nothing, because its fix is not its `runsOn`.
 */
function unroutableCause(
  container: JobContainerNeed,
  routes: (need: JobContainerNeed) => boolean,
  labelsMatch: () => boolean,
): UnroutableCause {
  // A container job the matching agents could run, were it not one: its fix is
  // a host with a container runtime.
  // fails-when: the job waits out its grace with a message blaming its labels
  if (container !== JobContainerNeed.None && routes(JobContainerNeed.None)) {
    return UnroutableCause.NoContainerRuntime;
  }
  // Agents carry the labels and none may take even a plain job. Probed without
  // a declared shape, `canAgentRunJob` refuses a plain job only on an agent
  // started inside another job's image.
  // fails-when: a job whose only matching agents run other jobs' images blames its labels
  // breaks-if-wrong: a job whose labels match no connected agent keeps the label message
  if (labelsMatch()) return UnroutableCause.OnlyOtherJobImageAgents;
  return UnroutableCause.NoMatch;
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

  // Before the `execution_jobs` update: a global eval round has no such row, so
  // every branch below is a no-op for it. Both callers already took the queue
  // row out of `Pending`, so the job can never dispatch. `reject` on an
  // untracked id (every non-round job, and a round dispatched by another
  // coordinator) is a no-op.
  deps.pendingGlobalEvals?.reject(job.id, new Error(errorMessage));

  try {
    // The status guard makes this safe across concurrent coordinators: the
    // loser updates zero rows and returns null rather than double-forwarding.
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

    // Surface the provisioning error (or the unroutable message, the only
    // statement of WHICH selectors went unmatched) as the run-level failure
    // reason, so `kici status`, `kici-admin runs show` and the dashboard banner
    // show the real cause instead of the generic `Failed jobs: <name>` roll-up.
    // Set only when no reason is recorded yet — never clobber an existing one.
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

      // See `CleanupExtras.checkRunReporter` for why this path posts the check
      // run itself. `errorMessage` is the only text naming the unmatched
      // `runsOn` selectors (or the provisioning failure).
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
