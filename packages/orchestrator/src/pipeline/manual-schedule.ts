/**
 * Dispatches a new run for a cron-scheduled workflow triggered manually from
 * the dashboard. It dispatches directly, not through the fire-and-forget
 * `eventRouter.emit` the automatic cron path uses, so the WS response can
 * return the newRunId synchronously.
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
   * Platform-minted idempotency key, stable across an HA relay failover
   * re-send: the first coordinator to claim it creates the run, and a re-send
   * returns that same run.
   */
  requestId: string,
): Promise<{ newRunId: string }> {
  const { registration, commitSha, provider } = validateScheduleRequest(registrationId, deps);
  const workflow = registration.lockEntry;

  // Claim the `requestId` BEFORE the first write; on a failover re-send a
  // sibling already owns it, so return its run id. Validation above is
  // read-only and identical across hops, so the claim never masks it.
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
    workflowName: workflow.name,
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
  // A schedule fire carries no operator input: steps and rules see the declared
  // defaults of every schedule() trigger as ctx.dispatchInputs.
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
    // Values are secret NAMES. `routeOrDispatchJobs` persists the same map on
    // the job row for the credential relay; omitting it here leaves the agent
    // an empty map, where `credential: 'x'` throws and `default` silently falls
    // back to the source credential.
    ...(job.gitCredentials && { gitCredentials: job.gitCredentials }),
    ...(dispatchInputs && { dispatchInputs }),
    ...(workflow.contentHash && { contentHash: workflow.contentHash }),
    ...(workflow.resolvedHashFiles?.length && {
      resolvedHashFiles: workflow.resolvedHashFiles,
    }),
  };
}

/**
 * Runs BEFORE dispatch, so a peer-rerouted onExecutionStarted hits ON CONFLICT
 * DO NOTHING and keeps this row's manual-schedule metadata (triggeredBy,
 * triggerEvent='manual_schedule'). Jobs join via addJobsToRun once dispatched.
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
    undefined, // prNumber
    undefined, // workflowRepo
    // No pull request is in a manual schedule's provenance, so `false` is its
    // true fork state, as for a push. Left unresolved, the documented
    // `is_fork = 'false'` trust policy would reject a legitimate scheduled run.
    { headRef: null, headRepository: null, isFork: false },
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
