/**
 * Manual schedule handler for the orchestrator.
 *
 * Dispatches a new run for a cron-scheduled workflow triggered manually
 * from the dashboard UI. Uses direct dispatch (not eventRouter.emit) so
 * the newRunId can be returned synchronously in the WS response.
 *
 * This is intentionally separate from the automatic cron path which uses
 * eventRouter fire-and-forget. The manual path needs request/response
 * correlation to return the newRunId to the dashboard.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import {
  isLockStaticJob,
  materializeFanout,
  matrixEnvelopeFields,
  partitionMatchers,
  resolveScheduleInputs,
} from '@kici-dev/engine';
import type { LockScheduleTrigger, LockWorkflow, MaterializedJob } from '@kici-dev/engine';
import type { RerunDeps } from './rerun.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { JobToRoute, RunContext } from '../cluster/coordinator.js';

const logger = createLogger({ prefix: 'manual-schedule' });

const ROUTE_JOBS_TIMEOUT_MS = 30_000;

interface ManualScheduleDeps extends RerunDeps {
  registrationIndex: RegistrationIndex;
}

interface DispatchedJobEntry {
  jobId: string;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  runsOnLabels?: string[];
}

interface RejectedJobEntry {
  jobId: string;
  reason: string;
}

interface ValidatedRequest {
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
}

export async function handleManualSchedule(
  registrationId: string,
  triggeredBy: string | null,
  deps: ManualScheduleDeps,
): Promise<{ newRunId: string }> {
  const { registration, commitSha, provider } = validateScheduleRequest(registrationId, deps);
  const workflow = registration.lockEntry;
  const newRunId = randomUUID();

  logger.info('Manually triggering schedule workflow', {
    registrationId,
    newRunId,
    workflowName: registration.workflowName,
    sha: commitSha,
    triggeredBy,
  });

  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const materializedJobs = materializeFanout(staticJobs).jobs;
  const repoUrl = resolveRepoUrl(registration, deps);

  await recordExecutionStart({
    newRunId,
    workflow,
    registration,
    commitSha,
    provider,
    triggeredBy,
    deps,
  });

  const { dispatchedJobs, rejectedJobs } = await dispatchScheduledJobs({
    newRunId,
    materializedJobs,
    workflow,
    registration,
    commitSha,
    provider,
    repoUrl,
    deps,
  });

  await registerJobsWithTracker({ newRunId, dispatchedJobs, rejectedJobs, deps });
  await emitScheduleEvent({ newRunId, workflow, registration, triggeredBy, deps });

  return { newRunId };
}

function validateScheduleRequest(
  registrationId: string,
  deps: ManualScheduleDeps,
): ValidatedRequest {
  const registration = deps.registrationIndex.getById(registrationId);
  if (!registration) {
    throw new Error('Registration not found');
  }

  if (registration.disabled) {
    throw new Error('Workflow is disabled');
  }

  const hasScheduleTrigger = registration.lockEntry.triggers.some((t) => t._type === 'schedule');
  if (!hasScheduleTrigger) {
    throw new Error('Workflow has no schedule trigger');
  }

  if (!registration.commitSha) {
    throw new Error('Registration has no commit SHA — workflow may not have been compiled yet');
  }

  return {
    registration,
    commitSha: registration.commitSha,
    provider: registration.routingKey.split(':')[0],
  };
}

function resolveRepoUrl(registration: RegisteredWorkflow, deps: ManualScheduleDeps): string {
  const providerBundle = deps.providerRegistry.getByRoutingKey(registration.routingKey);
  return providerBundle?.repoUrlBuilder?.buildCloneUrl(registration.repoIdentifier) ?? '';
}

export function buildManualJobConfig(workflow: LockWorkflow, mat: MaterializedJob) {
  const job = mat.lockJob;
  // A schedule fire carries no operator input — resolve the trigger's declared
  // defaults so steps and rules see them as ctx.dispatchInputs.
  const scheduleTrigger = workflow.triggers.find(
    (t): t is LockScheduleTrigger => t._type === 'schedule',
  );
  const dispatchInputs = resolveScheduleInputs(scheduleTrigger?.inputs);
  return {
    source: workflow.source,
    workflowName: workflow.name,
    ...matrixEnvelopeFields(mat),
    steps: job.steps,
    needs: job.needs,
    rules: job.rules,
    ...(dispatchInputs && { dispatchInputs }),
    ...(workflow.contentHash && { contentHash: workflow.contentHash }),
    ...(workflow.resolvedHashFiles?.length && {
      resolvedHashFiles: workflow.resolvedHashFiles,
    }),
  };
}

/**
 * Record execution start BEFORE dispatch so that when jobs are rerouted
 * to peers, the coordinator's rerouted onExecutionStarted call hits
 * ON CONFLICT DO NOTHING and preserves the row inserted here with full
 * manual-schedule metadata (triggeredBy, triggerEvent='manual_schedule').
 * Jobs are added below via executionTracker.addJobsToRun once dispatched.
 */
