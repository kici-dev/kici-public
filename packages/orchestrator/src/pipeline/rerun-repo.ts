/**
 * Re-run of a run whose workflow is defined in the repository it acted on.
 *
 * The re-run dispatches through the pipeline the original run went through, so
 * it gets everything that pipeline gives a run: `needs` ordering, contexts and
 * their secrets, approval gates, containers, timeouts, sandbox grants, the
 * cache identity the orchestrator resolves artifact and user-cache requests
 * against, and the trust tier of the event it re-runs.
 *
 * What started the chain's first run decides how it re-runs:
 *
 * - A schedule fire, by cron or by hand, fires again at the recorded commit
 *   through the internal-event pipeline.
 * - A webhook delivery re-runs from its stored payload through
 *   `dispatchMatchedWorkflow`, with the event, trust tier and lock file the
 *   delivery resolved. The event name comes from the delivery's event log row,
 *   which outlives the run row under the default retention windows.
 * - An internal event is read back from the event store and dispatched through
 *   the internal-event pipeline, so the re-run inherits the trust of the run
 *   that emitted it. Only an event of the run's own organization is read.
 * - A run an invoke gate summoned re-runs from its stored payload, inheriting
 *   the trust of the run that summoned it. It is not linked to that run's gate:
 *   the gate already finished.
 *
 * Anything else refuses: nothing is dispatched without the event it ran for.
 *
 * Only the run's declared static jobs re-run: jobs a generator produced are not
 * replayed. A re-run of a webhook delivery goes through the organization's trust
 * policy again, as the delivery did: re-running is not approving, so a fork
 * pull request the policy holds is held again, and one it rejects is rejected.
 * Context rules and `approval` gates hold it as they held the original.
 */
import { createLogger } from '@kici-dev/shared';
import {
  isLockStaticJob,
  type LockFile,
  type LockWorkflow,
  type ProviderType,
} from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { RerunLineage } from '../reporting/execution-tracker.js';
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import { dispatchableGlobalWorkflow } from './global-dispatch.js';
import {
  dispatchInternalEventViaPipeline,
  InternalSystemEventName,
  type InternalEventDispatchContext,
} from './internal-event-pipeline.js';
import { MANUAL_SCHEDULE_TRIGGER_EVENT } from './manual-schedule.js';
import { resolveTrustForPR } from './process-webhook.js';
import { resolveOrgId, type ProcessingDeps } from './processor.js';
import type { OriginalRunRow, RerunDeps } from './rerun.js';
import { loadRerunChainRoot } from './rerun-global.js';
import {
  claimRerunRequest,
  emitWorkflowRerun,
  findDeliveryEventName,
  rerunSecurityDecision,
  loadWebhookPayload,
  normalizeRoundEvent,
  resolveRerunProviderBinding,
  withChangedFiles,
  type RerunProviderBinding,
  type RerunRefusal,
} from './rerun-inputs.js';

const logger = createLogger({ prefix: 'rerun' });

/** The `trigger_event` every re-run records. */
const RERUN_TRIGGER_EVENT = 'rerun';

/** The `trigger_event` a cron schedule fire records. */
const SCHEDULE_TRIGGER_EVENT = 'schedule';

/** A `kici_events.id` is a UUID; any other delivery id names no stored event. */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function repoRunRefusal(originalRun: OriginalRunRow): RerunRefusal {
  return {
    subject: `Cannot re-run run ${originalRun.run_id}`,
    eventVerb: 'ran for',
    remedy: 'Start a new run instead.',
  };
}

/** What every re-run dispatch carries besides its inputs. */
interface RerunIdentity {
  runId: string;
  triggeredBy: string | null;
  triggeredByAgentLabel: string | null;
  rerunLineage: RerunLineage;
  /** The original's inherited subject first, so a re-run of a re-run keeps the pull-request shape. */
  subjectTriggerEvent: string | undefined;
}

/** A re-run rebuilt from the original run, ready to dispatch under a claimed run id. */
interface RepoRerunPlan {
  workflow: LockWorkflow;
  dispatch: (identity: RerunIdentity) => Promise<void>;
}

