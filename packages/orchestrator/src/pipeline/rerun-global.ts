/**
 * Re-run of an organization-wide run that executed against another repository.
 *
 * The workflow is resolved from the repository that DEFINES it, at the commit
 * the run recorded, and dispatched through the same pipeline a first global run
 * uses. The per-repository re-run would resolve it out of the source
 * repository's lock file instead, and so either fail or run a same-named
 * workflow of that repository.
 */
import { createLogger, toErrorMessage, type DepCacheKey } from '@kici-dev/shared';
import {
  isLockStaticJob,
  type LockWorkflow,
  type ProviderType,
  type SimulatedEvent,
} from '@kici-dev/engine';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { WebhookInfo } from '../webhook/handler.js';
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import {
  dispatchableGlobalWorkflow,
  globalRunLockFile,
  mintWorkflowRepoCredentials,
} from './global-dispatch.js';
import type { GlobalDispatchIdentity } from './global-dispatch-identity.js';
import { resolveTrustForPR } from './process-webhook.js';
import type { ProcessingDeps } from './processor.js';
import { claimRequestId } from './request-idempotency.js';
import type { OriginalRunRow, RerunDeps } from './rerun.js';
import {
  loadDeliveryEventName,
  loadWebhookPayload,
  normalizeRoundEvent,
  RELEASED_DECISION,
  resolveRerunProviderBinding,
  withChangedFiles,
  type RerunProviderBinding,
  type RerunRefusal,
} from './rerun-inputs.js';
import { webhookPayloadPath } from './webhook-payload-store.js';
import { isOrganizationWideEntry, loadWorkflowLockEntryAtSha } from './workflow-lock-at-sha.js';

const logger = createLogger({ prefix: 'rerun' });

/** True when the run executed a workflow defined in another repository. */
export function isCrossRepoGlobalRun(originalRun: OriginalRunRow): boolean {
  return (
    originalRun.workflow_repo_identifier != null &&
    originalRun.workflow_repo_identifier !== originalRun.repo_identifier
  );
}

/** The refusal wording for an organization-wide run. */
function globalRunRefusal(originalRun: OriginalRunRow): RerunRefusal {
  return {
    subject:
      `Cannot re-run organization-wide workflow '${originalRun.workflow_name}' ` +
      `(run ${originalRun.run_id})`,
    eventVerb: 'ran for',
    remedy: `Re-trigger it with a new event from ${originalRun.repo_identifier}.`,
  };
}

/** Everything a cross-repository global re-run dispatches with, rebuilt before the claim. */
interface GlobalRerunPlan {
  processingDeps: ProcessingDeps;
  payload: Record<string, unknown>;
  binding: RerunProviderBinding;
  delivery: { event: string; action: string | null };
  event: SimulatedEvent;
  eventWithFiles: SimulatedEvent;
  trustResolution: TrustResolution | undefined;
  registration: RegisteredWorkflow;
  workflow: LockWorkflow;
  /** Dependency-cache key of the lock file `workflow` was read from, at the recorded commit. */
  depCacheKey: DepCacheKey;
  global: GlobalDispatchIdentity;
}

/**
 * Re-run an organization-wide run against the commits it recorded: the source
 * repository at `sha`, and the workflow repository at `workflow_sha`.
 *
 * The workflow is read from the workflow repository's lock file at the recorded
 * commit, through that repository's registration — its provider bundle and
 * provider context — never from the registration's current lock entry, which
 * may have moved on. The run goes through the same pipeline a first global run
 * does, so contexts, holds, approval gates, and the workflow repository's
 * credentials apply exactly as they did.
 *
 * Refuses, naming the workflow repository, when the run recorded no workflow
 * commit or the workflow is no longer registered there. Nothing falls back to a
 * current lock file.
 */
