/**
 * Shared coordinator-route / direct-dispatch machinery for the orchestrator
 * pipeline.
 *
 * The re-run path (`rerun.ts`) and the manual-schedule path
 * (`manual-schedule.ts`) both materialize a workflow's static jobs, try to
 * route them through the cluster coordinator (local dispatch first, then
 * reroute to peers), fall back to direct local dispatch in standalone mode or
 * on a coordinator timeout, and synthesize records for rejected jobs. This
 * module implements that once so a fix lands in a single place.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import {
  materializeFanout,
  partitionMatchers,
  FanoutError,
  ExecutionJobStatus,
} from '@kici-dev/engine';
import type { LockJob, MaterializedJob } from '@kici-dev/engine';
import type {
  JobToRoute,
  RouteResult,
  RunContext,
  RunCoordinator,
} from '../cluster/coordinator.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { QueuedJobInput } from '../queue/job-queue.js';

const ROUTE_JOBS_TIMEOUT_MS = 30_000;

export interface DispatchedJobEntry {
  jobId: string;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  runsOnLabels?: string[];
  /**
   * The unexpanded job name a materialized child came from. Persisted to
   * `execution_jobs.base_job_name`, which is the key the rolling-wave scheduler
   * groups a wave's children by — a NULL there makes the wave gate bail.
   */
  baseJobName?: string;
}

export interface RejectedJobEntry {
  jobId: string;
  reason: string;
}

/**
 * Distinguishes the race timeout from any other `routeJobs` rejection so the
 * fallback log line names the real cause.
 */
class RouteJobsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`routeJobs timed out after ${timeoutMs}ms`);
    this.name = 'RouteJobsTimeoutError';
  }
}

export interface RouteOrDispatchOptions {
  newRunId: string;
  /** Static jobs before materialization — the helper materializes + handles FanoutError. */
  staticJobs: LockJob[];
  workflowName: string;
  repoUrl: string;
  ref: string;
  sha: string;
  deliveryId: string;
  provider: string;
  providerContext: Record<string, unknown>;
  routingKey: string;
  /** Prebuilt by the caller (event name / payload / installationId differ per path). */
  runContext: RunContext;
  /** Per-caller jobConfig shape (schedule dispatchInputs vs. rerun source fallback). */
  buildJobConfig: (mat: MaterializedJob) => Record<string, unknown>;
  /** Caller's own logger — keeps the originating prefix ('manual-schedule' / 'rerun'). */
  logger: ReturnType<typeof createLogger>;
  /** Human label used in log messages: 'Manual schedule' | 'Re-run'. */
  label: string;
  coordinator: RunCoordinator | null;
  dispatcher: Dispatcher;
}

/**
 * Materialize the static jobs (degrading gracefully on a matrix that can no
 * longer expand), then route them via the coordinator or, in standalone mode /
 * on a coordinator timeout, dispatch directly. Returns the jobs to register
 * with the execution tracker plus any synthetic-rejected IDs to mark failed.
 */
export async function routeOrDispatchJobs(opts: RouteOrDispatchOptions): Promise<{
  dispatchedJobs: DispatchedJobEntry[];
  rejectedJobs: RejectedJobEntry[];
}> {
  const materialized = materializeWithDegradation(opts.staticJobs);
  const dispatchedJobs: DispatchedJobEntry[] = [...materialized.dispatchedJobs];
  const rejectedJobs: RejectedJobEntry[] = [...materialized.rejectedJobs];

  const routed = await tryRouteViaCoordinator(opts, materialized.materializedJobs);
  if (routed) {
    dispatchedJobs.push(...routed);
    return { dispatchedJobs, rejectedJobs };
  }

  const direct = await dispatchDirectly(opts, materialized.materializedJobs);
  dispatchedJobs.push(...direct.dispatchedJobs);
  rejectedJobs.push(...direct.rejectedJobs);
  return { dispatchedJobs, rejectedJobs };
}