/**
 * Re-run a per-repository run. Every input is rebuilt and checked before the
 * request id is claimed, so a refusal reads the same on both hops of a relay
 * failover re-send.
 */
export async function rerunRepositoryRun(opts: {
  originalRun: OriginalRunRow;
  triggeredBy: string | null;
  triggeredByAgentLabel: string | null;
  deps: RerunDeps;
  requestId: string;
}): Promise<{ newRunId: string }> {
  const { originalRun, triggeredBy, triggeredByAgentLabel, deps, requestId } = opts;
  const plan = await planRepositoryRerun(originalRun, deps);

  const { newRunId, claimed } = await claimRerunRequest(deps, requestId, originalRun.run_id);
  if (!claimed) return { newRunId };

  const rootRunId = originalRun.original_run_id ?? originalRun.run_id;
  logger.info('Re-running workflow', {
    originalRunId: originalRun.run_id,
    newRunId,
    rootRunId,
    workflowName: originalRun.workflow_name,
    sha: originalRun.sha,
    triggeredBy,
  });

  await plan.dispatch({
    runId: newRunId,
    triggeredBy,
    triggeredByAgentLabel,
    rerunLineage: { parentRunId: originalRun.run_id, originalRunId: rootRunId },
    subjectTriggerEvent:
      originalRun.subject_trigger_event ?? originalRun.trigger_event ?? undefined,
  });

  await emitWorkflowRerun(deps, {
    originalRun,
    newRunId,
    workflowName: plan.workflow.name,
    triggeredBy,
  });
  return { newRunId };
}

async function planRepositoryRerun(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): Promise<RepoRerunPlan> {
  const refusal = repoRunRefusal(originalRun);
  const processingDeps = deps.processingDeps?.();
  if (!processingDeps) {
    throw new Error(`${refusal.subject}: this orchestrator is not wired to dispatch a re-run.`);
  }
  const binding = resolveRerunProviderBinding(originalRun, deps);
  const root = await loadRerunChainRoot(originalRun, deps);
  const internal = { originalRun, binding, processingDeps };

  if (
    root.trigger_event === SCHEDULE_TRIGGER_EVENT ||
    root.trigger_event === MANUAL_SCHEDULE_TRIGGER_EVENT
  ) {
    return planInternalRerun({
      ...internal,
      event: {
        id: `${RERUN_TRIGGER_EVENT}:${originalRun.run_id}`,
        eventName: InternalSystemEventName.enum.__schedule_fire,
        payload: { commitSha: originalRun.sha },
      },
    });
  }

  // The pipeline stores every run's payload, an internal event's included, so
  // a stored payload alone does not say the run was a delivery.
  const payload = await loadWebhookPayload(originalRun.run_id, deps);
  if (payload && root.summoned_by_run_id && root.trigger_event && root.delivery_id) {
    return planInternalRerun({
      ...internal,
      event: { id: root.delivery_id, eventName: root.trigger_event, payload },
      summonedByRunId: root.summoned_by_run_id,
    });
  }
  const delivery = await findDeliveryEventName(root, deps);
  if (payload && delivery) {
    return planWebhookRerun({ originalRun, payload, delivery, binding, processingDeps, refusal });
  }
  const stored = await loadStoredInternalEvent(root, deps);
  if (stored) return planInternalRerun({ ...internal, event: stored });
  // fails-when: a run whose event is gone re-runs with no event
  throw new Error(
    `${refusal.subject}: the event it ${refusal.eventVerb} is no longer stored, so it cannot ` +
      `be rebuilt. ${refusal.remedy}`,
  );
}