export async function rerunCrossRepoGlobalRun(opts: {
  originalRun: OriginalRunRow;
  triggeredBy: string | null;
  triggeredByAgentLabel: string | null;
  deps: RerunDeps;
  requestId: string;
}): Promise<{ newRunId: string }> {
  const { originalRun, triggeredBy, triggeredByAgentLabel, deps, requestId } = opts;
  // Read-only reconstruction first: every step throws identically on both hops
  // of a relay failover re-send, so a refusal is never masked by the claim.
  const plan = await planCrossRepoGlobalRerun(originalRun, deps);

  const { newRunId, claimed } = await claimRequestId(deps.db, requestId);
  if (!claimed) {
    logger.info('Rerun requestId already claimed by a sibling; returning existing run', {
      originalRunId: originalRun.run_id,
      requestId,
      newRunId,
    });
    return { newRunId };
  }
  const rootRunId = originalRun.original_run_id ?? originalRun.run_id;
  logger.info('Re-running an organization-wide workflow', {
    originalRunId: originalRun.run_id,
    newRunId,
    rootRunId,
    workflowName: originalRun.workflow_name,
    workflowRepo: plan.registration.repoIdentifier,
    workflowSha: plan.global.workflowSha,
    sourceRepo: originalRun.repo_identifier,
    sha: originalRun.sha,
    triggeredBy,
  });
  await deps.logStorage.append(webhookPayloadPath(newRunId), JSON.stringify(plan.payload));
  const subjectEvent = originalRun.subject_trigger_event ?? originalRun.trigger_event ?? null;

  await dispatchMatchedWorkflow({
    info: globalRerunInfo(originalRun, plan, `rerun:${newRunId}`),
    deps: plan.processingDeps,
    bundle: plan.binding.providerBundle,
    payload: plan.payload,
    repoIdentifier: originalRun.repo_identifier,
    workflowRepoIdentifier: plan.registration.repoIdentifier,
    credentials: plan.binding.providerContext,
    event: plan.event,
    eventWithFiles: plan.eventWithFiles,
    ref: originalRun.sha,
    fullLockFile: globalRunLockFile(plan.workflow, {
      sourceFile: plan.registration.sourceFile,
      ...plan.depCacheKey,
    }),
    resolvedOrgId: originalRun.customer_id,
    workflow: plan.workflow,
    decision: {
      workflowName: plan.workflow.name,
      matched: true,
      checks: [],
      summary: 'Re-run of an organization-wide workflow',
    },
    runId: newRunId,
    trustResolution: plan.trustResolution,
    lockFileSource: undefined,
    localWorkingTree: false,
    crossSource: false,
    // The caller is authorized to re-run, which is the same decision an
    // approval makes; a per-repository re-run passes no trust-policy gate
    // either. Context rules and `approval` gates still hold the run.
    securityDecision: RELEASED_DECISION,
    triggerEventOverride: 'rerun',
    triggeredBy,
    triggeredByAgentLabel,
    rerunLineage: { parentRunId: originalRun.run_id, originalRunId: rootRunId },
    // Read the original's inherited subject first, so a re-run of a re-run
    // keeps the pull-request shape instead of decaying to `rerun`.
    ...(subjectEvent !== null && { subjectTriggerEvent: subjectEvent }),
    global: plan.global,
  });

  if (deps.eventRouter) {
    await deps.eventRouter.emit({
      eventName: 'workflow.rerun',
      payload: {
        parentRunId: originalRun.run_id,
        newRunId,
        workflowName: plan.workflow.name,
        repo: originalRun.repo_identifier,
        sha: originalRun.sha,
        triggeredBy,
      },
      sourceRepo: originalRun.repo_identifier,
      sourceRoutingKey: originalRun.routing_key ?? undefined,
    });
  }
  return { newRunId };
}

/** The webhook info a global re-run dispatches under. */
function globalRerunInfo(
  originalRun: OriginalRunRow,
  plan: Pick<GlobalRerunPlan, 'binding' | 'delivery' | 'payload'>,
  deliveryId: string,
): WebhookInfo {
  return {
    routingKey: plan.binding.routingKey,
    deliveryId,
    event: plan.delivery.event,
    action: plan.delivery.action,
    provider: originalRun.provider as ProviderType,
    payload: plan.payload,
  };
}