async function recordExecutionStart(args: {
  newRunId: string;
  workflow: LockWorkflow;
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
  triggeredBy: string | null;
  deps: ManualScheduleDeps;
}): Promise<void> {
  const { newRunId, workflow, registration, commitSha, provider, triggeredBy, deps } = args;
  await deps.executionTracker.onExecutionStarted(
    newRunId,
    workflow.name,
    provider,
    registration.repoIdentifier,
    '',
    commitSha,
    `manual_schedule:${newRunId}`,
    registration.providerContext,
    null, // No trigger decision for manual schedules
    [], // jobs added after dispatch via addJobsToRun
    registration.routingKey,
    undefined, // contexts
    'manual_schedule', // triggerEvent
    undefined, // commitMessage
    undefined, // parentRunId
    triggeredBy, // triggeredBy
    undefined, // originalRunId
    workflow.concurrency
      ? {
          cancelInProgress: workflow.concurrency.cancelInProgress,
          max: workflow.concurrency.max,
        }
      : undefined,
    workflow.timeout, // workflowTimeoutMs
  );
}

/**
 * Coordinator-routed (cluster mode) or direct (standalone) dispatch.
 * The coordinator tries local dispatch first, then reroutes to peers whose
 * scalers can satisfy the labels. Without this, a manual trigger handled by
 * a peer that can't spawn the requested label sits in dispatch_queue forever.
 */
async function dispatchScheduledJobs(args: {
  newRunId: string;
  materializedJobs: MaterializedJob[];
  workflow: LockWorkflow;
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
  repoUrl: string;
  deps: ManualScheduleDeps;
}): Promise<{ dispatchedJobs: DispatchedJobEntry[]; rejectedJobs: RejectedJobEntry[] }> {
  const coordResult = await tryRouteViaCoordinator(args);
  if (coordResult) {
    return { dispatchedJobs: coordResult, rejectedJobs: [] };
  }
  return dispatchDirectly(args);
}

async function tryRouteViaCoordinator(args: {
  newRunId: string;
  materializedJobs: MaterializedJob[];
  workflow: LockWorkflow;
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
  repoUrl: string;
  deps: ManualScheduleDeps;
}): Promise<DispatchedJobEntry[] | null> {
  const { newRunId, materializedJobs, workflow, registration, commitSha, provider, repoUrl, deps } =
    args;
  if (!deps.coordinator || materializedJobs.length === 0) {
    return null;
  }

  const matrixByName = new Map<string, Record<string, unknown>>();
  for (const mj of materializedJobs) {
    if (mj.variantValues) matrixByName.set(mj.expandedName, mj.variantValues);
  }

  const installationId =
    typeof (registration.providerContext as { installationId?: unknown }).installationId ===
    'number'
      ? ((registration.providerContext as { installationId: number }).installationId as number)
      : undefined;

  const jobsToRoute: JobToRoute[] = materializedJobs.map((mat) => {
    const job = mat.lockJob;
    const runsOnSel = partitionMatchers(job.runsOn ?? []);
    const excludeSel = partitionMatchers(job.excludeLabels ?? []);
    return {
      jobName: mat.expandedName,
      runsOnLabels: [runsOnSel.exact],
      runsOnPatterns: runsOnSel.regex,
      excludeLabels: excludeSel.exact,
      excludePatterns: excludeSel.regex,
      jobConfig: buildManualJobConfig(workflow, mat),
      repoUrl,
      ref: '',
      sha: commitSha,
      ...(job.resources && { resources: job.resources }),
    };
  });

  const runCtx: RunContext = {
    runId: newRunId,
    deliveryId: `manual_schedule:${newRunId}`,
    routingKey: registration.routingKey,
    event: 'manual_schedule',
    action: null,
    provider,
    payload: {},
    repoIdentifier: registration.repoIdentifier,
    sha: commitSha,
    ref: '',
    workflowName: workflow.name,
    ...(installationId !== undefined && { installationId }),
  };

  const routeResult = await Promise.race([
    deps.coordinator.routeJobs(runCtx, jobsToRoute),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`routeJobs timed out after ${ROUTE_JOBS_TIMEOUT_MS}ms`)),
        ROUTE_JOBS_TIMEOUT_MS,
      ),
    ),
  ]).catch((err: unknown) => {
    logger.warn(
      'Coordinator routing timed out for manual schedule, falling back to direct dispatch',
      {
        newRunId,
        workflow: workflow.name,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  });

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
    logger.info('Manual schedule job rerouted to peer', {
      newRunId,
      workflow: workflow.name,
      job: rerouted.jobName,
      peerId: rerouted.peerId,
    });
  }
  for (const failed of routeResult.failedJobs) {
    logger.warn('Manual schedule job routing failed', {
      newRunId,
      workflow: workflow.name,
      job: failed.jobName,
      reason: failed.reason,
    });
  }

  return dispatchedJobs;
}

