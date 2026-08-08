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

import { createLogger } from '@kici-dev/shared';
import { isLockStaticJob, matrixEnvelopeFields, resolveScheduleInputs } from '@kici-dev/engine';
import type { LockScheduleTrigger, LockWorkflow, MaterializedJob } from '@kici-dev/engine';
import type { RerunDeps } from './rerun.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { RunContext } from '../cluster/coordinator.js';
import { routeOrDispatchJobs, registerDispatchedJobs } from './route-or-dispatch-jobs.js';
import { claimRequestId } from './request-idempotency.js';

const logger = createLogger({ prefix: 'manual-schedule' });

interface ManualScheduleDeps extends RerunDeps {
  registrationIndex: RegistrationIndex;
}

interface ValidatedRequest {
  registration: RegisteredWorkflow;
  commitSha: string;
  provider: string;
}

export async function handleManualSchedule(
  registrationId: string,
  triggeredBy: string | null,
  triggeredByAgentLabel: string | null,
  deps: ManualScheduleDeps,
  /**
   * Platform-minted `requestId`. Stable across an HA relay failover re-send, so
   * it is the idempotency key: after the read-only validation, the first
   * coordinator to claim it creates the run and a failover re-send returns that
   * same run instead of minting a second one.
   */
  requestId: string,
): Promise<{ newRunId: string }> {
  const { registration, commitSha, provider } = validateScheduleRequest(registrationId, deps);
  const workflow = registration.lockEntry;

  // Claim this request by its Platform `requestId` BEFORE the first write. On a
  // relay failover re-send a sibling coordinator already owns this requestId, so
  // return its run id without minting a second run. Validation above is
  // read-only and identical across hops, so it is never masked by the claim.
  const { newRunId, claimed } = await claimRequestId(deps.db, requestId);
  if (!claimed) {
    logger.info('Manual-schedule requestId already claimed by a sibling; returning existing run', {
      registrationId,
      requestId,
      newRunId,
    });
    return { newRunId };
  }

  logger.info('Manually triggering schedule workflow', {
    registrationId,
    newRunId,
    workflowName: registration.workflowName,
    sha: commitSha,
    triggeredBy,
  });

  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const repoUrl = resolveRepoUrl(registration, deps);

  await recordExecutionStart({
    newRunId,
    workflow,
    registration,
    commitSha,
    provider,
    triggeredBy,
    triggeredByAgentLabel,
    deps,
  });

  const installationId =
    typeof (registration.providerContext as { installationId?: unknown }).installationId ===
    'number'
      ? ((registration.providerContext as { installationId: number }).installationId as number)
      : undefined;

  const runContext: RunContext = {
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

  const { dispatchedJobs, rejectedJobs } = await routeOrDispatchJobs({
    newRunId,
    staticJobs,
    workflowName: workflow.name,
    repoUrl,
    ref: '',
    sha: commitSha,
    deliveryId: `manual_schedule:${newRunId}`,
    provider,
    providerContext: registration.providerContext as Record<string, unknown>,
    routingKey: registration.routingKey,
    runContext,
    buildJobConfig: (mat) => buildManualJobConfig(workflow, mat),
    logger,
    label: 'Manual schedule',
    coordinator: deps.coordinator,
    dispatcher: deps.dispatcher,
  });

  await registerDispatchedJobs({
    newRunId,
    dispatchedJobs,
    rejectedJobs,
    executionTracker: deps.executionTracker,
  });
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

/**
 * A manual "fire now" targets no specific schedule, so merge the declared
 * default inputs across ALL of the workflow's schedule triggers (later triggers
 * win on key collision) rather than arbitrarily taking the first. Returns
 * undefined when no schedule declares resolvable inputs.
 */
export function mergeScheduleInputs(
  scheduleTriggers: LockScheduleTrigger[],
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  let any = false;
  for (const trigger of scheduleTriggers) {
    const resolved = resolveScheduleInputs(trigger.inputs);
    if (resolved) {
      Object.assign(merged, resolved);
      any = true;
    }
  }
  return any ? merged : undefined;
}

export function buildManualJobConfig(workflow: LockWorkflow, mat: MaterializedJob) {
  const job = mat.lockJob;
  // A schedule fire carries no operator input — resolve the declared defaults
  // so steps and rules see them as ctx.dispatchInputs. A workflow may declare
  // several schedule() triggers; a manual fire targets none in particular, so
  // merge every schedule's defaults rather than only the first.
  const scheduleTriggers = workflow.triggers.filter(
    (t): t is LockScheduleTrigger => t._type === 'schedule',
  );
  const dispatchInputs = mergeScheduleInputs(scheduleTriggers);
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
  triggeredByAgentLabel: string | null;
  deps: ManualScheduleDeps;
}): Promise<void> {
  const {
    newRunId,
    workflow,
    registration,
    commitSha,
    provider,
    triggeredBy,
    triggeredByAgentLabel,
    deps,
  } = args;
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
    undefined, // checkMode
    undefined, // localWorkingTree
    undefined, // triggerActorUsername
    undefined, // triggerActorUserId
    triggeredByAgentLabel, // triggeredByAgentLabel
  );
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