/**
 * Rebuild every input of a cross-repository global re-run. Read-only apart from
 * the workflow repository's clone-token mint, and throws on anything that
 * would make the re-run run something other than what the original ran.
 */
async function planCrossRepoGlobalRerun(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): Promise<GlobalRerunPlan> {
  const refusal = globalRunRefusal(originalRun);
  const workflowRepo = originalRun.workflow_repo_identifier ?? '';
  const workflowSha = originalRun.workflow_sha;
  // fails-when: a global run with no recorded workflow commit is re-run
  // breaks-if-wrong: a global run that recorded its workflow commit must re-run
  if (!workflowSha) {
    throw new Error(
      `${refusal.subject}: it has no recorded workflow commit in ${workflowRepo}, so the ` +
        `workflow version it ran cannot be resolved. ${refusal.remedy}`,
    );
  }
  const processingDeps = deps.processingDeps?.();
  if (!processingDeps) {
    throw new Error(
      `${refusal.subject}: this orchestrator is not wired for organization-wide dispatch.`,
    );
  }
  const registration = await resolveGlobalRerunRegistration(originalRun, processingDeps, refusal);
  const workflowBundle = deps.providerRegistry.getByRoutingKey(registration.routingKey);
  if (!workflowBundle) {
    throw new Error(
      `${refusal.subject}: the source ${registration.routingKey} of workflow repository ` +
        `${workflowRepo} is no longer registered.`,
    );
  }
  const { workflow, depCacheKey } = await globalRerunWorkflow(
    registration,
    workflowSha,
    deps,
    refusal,
  );
  // Minted before the request-id claim, although it is not read-only: a failed
  // mint must refuse on both hops of a failover re-send, and one after the claim
  // would answer the second hop with a run that never dispatched. A minted token
  // no dispatch uses expires unused.
  const workflowCredentials = await mintWorkflowRepoCredentials(workflowBundle, registration);

  const payload = await loadWebhookPayload(originalRun.run_id, deps);
  if (!payload) {
    throw new Error(`${refusal.subject}: its webhook payload was not stored. ${refusal.remedy}`);
  }
  const binding = resolveRerunProviderBinding(originalRun, deps);
  const delivery = await loadDeliveryEventName(
    await loadRerunChainRoot(originalRun, deps),
    deps,
    refusal,
  );
  const event = normalizeRoundEvent(
    originalRun,
    binding.providerBundle,
    delivery,
    payload,
    refusal,
  );
  const info = globalRerunInfo(originalRun, { binding, delivery, payload }, delivery.event);
  const eventWithFiles = await withChangedFiles({
    event,
    bundle: binding.providerBundle,
    info,
    payload,
    credentials: binding.providerContext,
    repoIdentifier: originalRun.repo_identifier,
  });
  const trust = await resolveTrustForPR({ info, bundle: binding.providerBundle, event, payload });
  return {
    processingDeps,
    payload,
    binding,
    delivery,
    event: { ...event, sourceRepo: originalRun.repo_identifier },
    eventWithFiles,
    trustResolution: trust.trustResolution,
    registration,
    workflow,
    depCacheKey,
    global: {
      workflowRepoIdentifier: registration.repoIdentifier,
      workflowSha,
      // The branch the run recorded, or none: a guessed branch would present a
      // branch-restricted context with a value nobody recorded, and none makes
      // such a context refuse.
      workflowBranch: originalRun.workflow_branch,
      workflowRoutingKey: registration.routingKey,
      workflowProviderContext: registration.providerContext,
      workflowBundle,
      workflowCredentials,
    },
  };
}

/**
 * The run whose delivery the re-run chain started from. A re-run's own
 * delivery id is synthetic and has no event log entry, so the event name is
 * read from the root of the chain.
 */
async function loadRerunChainRoot(
  originalRun: OriginalRunRow,
  deps: Pick<RerunDeps, 'db'>,
): Promise<OriginalRunRow> {
  const rootRunId = originalRun.original_run_id;
  if (!rootRunId || rootRunId === originalRun.run_id) return originalRun;
  const root = (await deps.db
    .selectFrom('execution_runs')
    .selectAll()
    .where('run_id', '=', rootRunId)
    .executeTakeFirst()) as OriginalRunRow | undefined;
  return root ?? originalRun;
}