/** A run a webhook started: the stored delivery, normalized and trust-resolved as it was. */
async function planWebhookRerun(args: {
  originalRun: OriginalRunRow;
  payload: Record<string, unknown>;
  /** Read from the delivery that started the chain: a re-run's own delivery id is synthetic. */
  delivery: { event: string; action: string | null };
  binding: RerunProviderBinding;
  processingDeps: ProcessingDeps;
  refusal: RerunRefusal;
}): Promise<RepoRerunPlan> {
  const { originalRun, payload, delivery, binding, processingDeps, refusal } = args;
  const { providerBundle: bundle, providerContext: credentials, routingKey } = binding;
  const event = normalizeRoundEvent(originalRun, bundle, delivery, payload, refusal);
  const info: WebhookInfo = {
    routingKey,
    deliveryId: delivery.event,
    event: delivery.event,
    action: delivery.action,
    provider: originalRun.provider as ProviderType,
    payload,
  };
  const eventWithFiles = await withChangedFiles({
    event,
    bundle,
    info,
    payload,
    credentials,
    repoIdentifier: originalRun.repo_identifier,
  });
  const trust = await resolveTrustForPR({ info, bundle, event, payload });
  const securityDecision = await rerunSecurityDecision({
    processingDeps,
    bundle,
    delivery,
    originalRun,
    trustResolution: trust.trustResolution,
    event,
    refusal,
  });
  // An untrusted pull request ran the base branch's lock file, never its own.
  const lockRef =
    trust.lockFileSource === 'base' && event.baseBranch ? event.baseBranch : originalRun.sha;
  const { lockFile, workflow } = await rerunWorkflowAt(originalRun, binding, lockRef);

  return {
    workflow,
    dispatch: async (identity) => {
      // The pipeline stores the payload under the new run, for its payload
      // viewer and a re-run of the re-run.
      await dispatchMatchedWorkflow({
        info: { ...info, deliveryId: `${RERUN_TRIGGER_EVENT}:${identity.runId}` },
        deps: processingDeps,
        bundle,
        payload,
        repoIdentifier: originalRun.repo_identifier,
        workflowRepoIdentifier: originalRun.repo_identifier,
        credentials,
        event,
        eventWithFiles,
        ref: originalRun.sha,
        fullLockFile: { ...lockFile, workflows: [workflow] },
        resolvedOrgId: originalRun.customer_id,
        workflow,
        decision: rerunDecision(workflow),
        runId: identity.runId,
        trustResolution: trust.trustResolution,
        lockFileSource: trust.lockFileSource,
        localWorkingTree: false,
        crossSource: false,
        securityDecision,
        triggerEventOverride: RERUN_TRIGGER_EVENT,
        triggeredBy: identity.triggeredBy,
        triggeredByAgentLabel: identity.triggeredByAgentLabel,
        rerunLineage: identity.rerunLineage,
        ...(identity.subjectTriggerEvent !== undefined && {
          subjectTriggerEvent: identity.subjectTriggerEvent,
        }),
      });
    },
  };
}

/**
 * A run the orchestrator started, dispatched again through the internal-event
 * pipeline at the commit it recorded, and at its chain depth, so an invoke gate
 * in it cannot summon past the bound its first run counted toward.
 */
async function planInternalRerun(args: {
  originalRun: OriginalRunRow;
  binding: RerunProviderBinding;
  processingDeps: ProcessingDeps;
  event: InternalEventDispatchContext['event'];
  /** The run whose invoke gate summoned the original; the re-run inherits its trust. */
  summonedByRunId?: string;
}): Promise<RepoRerunPlan> {
  const { originalRun, binding, processingDeps, event, summonedByRunId } = args;
  const { lockFile, workflow } = await rerunWorkflowAt(originalRun, binding, originalRun.sha);
  const registration = processingDeps.registrationIndex
    ?.getAllByOrgAndRepo(originalRun.customer_id, originalRun.repo_identifier)
    .find((reg) => reg.workflowName === originalRun.workflow_name);
  const ctx: InternalEventDispatchContext = {
    event,
    routingKey: binding.routingKey,
    repoIdentifier: originalRun.repo_identifier,
    providerContext: binding.providerContext,
    providerType: binding.routingKey.split(':')[0] as 'github',
    bundle: binding.providerBundle,
    cronCommitSha: originalRun.sha,
    // A schedule fire presents the registration's default branch, as it did.
    registrationDefaultBranch: registration?.defaultBranch ?? null,
    ...(originalRun.chain_depth > 0 && { chainDepth: originalRun.chain_depth }),
    ...(summonedByRunId && { summonedByRunId }),
  };
  return {
    workflow,
    dispatch: async (identity) => {
      await dispatchInternalEventViaPipeline(
        rerunDecision(workflow),
        { ...lockFile, workflows: [workflow] },
        ctx,
        processingDeps,
        {
          runId: identity.runId,
          triggerEvent: RERUN_TRIGGER_EVENT,
          triggeredBy: identity.triggeredBy,
          triggeredByAgentLabel: identity.triggeredByAgentLabel,
          rerunLineage: identity.rerunLineage,
          ...(identity.subjectTriggerEvent !== undefined && {
            subjectTriggerEvent: identity.subjectTriggerEvent,
          }),
        },
      );
    },
  };
}