/**
 * Re-materialize the matrix fresh from the current lock content. A matrix that
 * can no longer expand fails only that job (synthetic-rejected); the rest of
 * the run proceeds.
 */
function materializeWithDegradation(staticJobs: LockJob[]): {
  materializedJobs: MaterializedJob[];
  dispatchedJobs: DispatchedJobEntry[];
  rejectedJobs: RejectedJobEntry[];
} {
  try {
    return {
      materializedJobs: materializeFanout(staticJobs).jobs,
      dispatchedJobs: [],
      rejectedJobs: [],
    };
  } catch (err) {
    if (err instanceof FanoutError) {
      const syntheticId = `rejected-${randomUUID()}`;
      return {
        materializedJobs: materializeFanout(staticJobs.filter((j) => j.name !== err.jobName)).jobs,
        dispatchedJobs: [{ jobId: syntheticId, jobName: err.jobName, runsOnLabels: undefined }],
        rejectedJobs: [{ jobId: syntheticId, reason: err.message }],
      };
    }
    throw err;
  }
}

async function tryRouteViaCoordinator(
  opts: RouteOrDispatchOptions,
  materializedJobs: MaterializedJob[],
): Promise<DispatchedJobEntry[] | null> {
  const { coordinator, newRunId, workflowName, logger, label } = opts;
  if (!coordinator || materializedJobs.length === 0) {
    return null;
  }

  const matrixByName = new Map<string, Record<string, unknown>>();
  for (const mj of materializedJobs) {
    if (mj.variantValues) matrixByName.set(mj.expandedName, mj.variantValues);
  }

  const jobsToRoute: JobToRoute[] = materializedJobs.map((mat) => toJobToRoute(opts, mat));

  const routeResult = await raceRouteJobs(coordinator, opts, jobsToRoute);
  if (!routeResult) {
    return null;
  }

  const dispatchedJobs: DispatchedJobEntry[] = routeResult.localJobs.map((local) => {
    const job = materializedJobs.find((m) => m.expandedName === local.jobName)?.lockJob;
    const runsOnLabels = job ? partitionMatchers(job.runsOn ?? []).exact : undefined;
    const matrixValues = matrixByName.get(local.jobName);
    return {
      jobId: local.jobId,
      jobName: local.jobName,
      ...(matrixValues && { matrixValues }),
      runsOnLabels,
    };
  });

  for (const rerouted of routeResult.reroutedJobs) {
    logger.info(`${label} job rerouted to peer`, {
      newRunId,
      workflow: workflowName,
      job: rerouted.jobName,
      peerId: rerouted.peerId,
    });
  }
  for (const failed of routeResult.failedJobs) {
    logger.warn(`${label} job routing failed`, {
      newRunId,
      workflow: workflowName,
      job: failed.jobName,
      reason: failed.reason,
    });
  }

  return dispatchedJobs;
}

/**
 * Race `coordinator.routeJobs` against a timeout, clearing the timer in every
 * exit path. A timeout is reported distinctly from any other rejection so the
 * fallback log names the real cause. Returns null on any failure (the caller
 * then dispatches directly).
 */