/**
 * Standalone mode OR coordinator timeout: direct dispatch locally.
 */
async function dispatchDirectly(args: {
  newRunId: string;
  materializedJobs: MaterializedJob[];
  workflow: LockWorkflow;
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
  repoUrl: string;
  deps: ManualScheduleDeps;
}): Promise<{ dispatchedJobs: DispatchedJobEntry[]; rejectedJobs: RejectedJobEntry[] }> {
  const { newRunId, materializedJobs, workflow, registration, commitSha, provider, repoUrl, deps } =
    args;
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
      workflowName: workflow.name,
      jobName: mat.expandedName,
      runsOnLabels,
      runsOnPatterns: runsOnSel.regex,
      excludeLabels: excludeSel.exact,
      excludePatterns: excludeSel.regex,
      jobConfig: buildManualJobConfig(workflow, mat),
      repoUrl,
      ref: '',
      sha: commitSha,
      deliveryId: `manual_schedule:${newRunId}`,
      provider,
      providerContext: registration.providerContext,
      routingKey: registration.routingKey,
    };

    const result = await deps.dispatcher.dispatch(jobInput);
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

    logger.info('Manual schedule job dispatched', {
      newRunId,
      workflow: workflow.name,
      job: mat.expandedName,
      status: result.status,
    });
  }

  return { dispatchedJobs, rejectedJobs };
}

async function registerJobsWithTracker(args: {
  newRunId: string;
  dispatchedJobs: DispatchedJobEntry[];
  rejectedJobs: RejectedJobEntry[];
  deps: ManualScheduleDeps;
}): Promise<void> {
  const { newRunId, dispatchedJobs, rejectedJobs, deps } = args;
  if (dispatchedJobs.length === 0) {
    return;
  }

  await deps.executionTracker.addJobsToRun(newRunId, dispatchedJobs);

  // Mark rejected jobs as failed (standalone-fallback path only — the coordinator
  // logs failed jobs separately and does not produce synthetic rejected IDs).
  for (const { jobId, reason } of rejectedJobs) {
    await deps.executionTracker.onJobStatus(newRunId, jobId, 'failed', Date.now(), undefined, {
      error: reason,
    });
  }
}

async function emitScheduleEvent(args: {
  newRunId: string;
  workflow: LockWorkflow;
  registration: RegisteredWorkflow;
  triggeredBy: string | null;
  deps: ManualScheduleDeps;
}): Promise<void> {
  const { newRunId, workflow, registration, triggeredBy, deps } = args;
  if (!deps.eventRouter) {
    return;
  }

  await deps.eventRouter.emit({
    eventName: 'workflow.manual_schedule',
    payload: {
      newRunId,
      workflowName: workflow.name,
      repo: registration.repoIdentifier,
      sha: registration.commitSha,
      triggeredBy,
    },
    sourceRepo: registration.repoIdentifier,
    sourceRoutingKey: registration.routingKey,
  });
}