/**
 * The internal event a run ran for, read back from the event store by the
 * chain root's delivery id (an internal run's delivery id is its event's id).
 * `null` when the delivery id names no stored event, or an event of another
 * organization: a generic source's delivery id is chosen by its sender, so an
 * id alone never proves the event is the run's.
 */
async function loadStoredInternalEvent(
  root: OriginalRunRow,
  deps: Pick<RerunDeps, 'db'>,
): Promise<InternalEventDispatchContext['event'] | null> {
  const eventId = root.delivery_id ?? '';
  if (!EVENT_ID.test(eventId)) return null;
  const stored = await deps.db
    .selectFrom('kici_events')
    .select(['id', 'event_name', 'payload', 'source_run_id', 'source_routing_key'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!stored) return null;
  // fails-when: another organization's event is re-run under this run's name
  // breaks-if-wrong: an event this organization emitted must still re-run
  if ((await storedEventOrg(stored, deps)) !== root.customer_id) return null;
  return {
    id: stored.id,
    eventName: stored.event_name,
    payload: parseEventPayload(stored.payload),
  };
}

/**
 * The organization that owns a stored event: its emitting run's, else its
 * source's. `null` when neither is recorded, which owns nothing.
 */
async function storedEventOrg(
  stored: { source_run_id: string | null; source_routing_key: string | null },
  deps: Pick<RerunDeps, 'db'>,
): Promise<string | null> {
  if (stored.source_run_id) {
    const emitter = await deps.db
      .selectFrom('execution_runs')
      .select('customer_id')
      .where('run_id', '=', stored.source_run_id)
      .executeTakeFirst();
    return emitter?.customer_id ?? null;
  }
  return stored.source_routing_key ? resolveOrgId(deps.db, stored.source_routing_key) : null;
}

function parseEventPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The run's workflow from its lock file at `ref`, limited to its declared static
 * jobs. Its filter already passed on the original run, so it is not evaluated
 * again.
 */
async function rerunWorkflowAt(
  originalRun: OriginalRunRow,
  binding: RerunProviderBinding,
  ref: string,
): Promise<{ lockFile: LockFile; workflow: LockWorkflow }> {
  const fetcher = binding.providerBundle.lockFileFetcher;
  if (!fetcher) {
    throw new Error(`Provider ${originalRun.provider} does not support lock file fetching`);
  }
  const lockFile = (await fetcher.fetchLockFile(
    originalRun.repo_identifier,
    ref,
    binding.providerContext,
  )) as LockFile | null;
  if (!lockFile) {
    throw new Error(
      ref === originalRun.sha
        ? 'Lock file not found at original SHA (branch may have been force-pushed)'
        : `Lock file not found on branch ${ref}`,
    );
  }
  const entry = lockFile.workflows.find((w) => w.name === originalRun.workflow_name);
  if (!entry) {
    throw new Error(`Workflow '${originalRun.workflow_name}' not found in lock file at ${ref}`);
  }
  return {
    lockFile,
    workflow: dispatchableGlobalWorkflow(entry, entry.jobs.filter(isLockStaticJob)),
  };
}

function rerunDecision(workflow: LockWorkflow) {
  return {
    workflowName: workflow.name,
    matched: true,
    checks: [],
    summary: 'Re-run',
  };
}