/**
 * The workflow repository's registration of the run's workflow.
 *
 * It supplies what the lock-file fetch and the dispatch need — the routing key
 * and provider context — and it is the proof that the workflow is still
 * offered: a deleted, disabled, or policy-refused registration refuses the
 * re-run. Whether the workflow is organization-wide is judged from its entry at
 * the recorded commit (`globalRerunWorkflow`), the rule the held-round release
 * uses too.
 */
async function resolveGlobalRerunRegistration(
  originalRun: OriginalRunRow,
  deps: ProcessingDeps,
  refusal: RerunRefusal,
): Promise<RegisteredWorkflow> {
  const workflowRepo = originalRun.workflow_repo_identifier ?? '';
  const registration = deps.registrationIndex
    ?.getAllByOrgAndRepo(originalRun.customer_id, workflowRepo)
    .find((reg) => reg.workflowName === originalRun.workflow_name);
  // fails-when: the workflow's registration was deleted between the run and its re-run
  // breaks-if-wrong: a workflow still registered in its repository must re-run
  if (!registration) {
    throw new Error(
      `${refusal.subject}: workflow repository ${workflowRepo} no longer registers it. ` +
        `Push to ${workflowRepo} to register it again.`,
    );
  }
  if (registration.disabled) {
    throw new Error(`${refusal.subject}: it is disabled in workflow repository ${workflowRepo}.`);
  }
  const policy = deps.globalWorkflowPolicy;
  if (policy) {
    const source = await policy.isSourceRepoAllowed(
      originalRun.routing_key ?? '',
      originalRun.repo_identifier,
      originalRun.customer_id,
    );
    const workflow = await policy.isWorkflowRepoAllowed(
      registration.routingKey,
      workflowRepo,
      originalRun.customer_id,
    );
    const denied = !source.allowed ? source : !workflow.allowed ? workflow : undefined;
    if (denied) {
      throw new Error(
        `${refusal.subject}: the organization's global workflow policy refuses it` +
          (denied.reason ? ` (${denied.reason})` : '') +
          '.',
      );
    }
  }
  return registration;
}

/**
 * The workflow as the run ran it: the workflow repository's lock entry at the
 * recorded commit, with the static jobs a re-run dispatches. Like a
 * per-repository re-run, it repeats the declared static jobs and does not
 * replay jobs a generator produced. Returned with the dependency-cache key of
 * that commit's lock file, which the re-run's build job checks out.
 */
async function globalRerunWorkflow(
  registration: RegisteredWorkflow,
  workflowSha: string,
  deps: Pick<RerunDeps, 'providerRegistry'>,
  refusal: RerunRefusal,
): Promise<{ workflow: LockWorkflow; depCacheKey: DepCacheKey }> {
  let lockEntry: LockWorkflow;
  let depCacheKey: DepCacheKey;
  try {
    ({ lockEntry, depCacheKey } = await loadWorkflowLockEntryAtSha({
      registration,
      sha: workflowSha,
      providerRegistry: deps.providerRegistry,
    }));
  } catch (err) {
    throw new Error(`${refusal.subject}: ${toErrorMessage(err)}.`);
  }
  // fails-when: a workflow that was not organization-wide at the recorded commit re-runs as a global
  if (!isOrganizationWideEntry(lockEntry)) {
    throw new Error(
      `${refusal.subject}: at ${workflowSha} it is not an organization-wide workflow.`,
    );
  }
  const staticJobs = lockEntry.jobs.filter(isLockStaticJob);
  if (staticJobs.length === 0) {
    throw new Error(
      `${refusal.subject}: at ${workflowSha} it declares no static job to re-run. ` +
        refusal.remedy,
    );
  }
  return { workflow: dispatchableGlobalWorkflow(lockEntry, staticJobs), depCacheKey };
}
