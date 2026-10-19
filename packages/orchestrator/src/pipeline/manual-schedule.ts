/**
 * Dispatches a new run for a cron-scheduled workflow triggered manually from
 * the dashboard. It dispatches directly, not through the fire-and-forget
 * `eventRouter.emit` the automatic cron path uses, so the WS response can
 * return the newRunId synchronously.
 *
 * A fire by hand is the run a cron fire would start, so it goes through the
 * same internal-event pipeline: `needs` ordering, contexts and their secrets,
 * approval gates, containers, the trusted tier a schedule fire carries, and the
 * cache identity the orchestrator resolves artifact and user-cache requests
 * against. Only the run id, the trigger event and who fired it differ.
 */

import { createLogger } from '@kici-dev/shared';
import { resolveScheduleInputs } from '@kici-dev/engine';
import type { LockScheduleTrigger } from '@kici-dev/engine';
import type { RerunDeps } from './rerun.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { claimRequestId } from './request-idempotency.js';
import {
  dispatchInternalEventViaPipeline,
  InternalSystemEventName,
} from './internal-event-pipeline.js';
import { registrationLockFile } from '../events/event-router.js';

const logger = createLogger({ prefix: 'manual-schedule' });

interface ManualScheduleDeps extends RerunDeps {
  registrationIndex: RegistrationIndex;
}

interface ValidatedRequest {
  registration: RegisteredWorkflow;
  commitSha: string;
}

/** The `trigger_event` a schedule fired by hand records. */
export const MANUAL_SCHEDULE_TRIGGER_EVENT = 'manual_schedule';

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
  const { registration, commitSha } = validateScheduleRequest(registrationId, deps);
  const processingDeps = deps.processingDeps?.();
  if (!processingDeps) {
    throw new Error('This orchestrator is not wired to dispatch a schedule fired by hand');
  }
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

  const scheduleTriggers = workflow.triggers.filter(
    (t): t is LockScheduleTrigger => t._type === 'schedule',
  );
  const dispatchInputs = mergeScheduleInputs(scheduleTriggers);
  await dispatchInternalEventViaPipeline(
    {
      workflowName: workflow.name,
      matched: true,
      checks: [],
      summary: 'Schedule fired by hand',
    },
    registrationLockFile(registration),
    {
      // The fire's own id: a schedule fire is orchestrator-minted, so its trust
      // is never looked up by event id.
      event: {
        id: `${MANUAL_SCHEDULE_TRIGGER_EVENT}:${newRunId}`,
        eventName: InternalSystemEventName.enum.__schedule_fire,
        payload: { commitSha },
      },
      routingKey: registration.routingKey,
      repoIdentifier: registration.repoIdentifier,
      providerContext: registration.providerContext,
      providerType: registration.routingKey.split(':')[0] as 'github',
      bundle: deps.providerRegistry.getByRoutingKey(registration.routingKey) ?? undefined,
      cronCommitSha: commitSha,
      registrationDefaultBranch: registration.defaultBranch ?? null,
    },
    processingDeps,
    {
      runId: newRunId,
      triggerEvent: MANUAL_SCHEDULE_TRIGGER_EVENT,
      triggeredBy,
      triggeredByAgentLabel,
      // A schedule fire carries no operator input: steps and rules see the
      // declared defaults of every schedule() trigger as ctx.dispatchInputs.
      ...(dispatchInputs && { dispatchInputs }),
    },
  );
  await emitScheduleEvent({ newRunId, registration, triggeredBy, deps });

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
  };
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

async function emitScheduleEvent(args: {
  newRunId: string;
  registration: RegisteredWorkflow;
  triggeredBy: string | null;
  deps: ManualScheduleDeps;
}): Promise<void> {
  const { newRunId, registration, triggeredBy, deps } = args;
  if (!deps.eventRouter) {
    return;
  }

  await deps.eventRouter.emit({
    eventName: 'workflow.manual_schedule',
    payload: {
      newRunId,
      workflowName: registration.workflowName,
      repo: registration.repoIdentifier,
      sha: registration.commitSha,
      triggeredBy,
    },
    sourceRepo: registration.repoIdentifier,
    sourceRoutingKey: registration.routingKey,
  });
}