async function raceRouteJobs(
  coordinator: RunCoordinator,
  opts: RouteOrDispatchOptions,
  jobsToRoute: JobToRoute[],
): Promise<RouteResult | null> {
  const { runContext, newRunId, workflowName, logger, label } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      coordinator.routeJobs(runContext, jobsToRoute),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RouteJobsTimeoutError(ROUTE_JOBS_TIMEOUT_MS)),
          ROUTE_JOBS_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const timedOut = err instanceof RouteJobsTimeoutError;
    logger.warn(
      timedOut
        ? `${label} coordinator routing timed out, falling back to direct dispatch`
        : `${label} coordinator routing failed, falling back to direct dispatch`,
      {
        newRunId,
        workflow: workflowName,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toJobToRoute(opts: RouteOrDispatchOptions, mat: MaterializedJob): JobToRoute {
  const job = mat.lockJob;
  const runsOnSel = partitionMatchers(job.runsOn ?? []);
  const excludeSel = partitionMatchers(job.excludeLabels ?? []);
  return {
    jobName: mat.expandedName,
    runsOnLabels: [runsOnSel.exact],
    runsOnPatterns: runsOnSel.regex,
    excludeLabels: excludeSel.exact,
    excludePatterns: excludeSel.regex,
    jobConfig: opts.buildJobConfig(mat),
    repoUrl: opts.repoUrl,
    ref: opts.ref,
    sha: opts.sha,
    ...(job.resources && { resources: job.resources }),
  };
}

/**
 * Standalone mode OR coordinator timeout/error: direct dispatch locally,
 * synthesizing a rejected entry for any job the dispatcher rejects.
 */
async function dispatchDirectly(
  opts: RouteOrDispatchOptions,
  materializedJobs: MaterializedJob[],
): Promise<{ dispatchedJobs: DispatchedJobEntry[]; rejectedJobs: RejectedJobEntry[] }> {
  const { dispatcher, newRunId, workflowName, logger, label } = opts;
  const dispatchedJobs: DispatchedJobEntry[] = [];
  const rejectedJobs: RejectedJobEntry[] = [];

  for (const mat of materializedJobs) {
    const job = mat.lockJob;
    const matrixValues = mat.variantValues;
    const runsOnSel = partitionMatchers(job.runsOn ?? []);
    const excludeSel = partitionMatchers(job.excludeLabels ?? []);
    const runsOnLabels = runsOnSel.exact;
    const jobInput: QueuedJobInput = {
      runId: newRunId,
      workflowName,
      jobName: mat.expandedName,
      runsOnLabels,
      runsOnPatterns: runsOnSel.regex,
      excludeLabels: excludeSel.exact,
      excludePatterns: excludeSel.regex,
      jobConfig: opts.buildJobConfig(mat),
      repoUrl: opts.repoUrl,
      ref: opts.ref,
      sha: opts.sha,
      deliveryId: opts.deliveryId,
      provider: opts.provider,
      providerContext: opts.providerContext,
      routingKey: opts.routingKey,
    };

    const result = await dispatcher.dispatch(jobInput);
    if (result.status === 'rejected') {
      const syntheticId = `rejected-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        runsOnLabels,
      });
      rejectedJobs.push({ jobId: syntheticId, reason: result.reason });
    } else {
      dispatchedJobs.push({
        jobId: result.jobId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        runsOnLabels,
      });
    }

    logger.info(`${label} job dispatched`, {
      newRunId,
      workflow: workflowName,
      job: mat.expandedName,
      status: result.status,
    });
  }

  return { dispatchedJobs, rejectedJobs };
}

export interface RegisterDispatchedJobsOptions {
  newRunId: string;
  dispatchedJobs: DispatchedJobEntry[];
  rejectedJobs: RejectedJobEntry[];
  executionTracker: ExecutionTracker;
}

/**
 * Register dispatched jobs with the execution tracker, then mark any
 * synthetic-rejected jobs failed. No-op when nothing was dispatched.
 */
export async function registerDispatchedJobs(opts: RegisterDispatchedJobsOptions): Promise<void> {
  const { newRunId, dispatchedJobs, rejectedJobs, executionTracker } = opts;
  if (dispatchedJobs.length === 0) {
    return;
  }

  await executionTracker.addJobsToRun(newRunId, dispatchedJobs);

  // Mark rejected jobs as failed. Synthetic rejected IDs come from an
  // unexpandable matrix (FanoutError) or a direct-dispatch rejection; the
  // coordinator logs its own failed jobs separately and produces none here.
  for (const { jobId, reason } of rejectedJobs) {
    await executionTracker.onJobStatus(
      newRunId,
      jobId,
      ExecutionJobStatus.enum.failed,
      Date.now(),
      undefined,
      { error: reason },
    );
  }
}
