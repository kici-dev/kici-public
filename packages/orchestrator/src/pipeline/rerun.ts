/**
 * Re-run handler for the orchestrator.
 *
 * Loads an original completed run, retrieves its webhook payload from
 * object storage, re-fetches the lock file at the original SHA, and
 * dispatches a new run with parent_run_id linkage.
 *
 * This is NOT a reuse of processWebhook -- it's a separate, simpler function
 * that skips dedup, normalization, trigger matching, and changed files fetching.
 * It goes directly to: lock file parse -> job expansion -> dispatch.
 */

import { createLogger, type ColdStore } from '@kici-dev/shared';
import type { Kysely, Selectable } from 'kysely';
import type { Database, ExecutionRunTable } from '../db/types.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { JobQueue } from '../queue/job-queue.js';
import type { PlatformClient } from '../ws/platform-client.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { RunCoordinator } from '../cluster/coordinator.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { EventRouter } from '../events/event-router.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { SourceCache } from '../cache/index.js';
import type { BuildCoordinator } from '../cache/index.js';
import type { DepCache } from '../cache/index.js';
import type { PendingBuildTracker } from '../cache/index.js';
import { claimRequestId } from './request-idempotency.js';
import type { RunContext } from '../cluster/coordinator.js';
import {
  routeOrDispatchJobs,
  registerDispatchedJobs,
  type DispatchedJobEntry,
  type RejectedJobEntry,
} from './route-or-dispatch-jobs.js';
import { isLockStaticJob, TERMINAL_RUN_STATES, matrixEnvelopeFields } from '@kici-dev/engine';
import type { LockFile as FullLockFile, LockWorkflow, MaterializedJob } from '@kici-dev/engine';
import { webhookPayloadPath } from './webhook-payload-store.js';
import {
  dispatchGlobalWorkflowsForOtherRepos,
  evaluateSecurityPolicy,
  isPullRequestEvent,
  resolveTrustForPR,
} from './process-webhook.js';
import type { ProcessingDeps } from './processor.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderType, SimulatedEvent } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'rerun' });

/**
 * Thrown when a rerun is attempted on a run whose row is absent from PG AND
 * the cold-store replay path failed or is unavailable (chunk missing,
 * contentHash mismatch, S3 outage, or cold-store probe disabled). Signals a
 * genuine "we tried to bring the row back and could not".
 *
 * The WS dashboard handler maps this to a structured response that the
 * Platform proxy surfaces as HTTP 410 (`errorCode: 'runArchivedNotRerunnable'`).
 */
export class RunArchivedNotRerunnableError extends Error {
  readonly code = 'runArchivedNotRerunnable' as const;
  constructor(public readonly runId: string) {
    super(
      `Run ${runId} was archived to cold storage and the chunk could not be replayed back into the orchestrator DB. ` +
        `Rerun is not possible until the chunk is restored (kici-admin cold-store replay-into-pg).`,
    );
    this.name = 'RunArchivedNotRerunnableError';
  }
}

export interface RerunDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
  providerRegistry: ProviderRegistry;
  executionTracker: ExecutionTracker;
  dispatcher: Dispatcher;
  jobQueue: JobQueue;
  platformClient: PlatformClient | null;
  checkRunReporter: CheckRunReporter | null;
  coordinator: RunCoordinator | null;
  secretResolver: SecretResolver | null;
  eventRouter: EventRouter | null;
  agentRegistry: AgentRegistry;
  sourceCache: SourceCache | null;
  depCache: DepCache | null;
  buildCoordinator: BuildCoordinator | null;
  pendingBuilds: PendingBuildTracker | null;
  /**
   * When set, a PG miss on `originalRunId` triggers a cold-store replay of
   * the chunk containing the row, then a re-read. `null` keeps the "throw
   * RunArchivedNotRerunnableError on PG miss" path for deployments without
   * cold-store wired up.
   */
  coldStore: ColdStore | null;
  /**
   * The live webhook-processing bag, assembled on demand.
   *
   * Only the re-run of a failed global evaluation round needs it: that re-run
   * re-drives the organization-wide pass, which reaches deps an ordinary
   * workflow re-run never touches (the registration index, the policy reader,
   * the pending-eval tracker). Supplied by the entry point that already
   * assembles the bag for the inbound webhook path, so the two cannot drift.
   * Absent means round re-runs are not available on this deployment.
   */
  processingDeps?: (() => ProcessingDeps) | null;
}

/**
 * Original run row from execution_runs (selectAll).
 * Aliased to the Kysely Selectable so all column names stay typed
 * as the underlying schema.
 */
type OriginalRunRow = Selectable<ExecutionRunTable>;

/** Lock-file workflow + provider bundle resolved at the original SHA. */
interface ResolvedRerunWorkflow {
  workflow: LockWorkflow;
  fullLockFile: FullLockFile;
  providerContext: Record<string, unknown>;
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  /** Validated routing key (non-null — `resolveRerunWorkflow` throws on missing). */
  routingKey: string;
}

export async function handleRerun(
  originalRunId: string,
  triggeredBy: string | null,
  triggeredByAgentLabel: string | null,
  deps: RerunDeps,
  /**
   * Platform-minted `requestId` for this rerun. Stable across an HA relay
   * failover re-send (the Platform re-sends the same message verbatim to a
   * sibling coordinator on a timeout), so it is the idempotency key: after the
   * read-only validation, the first coordinator to claim it creates the run and
   * a failover re-send returns that same run instead of minting a second one.
   */
  requestId: string,
  /**
   * Routing key for the original run, forwarded by Platform via the WS
   * `run.rerun.request` payload. Required to address the cold-store chunk
   * under the right tenant prefix.
   */
  routingKeyHint?: string,
): Promise<{ newRunId: string }> {
  // 1-3. Load + validate the original run (with cold-store replay fallback).
  const originalRun = await loadAndValidateOriginalRun(originalRunId, routingKeyHint, deps);

  // A failed global evaluation round is re-run as a re-evaluation of the
  // original event, not as a workflow re-run: the round decided nothing, so
  // there is no workflow to resolve and re-dispatch. Routed structurally on the
  // run row's own marker, never on the round job's name.
  if (originalRun.is_global_eval_round === true) {
    return rerunGlobalEvalRound(originalRun, deps, requestId);
  }

  // 4. Load webhook payload from object storage (optional — cron/schedule runs have no payload)
  const payload = await loadWebhookPayload(originalRunId, deps);

  // 5. Re-fetch lock file at original SHA + resolve provider bundle.
  const resolved = await resolveRerunWorkflow(originalRun, deps);

  // 6. Claim this rerun by its Platform `requestId` BEFORE the first write.
  // Validation above (load/replay/resolve) is read-only and identical across
  // failover hops, so it throws consistently on both and is never masked by a
  // claim. The atomic claim guards only the create+dispatch: on a relay
  // failover re-send a sibling coordinator already owns this requestId, so we
  // return its run id without minting a second run.
  const { newRunId, claimed } = await claimRequestId(deps.db, requestId);
  if (!claimed) {
    logger.info('Rerun requestId already claimed by a sibling; returning existing run', {
      originalRunId,
      requestId,
      newRunId,
    });
    return { newRunId };
  }

  const rootRunId = originalRun.original_run_id ?? originalRunId;
  const commitMessage = extractCommitMessage(payload);

  logger.info('Re-running workflow', {
    originalRunId,
    newRunId,
    rootRunId,
    workflowName: originalRun.workflow_name,
    sha: originalRun.sha,
    triggeredBy,
  });

  // Store payload for the new run (so it also has a payload available for the payload viewer
  // and for a future re-run of the re-run). Skip if there was no payload (cron/schedule runs).
  if (payload) {
    const newPayloadPath = webhookPayloadPath(newRunId);
    await deps.logStorage.append(newPayloadPath, JSON.stringify(payload));
  }

  // 7a. Record execution start BEFORE dispatch so that when jobs are rerouted
  // to peers, the coordinator's rerouted onExecutionStarted call (which lacks
  // rerun-specific metadata like parentRunId) hits ON CONFLICT DO NOTHING and
  // preserves the rich row we insert here. Jobs are added below via
  // executionTracker.addJobsToRun once dispatched locally.
  await recordRerunExecutionStart({
    deps,
    newRunId,
    originalRun,
    originalRunId,
    rootRunId,
    workflow: resolved.workflow,
    providerContext: resolved.providerContext,
    triggeredBy,
    triggeredByAgentLabel,
    commitMessage,
  });

  // 7b. Dispatch: coordinator-routed (cluster mode) or direct (standalone).
  const { dispatchedJobs, rejectedJobs } = await dispatchRerunJobs({
    deps,
    newRunId,
    originalRun,
    resolved,
    payload,
  });

  // 7c. Register dispatched jobs with the execution tracker (dispatcher-assigned IDs).
  await registerDispatchedJobs({
    newRunId,
    dispatchedJobs,
    rejectedJobs,
    executionTracker: deps.executionTracker,
  });

  // 8 + 9. Fire workflow.rerun event + GitHub check run.
  await emitRerunEventAndCheckRun({
    deps,
    originalRun,
    originalRunId,
    newRunId,
    workflow: resolved.workflow,
    providerContext: resolved.providerContext,
    triggeredBy,
  });

  return { newRunId };
}

/**
 * Phase 1-3: load the original run from the orchestrator DB, attempting a
 * cold-store replay if the row is missing, then validate that the run is
 * in a terminal state and is not a test run. Throws on any precondition
 * failure.
 */
async function loadAndValidateOriginalRun(
  originalRunId: string,
  routingKeyHint: string | undefined,
  deps: RerunDeps,
): Promise<OriginalRunRow> {
  // 1. Load original run from DB
  let originalRun = await deps.db
    .selectFrom('execution_runs')
    .selectAll()
    .where('run_id', '=', originalRunId)
    .executeTakeFirst();

  if (!originalRun) {
    // Attempt to restore the row from cold-store before failing.
    // Requires (a) cold-store wired into deps, and (b) Platform forwarded
    // `routingKey` over the WS protocol so we know which tenant prefix
    // to scan. Both conditions hold for the standard hybrid deploy; a
    // standalone orchestrator without Platform forwarding falls through
    // to the RunArchivedNotRerunnableError path below.
    if (deps.coldStore && routingKeyHint) {
      try {
        const replay = await deps.coldStore.replayRow({
          db: 'orchestrator',
          table: 'execution_runs',
          tenantId: routingKeyHint,
          rowId: originalRunId,
        });
        if (replay.chunkId) {
          originalRun = await deps.db
            .selectFrom('execution_runs')
            .selectAll()
            .where('run_id', '=', originalRunId)
            .executeTakeFirst();
          logger.info('rerun: restored archived run from cold-store', {
            runId: originalRunId,
            chunkId: replay.chunkId,
            inserted: replay.inserted,
            skipped: replay.skipped,
            routingKey: routingKeyHint,
          });
        }
      } catch (err) {
        logger.error('rerun: cold-store replayRow threw', {
          runId: originalRunId,
          routingKey: routingKeyHint,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new RunArchivedNotRerunnableError(originalRunId);
      }
    }
    if (!originalRun) {
      // Cold-store unavailable, no chunk found, or replay returned no
      // rows. Surface the structured error so the Platform proxy can
      // render HTTP 410 with `errorCode: 'runArchivedNotRerunnable'`.
      throw new RunArchivedNotRerunnableError(originalRunId);
    }
  }

  // 2. Validate terminal state
  if (!TERMINAL_RUN_STATES.has(originalRun.status)) {
    throw new Error(`Run is not in a terminal state (current: ${originalRun.status})`);
  }

  // 3. Only webhook runs can be re-run (not test runs)
  if (originalRun.is_test_run) {
    throw new Error('Test runs cannot be re-run');
  }

  // 4. A failed global evaluation round is exempt from the cross-repository
  // refusal below. A round is definitionally cross-repository — it exists to
  // decide one repository's global workflows against another repository's event
  // — so the refusal would reject every one of them. The reasoning the refusal
  // rests on does not apply either: the round path resolves no workflow out of
  // `repo_identifier`'s lock file, so there is no same-named workflow it could
  // silently run instead. It re-evaluates the original event and dispatches
  // only what the evaluation itself admits.
  if (originalRun.is_global_eval_round === true) {
    return originalRun as OriginalRunRow;
  }

  // 5. An organization-wide workflow that ran against another repository
  // cannot be re-run. Everything below resolves the workflow out of
  // `repo_identifier`'s lock file, and for such a run that column is the
  // repository the workflow ran AGAINST, not the one that defines it. So the
  // rerun would either fail with a misleading force-push message or — if the
  // acted-on repository happens to define a workflow of the same name —
  // silently run THAT workflow instead, with the acted-on repository's
  // credentials and none of the organization-wide job configuration.
  // Refusing is the honest answer until the rerun path can resolve a workflow
  // from the repository that defines it.
  //
  // BEFORE LIFTING THIS: it is load-bearing for authorization, not only for
  // correctness. The Platform grants re-run to a member scoped to EITHER of a
  // global run's repositories (`checkRunRepoAccess`, and the either-repository
  // rule in `docs/architecture/security/rbac.md`), on the basis that no caller
  // can actually re-execute a cross-repository global run.
  //
  // The Platform enforces that itself — `crossRepoGlobalRerunRefusal` in
  // `dev-ops/rerun-policy.ts` refuses the same case on its own mirrored column,
  // on both the dashboard and MCP planes — so this refusal is defence in depth
  // rather than the sole guarantee, and lifting it alone does not widen the
  // grant. It still matters here: this is the tier that holds the credentials
  // and the lock file, and it is the only one that sees a run the Platform
  // never mirrored.
  //
  // A rerun path that CAN resolve the defining repository has to answer the
  // authorization question first — which of the two repositories may re-execute
  // this, and with whose credentials — and lift BOTH refusals deliberately.
  // Widen them into that decision; do not simply delete this one.
  //
  // That question is answered for exactly one case: a failed global evaluation
  // round, which both tiers admit ahead of this comparison. Scope on the source
  // repository is enough to re-run one, because a member holding it can already
  // trigger the identical round by pushing a commit — the re-run grants no
  // capability they lack. It re-evaluates the original event through the same
  // policy axes and dispatches whatever that evaluation admits; it never lets a
  // caller choose which workflow runs. The refusal below still stands for every
  // ordinary organization-wide workflow run, where the substitution it guards
  // against is reachable.
  if (
    originalRun.workflow_repo_identifier &&
    originalRun.workflow_repo_identifier !== originalRun.repo_identifier
  ) {
    throw new Error(
      `Cannot re-run an organization-wide workflow: '${originalRun.workflow_name}' is defined in ` +
        `${originalRun.workflow_repo_identifier} but this run executed against ` +
        `${originalRun.repo_identifier}. Re-trigger it from ${originalRun.workflow_repo_identifier} instead.`,
    );
  }

  return originalRun as OriginalRunRow;
}

/**
 * Phase 4: load the original webhook payload from object storage. Returns
 * null for cron/schedule runs (no payload was stored) or when the payload
 * cannot be parsed.
 */
async function loadWebhookPayload(
  originalRunId: string,
  deps: RerunDeps,
): Promise<Record<string, unknown> | null> {
  const payloadPath = webhookPayloadPath(originalRunId);
  const payloadResult = await deps.logStorage.read(payloadPath);
  if (!payloadResult.data) return null;
  try {
    return JSON.parse(payloadResult.data);
  } catch {
    // Corrupted or unparseable payload — treat as missing
    return null;
  }
}

/** The provider bundle + context a re-run resolves out of the original run's row. */
interface RerunProviderBinding {
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  providerContext: Record<string, unknown>;
  routingKey: string;
}

/**
 * Resolve the provider bundle and stored provider context for a run being
 * re-run.
 *
 * Shared by the workflow re-run and the evaluation-round re-run so the two
 * cannot disagree about which source a run belongs to, or about how its
 * `provider_context` column is parsed.
 */
function resolveRerunProviderBinding(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): RerunProviderBinding {
  if (!originalRun.routing_key) {
    throw new Error(
      `Re-run failed: original run ${originalRun.run_id} has no routing_key — cannot select provider bundle`,
    );
  }
  const providerBundle = deps.providerRegistry.getByRoutingKey(originalRun.routing_key);
  if (!providerBundle) {
    throw new Error(`Provider bundle for routing key ${originalRun.routing_key} not registered`);
  }
  const providerContext = JSON.parse(
    typeof originalRun.provider_context === 'string'
      ? originalRun.provider_context
      : JSON.stringify(originalRun.provider_context ?? {}),
  );
  return { providerBundle, providerContext, routingKey: originalRun.routing_key };
}

/**
 * The provider event name + action the original delivery carried.
 *
 * `execution_runs` records neither: the event name arrives in a provider header,
 * not in the payload, so it cannot be recovered from the stored payload either.
 * The delivery's own `event_log` row is where it lives, and a round's run row
 * carries the delivery id that addresses it. That row is written at the end of
 * the delivery, after the round's failure is recorded, so it is present for
 * every re-run an operator can actually reach.
 *
 * Addressed by `(org_id, delivery_id)` — the table's own uniqueness — never by
 * the delivery id alone. A generic source's delivery id is taken verbatim from
 * a sender-supplied header, so one tenant can choose an id another tenant's
 * round already carries; a lookup by id alone would then re-evaluate one org's
 * global workflows against another org's event shape, and with no `ORDER BY`
 * the row it picked would not even be stable.
 */
async function loadDeliveryEventName(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): Promise<{ event: string; action: string | null }> {
  const deliveryId = originalRun.delivery_id;
  if (!deliveryId) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: it records no delivery id, so the ` +
        `event it was deciding cannot be identified. Push a new commit to re-evaluate the ` +
        `organization's workflows.`,
    );
  }
  const row = await deps.db
    .selectFrom('event_log')
    .select(['event', 'action'])
    .where('org_id', '=', originalRun.customer_id)
    .where('delivery_id', '=', deliveryId)
    .executeTakeFirst();
  if (!row?.event) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: no event log entry for delivery ` +
        `${deliveryId} is available, so the event it was deciding cannot be reconstructed. ` +
        `Push a new commit to re-evaluate the organization's workflows.`,
    );
  }
  return { event: row.event, action: row.action ?? null };
}

/**
 * Re-run of a failed global evaluation round: re-drive the organization-wide
 * pass for the round's workflow repo from the stored webhook payload.
 *
 * This is a re-evaluation, not a workflow re-run — the pass itself dispatches
 * whatever it admits, exactly as it would have on the original delivery. Every
 * input is recomputed against current state, which is what lets a fixed
 * workflow repository flip the verdict without a new commit.
 */
async function rerunGlobalEvalRound(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
  requestId: string,
): Promise<{ newRunId: string }> {
  const payload = await loadWebhookPayload(originalRun.run_id, deps);
  if (!payload) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: its webhook payload was not stored. ` +
        `Push a new commit to re-evaluate the organization's workflows.`,
    );
  }
  const buildProcessingDeps = deps.processingDeps;
  if (!buildProcessingDeps) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: this orchestrator is not wired for ` +
        `organization-wide dispatch. Push a new commit to re-evaluate the organization's workflows.`,
    );
  }

  // Read-only reconstruction FIRST — ALL of it, for the same reason the workflow
  // path validates before claiming: every step below throws identically on both
  // hops of a relay failover re-send, so doing one after the claim would let the
  // first hop's failure be reported to the second as a success — HTTP 200 with
  // the round's own run id, telling the operator a re-run happened when nothing
  // ran. Anything that can throw belongs above the claim, not merely most of it.
  const binding = resolveRerunProviderBinding(originalRun, deps);
  const dispatch = resolveRoundDispatchBinding(originalRun, deps, binding);
  const delivery = await loadDeliveryEventName(originalRun, deps);
  const workflowRepo = resolveRoundWorkflowRepo(originalRun);
  const event = normalizeRoundEvent(originalRun, binding.providerBundle, delivery, payload);

  // The round's own re-evaluation is what dispatches, so the claim guards it
  // exactly as it guards a workflow re-run's dispatch. On a relay failover
  // re-send a sibling coordinator already owns this requestId and has already
  // re-evaluated, so this hop does nothing further.
  const { claimed } = await claimRequestId(deps.db, requestId);
  if (!claimed) {
    logger.info('Eval-round rerun requestId already claimed by a sibling; returning', {
      runId: originalRun.run_id,
      requestId,
    });
    return { newRunId: originalRun.run_id };
  }

  // The re-evaluation runs DETACHED, and the request is answered now — the same
  // shape the delivery that first dispatched this round already has. A generic
  // webhook is answered 202 the moment the delivery is durably queued
  // (`routes/webhooks.ts`), explicitly NOT asserting that anything matched or
  // dispatched; the whole pipeline, `runGlobalEvalRounds` included, runs after
  // the response is sent, and its outcomes reach the event log, the run list
  // and the check.
  //
  // Awaiting the round here answers no caller. A round is a dispatched job: it
  // hands an evaluation job to an agent, which clones both repositories and
  // runs every candidate's filter, and its own budget is minutes. The requester
  // is a relayed dashboard call whose budget is ten seconds, so the await
  // guaranteed a gateway timeout on a re-evaluation that then completed
  // unobserved — the Re-run button could not succeed on any failed round.
  //
  // Nothing is lost by answering early. The response carries the round's OWN
  // run id, not a freshly minted one — a re-evaluation creates no run of its
  // own, and whatever it admits has its own ids already — so the value is known
  // before the round starts. Everything that can refuse has already run above:
  // the reconstruction is complete and the claim is taken, so a failure past
  // this point is operational, and is read from the round exactly as it is for
  // a delivery.
  const reevaluation = reevaluateGlobalRound({
    originalRun,
    payload,
    processingDeps: buildProcessingDeps(),
    binding,
    dispatch,
    delivery,
    workflowRepo,
    event,
  })
    .then((outcome) => {
      logger.info('Re-evaluated a failed global eval round', {
        runId: originalRun.run_id,
        workflowRepo: outcome.workflowRepo,
        admitted: outcome.matchedCount,
        decided: outcome.decided,
        failedAgain: outcome.failedAgain,
        skippedByPolicy: outcome.skippedByPolicy,
      });
    })
    .catch((err: unknown) => {
      // Reported here or nowhere: the requester was answered before this ran.
      logger.error('Eval-round re-evaluation failed after the request was answered', {
        runId: originalRun.run_id,
        workflowRepo,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      pendingRoundReevaluations.delete(reevaluation);
    });
  pendingRoundReevaluations.add(reevaluation);

  return { newRunId: originalRun.run_id };
}

/**
 * Re-evaluations started but not yet settled.
 *
 * Membership is the only handle on work nobody awaits: a detached promise
 * cannot otherwise be observed. Every entry carries its own `catch` above, so
 * nothing in this set can reject.
 */
const pendingRoundReevaluations = new Set<Promise<void>>();

/**
 * Settle every detached re-evaluation started so far.
 *
 * Nothing in a running orchestrator calls this — the re-evaluation is detached
 * precisely so no request waits on it. It exists so a caller that needs the
 * work to have finished (a test asserting on the pass) can wait for it
 * deterministically instead of racing the microtask queue.
 */
export async function settlePendingRoundReevaluations(): Promise<void> {
  while (pendingRoundReevaluations.size > 0) {
    await Promise.all([...pendingRoundReevaluations]);
  }
}

/** The bundle a round's stored `provider_context` actually belongs to. */
interface RoundDispatchBinding {
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  routingKey: string;
}

/**
 * The provider bundle whose credentials the round's `provider_context` holds.
 *
 * `routing_key` names the source the event ARRIVED on; `provider_context` holds
 * the DISPATCH credentials, and for a cross-provider global those are two
 * different sources — the lock file resolved through the other source's bundle.
 * Pairing the inbound bundle with the stored context hands one source's
 * credentials to the other source's API client: the fetch either fails or reads
 * the wrong tree, every candidate drops indeterminate, and the round decides
 * nothing.
 *
 * `dispatch_routing_key` is NULL for every run whose dispatch source is the
 * inbound one — every ordinary run, and every round recorded before the column
 * existed — so it reads back as the inbound key.
 *
 * Throws, so it belongs with the pre-claim reconstruction: a source that has
 * since been removed is a reason to refuse, not to re-evaluate with the wrong
 * credentials.
 */
function resolveRoundDispatchBinding(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
  inbound: RerunProviderBinding,
): RoundDispatchBinding {
  const routingKey = originalRun.dispatch_routing_key ?? inbound.routingKey;
  if (routingKey === inbound.routingKey) {
    return { bundle: inbound.providerBundle, routingKey };
  }
  const bundle = deps.providerRegistry.getByRoutingKey(routingKey);
  if (!bundle) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: its dispatch source ${routingKey} ` +
        `is no longer registered, so the credentials it ran with cannot be paired with a ` +
        `provider. Re-register the source, or push a new commit to re-evaluate the ` +
        `organization's workflows.`,
    );
  }
  return { bundle, routingKey };
}

/**
 * The repository whose global workflows the round was deciding.
 *
 * A round is definitionally cross-repository — it exists to decide ONE
 * repository's global workflows against ANOTHER repository's event — so a round
 * row always records the defining repository, and `crossRepoWorkflowRepoOf` can
 * only narrow it away when the two repositories are equal, which the pass's own
 * same-repo skip makes impossible.
 *
 * There is therefore no reading of a NULL column that re-evaluates anything:
 * the pass drops every registration authored in the source repository BEFORE it
 * applies the scope, so falling back to the source repository would scope the
 * pass to nothing — no candidates, no round, no failure — and a success check
 * gated on the absence of a failure would then report a clean re-evaluation for
 * work that never ran. A round row reaching this path without the column is a
 * defect in whatever wrote it, and refusing is the only honest answer.
 */
function resolveRoundWorkflowRepo(originalRun: OriginalRunRow): string {
  const workflowRepo = originalRun.workflow_repo_identifier;
  if (!workflowRepo) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: it records no workflow repository, ` +
        `so there is nothing to scope the re-evaluation to. Push a new commit to re-evaluate the ` +
        `organization's workflows.`,
    );
  }
  return workflowRepo;
}

/**
 * The normalized form of the delivery the round was deciding.
 *
 * Read-only, and it throws — so it runs before the requestId claim, never
 * inside the re-evaluation.
 */
function normalizeRoundEvent(
  originalRun: OriginalRunRow,
  providerBundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>,
  delivery: { event: string; action: string | null },
  payload: Record<string, unknown>,
): SimulatedEvent {
  const event = providerBundle.normalizer.normalizeEvent(delivery.event, delivery.action, payload);
  if (!event) {
    throw new Error(
      `Cannot re-run evaluation round ${originalRun.run_id}: the '${delivery.event}' event it was ` +
        `deciding is no longer one this orchestrator normalizes.`,
    );
  }
  return event;
}

/** What a re-evaluated round produced. */
interface RoundReevaluation {
  workflowRepo: string;
  matchedCount: number;
  /**
   * The pass reported reaching a verdict for this workflow repository. The one
   * condition the success check is posted on — see `reevaluateGlobalRound`.
   */
  decided: boolean;
  /** The re-evaluation ran and could not decide the round again. */
  failedAgain: boolean;
  /** The trust policy did not admit the event, so nothing was evaluated. */
  skippedByPolicy: boolean;
}

/**
 * Rebuild the original delivery's inputs and re-drive the organization-wide
 * pass, scoped to the round's own workflow repository, then settle its check.
 */
async function reevaluateGlobalRound(opts: {
  originalRun: OriginalRunRow;
  payload: Record<string, unknown>;
  processingDeps: ProcessingDeps;
  binding: RerunProviderBinding;
  /** Resolved by {@link resolveRoundDispatchBinding} before the claim. */
  dispatch: RoundDispatchBinding;
  delivery: { event: string; action: string | null };
  /** Resolved by {@link resolveRoundWorkflowRepo} before the claim. */
  workflowRepo: string;
  /** Normalized by {@link normalizeRoundEvent} before the claim. */
  event: SimulatedEvent;
}): Promise<RoundReevaluation> {
  const { originalRun, payload, processingDeps, binding, dispatch, delivery, workflowRepo, event } =
    opts;
  const { providerBundle, providerContext, routingKey } = binding;
  const { event: eventName, action } = delivery;

  // The inbound event's own credentials, re-extracted from the payload — the
  // same read the delivery made. `provider_context` holds the DISPATCH
  // credentials the round ran with, which for a cross-provider global are
  // another source's and must not be used to read or write the inbound repo.
  const credentials = providerBundle.normalizer.extractCredentials(payload) as Record<
    string,
    unknown
  >;

  const info: WebhookInfo = {
    routingKey,
    // Distinct from the original delivery id so the re-evaluation's own dedup,
    // logs and traces are not mistaken for the delivery that first failed.
    deliveryId: `${originalRun.delivery_id}-rerun-${Date.now()}`,
    event: eventName,
    action,
    provider: originalRun.provider as ProviderType,
    payload,
  };

  const eventWithFiles = await withChangedFiles({
    event,
    bundle: providerBundle,
    info,
    payload,
    credentials,
    repoIdentifier: originalRun.repo_identifier,
  });

  const trust = await resolveTrustForPR({ info, bundle: providerBundle, event, payload });
  const securityDecision = await evaluateSecurityPolicy({
    deps: processingDeps,
    bundle: providerBundle,
    isPREvent: isPullRequestEvent(eventName),
    resolvedOrgId: originalRun.customer_id,
    mode: processingDeps.orchestratorMode ?? 'platform',
    trustResolution: trust.trustResolution,
    isForkPR: event.isForkPR ?? false,
  });

  const outcome = await dispatchGlobalWorkflowsForOtherRepos({
    info,
    deps: processingDeps,
    eventWithFiles,
    resolvedOrgId: originalRun.customer_id,
    repoIdentifier: originalRun.repo_identifier,
    ref: originalRun.sha,
    // The dispatch pair the delivery used, rebuilt from the round's own row:
    // the bundle the stored credentials belong to, with those credentials.
    dispatchBundle: dispatch.bundle,
    dispatchCredentials: providerContext,
    dispatchRoutingKey: dispatch.routingKey,
    // The inbound pair, which is what the check lands through.
    bundle: providerBundle,
    credentials,
    securityDecision,
    onlyWorkflowRepo: workflowRepo,
  });

  // Gated on the pass's POSITIVE signal, never on the absence of a failure.
  // Several paths reach this point having evaluated nothing at all and reported
  // no round failure either — a coordinator with no pending-eval tracker, one
  // with no registration index, an event the trust policy did not admit. Posting
  // success on their silence tells a merge bot to unblock on work that provably
  // did not run, which is the exact false assurance the round exists to remove.
  const decided = outcome.decidedWorkflowRepos.includes(workflowRepo);
  const failedAgain = outcome.roundFailureWorkflowRepos.includes(workflowRepo);
  const skippedByPolicy = securityDecision.action !== 'pass';
  if (decided) {
    await postRoundSucceededCheck({
      bundle: providerBundle,
      originalRun,
      credentials,
      workflowRepo,
      matchedCount: outcome.matchedCount,
    });
  } else {
    logger.warn('Eval-round rerun reached no verdict; leaving the check as it stands', {
      runId: originalRun.run_id,
      workflowRepo,
      failedAgain,
      skippedByPolicy,
    });
  }
  return {
    workflowRepo,
    matchedCount: outcome.matchedCount,
    decided,
    failedAgain,
    skippedByPolicy,
  };
}

/**
 * Stamp the re-evaluated event with the source repository's changed files.
 *
 * Unconditional, unlike the delivery path's fetch: that path skips the fetch
 * when no trigger in the source repo's lock file uses path patterns, and a
 * scoped re-evaluation has no such lock file to read. An error carries
 * `unavailable`, which every path filter downstream already treats
 * conservatively.
 */
async function withChangedFiles(opts: {
  event: SimulatedEvent;
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  info: WebhookInfo;
  payload: Record<string, unknown>;
  credentials: Record<string, unknown>;
  repoIdentifier: string;
}): Promise<SimulatedEvent> {
  const { event, bundle, info, payload, credentials, repoIdentifier } = opts;
  const base: SimulatedEvent = { ...event, sourceRepo: repoIdentifier };
  if (!bundle.changedFilesFetcher) {
    return { ...base, changedFiles: [], changedFilesStatus: 'unavailable' };
  }
  try {
    const fetched = await bundle.changedFilesFetcher.getChangedFiles(
      repoIdentifier,
      info.event,
      payload,
      credentials,
    );
    return { ...base, changedFiles: fetched.files, changedFilesStatus: fetched.status };
  } catch (err) {
    logger.warn('Changed files unavailable for an eval-round rerun', {
      repoIdentifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, changedFiles: [], changedFilesStatus: 'unavailable' };
  }
}

/**
 * Post the success conclusion on the organization-workflow-evaluation check for
 * a round that re-evaluated cleanly.
 *
 * Through the INBOUND repository's bundle and credentials, for the same reason
 * the failure post uses them: the check lands on the repository that emitted the
 * event, never on the one that defines the workflows.
 *
 * Known residual, deliberately not solved here: two rounds from different
 * workflow repositories can fail on one push, and both post the single shared
 * check name (last-write-wins — the collision pre-exists on the failure side).
 * Re-running one of them then posts success on that shared name even though the
 * other repository's round is still broken. The operator ruling keeps one check
 * name, so the summary names the repository this re-evaluation covered rather
 * than widening the name.
 *
 * Best-effort: the re-evaluation already happened and its workflows are already
 * dispatched, so a provider refusing the write must not fail the re-run.
 */
async function postRoundSucceededCheck(opts: {
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  originalRun: OriginalRunRow;
  credentials: Record<string, unknown>;
  workflowRepo: string;
  matchedCount: number;
}): Promise<void> {
  const { bundle, originalRun, credentials, workflowRepo, matchedCount } = opts;
  const summary =
    `Re-evaluated the organization's global workflows from \`${workflowRepo}\`: ` +
    `${matchedCount} workflow(s) admitted for this commit.`;
  try {
    await bundle.checkStatusPoster?.postGlobalEvalSucceededCheck?.(
      originalRun.repo_identifier,
      originalRun.sha,
      summary,
      credentials,
    );
  } catch (err) {
    logger.warn('Failed to post the global-eval-succeeded check', {
      runId: originalRun.run_id,
      repoIdentifier: originalRun.repo_identifier,
      workflowRepo,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Phase 5: re-fetch the lock file at the original SHA and locate the
 * workflow that was originally run. Throws on missing routing_key,
 * unregistered provider, missing lock-file fetcher, missing lock file,
 * or workflow not present in the lock file.
 */
async function resolveRerunWorkflow(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
): Promise<ResolvedRerunWorkflow> {
  const { providerBundle, providerContext, routingKey } = resolveRerunProviderBinding(
    originalRun,
    deps,
  );

  if (!providerBundle.lockFileFetcher) {
    throw new Error(`Provider ${originalRun.provider} does not support lock file fetching`);
  }

  const lockFile = await providerBundle.lockFileFetcher.fetchLockFile(
    originalRun.repo_identifier,
    originalRun.sha,
    providerContext,
  );

  if (!lockFile) {
    throw new Error('Lock file not found at original SHA (branch may have been force-pushed)');
  }

  const fullLockFile = lockFile as unknown as FullLockFile;

  // Find the workflow that was originally run
  const workflow = fullLockFile.workflows.find(
    (w: LockWorkflow) => w.name === originalRun.workflow_name,
  );
  if (!workflow) {
    throw new Error(
      `Workflow '${originalRun.workflow_name}' not found in lock file at SHA ${originalRun.sha}`,
    );
  }

  return {
    workflow,
    fullLockFile,
    providerContext,
    providerBundle,
    routingKey,
  };
}

/**
 * Phase 6 helper: extract a single-line commit message from the original
 * webhook payload (push.head_commit.message or pull_request.title).
 * Returns undefined for cron/schedule runs (no payload).
 */
function extractCommitMessage(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const headCommit = (payload as { head_commit?: { message?: string } }).head_commit;
  const prTitle = (payload as { pull_request?: { title?: string } }).pull_request?.title;
  return headCommit?.message?.split('\n')[0] ?? prTitle ?? undefined;
}

/**
 * Phase 7a: insert the new execution_runs row up-front so that coordinator
 * reroutes (which call onExecutionStarted from the peer side without
 * rerun-specific metadata) hit ON CONFLICT DO NOTHING and preserve the
 * rich row we wrote here.
 */
async function recordRerunExecutionStart(opts: {
  deps: RerunDeps;
  newRunId: string;
  originalRun: OriginalRunRow;
  originalRunId: string;
  rootRunId: string;
  workflow: LockWorkflow;
  providerContext: Record<string, unknown>;
  triggeredBy: string | null;
  triggeredByAgentLabel: string | null;
  commitMessage: string | undefined;
}): Promise<void> {
  const {
    deps,
    newRunId,
    originalRun,
    originalRunId,
    rootRunId,
    workflow,
    providerContext,
    triggeredBy,
    triggeredByAgentLabel,
    commitMessage,
  } = opts;

  await deps.executionTracker.onExecutionStarted(
    newRunId,
    workflow.name,
    originalRun.provider,
    originalRun.repo_identifier,
    originalRun.ref,
    originalRun.sha,
    `rerun:${newRunId}`,
    providerContext,
    null, // No trigger decision for re-runs
    [], // jobs added after dispatch via addJobsToRun
    originalRun.routing_key ?? undefined,
    undefined, // contexts
    'rerun', // triggerEvent — marks as user-initiated re-run
    commitMessage, // commitMessage from original webhook payload
    originalRunId, // parentRunId
    triggeredBy, // triggeredBy
    rootRunId, // originalRunId — root ancestor for lineage chain
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

/**
 * Phase 7b: dispatch jobs either via the cluster coordinator (which tries
 * local first, then reroutes to peers whose scalers can satisfy the labels)
 * or, in standalone mode / on coordinator timeout, directly via the local
 * dispatcher. Returns the job IDs registered with the execution tracker
 * plus any synthetic-rejected IDs that need to be marked failed.
 */
async function dispatchRerunJobs(opts: {
  deps: RerunDeps;
  newRunId: string;
  originalRun: OriginalRunRow;
  resolved: ResolvedRerunWorkflow;
  payload: Record<string, unknown> | null;
}): Promise<{ dispatchedJobs: DispatchedJobEntry[]; rejectedJobs: RejectedJobEntry[] }> {
  const { deps, newRunId, originalRun, resolved, payload } = opts;
  const { workflow, fullLockFile, providerContext, providerBundle, routingKey } = resolved;

  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const repoUrl = providerBundle.repoUrlBuilder?.buildCloneUrl(originalRun.repo_identifier) ?? '';

  const buildRerunJobConfig = (mat: MaterializedJob) => {
    const job = mat.lockJob;
    return {
      source: workflow.source ?? fullLockFile.source,
      workflowName: workflow.name,
      ...matrixEnvelopeFields(mat),
      steps: job.steps,
      needs: job.needs,
      rules: job.rules,
      ...(workflow.contentHash && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
    };
  };

  const installationId =
    typeof (providerContext as { installationId?: unknown }).installationId === 'number'
      ? ((providerContext as { installationId: number }).installationId as number)
      : undefined;

  const runContext: RunContext = {
    runId: newRunId,
    deliveryId: `rerun:${newRunId}`,
    routingKey,
    event: 'rerun',
    action: null,
    provider: originalRun.provider,
    payload: (payload as Record<string, unknown> | undefined) ?? {},
    repoIdentifier: originalRun.repo_identifier,
    sha: originalRun.sha,
    ref: originalRun.ref,
    workflowName: workflow.name,
    ...(installationId !== undefined && { installationId }),
  };

  return routeOrDispatchJobs({
    newRunId,
    staticJobs,
    workflowName: workflow.name,
    repoUrl,
    ref: originalRun.ref,
    sha: originalRun.sha,
    deliveryId: `rerun:${newRunId}`,
    provider: originalRun.provider,
    providerContext: providerContext as Record<string, unknown>,
    routingKey,
    runContext,
    buildJobConfig: buildRerunJobConfig,
    logger,
    label: 'Re-run',
    coordinator: deps.coordinator,
    dispatcher: deps.dispatcher,
  });
}

/**
 * Phase 8 + 9: emit the workflow.rerun system event via the EventRouter
 * and create a pending GitHub check run for the new run.
 */
async function emitRerunEventAndCheckRun(opts: {
  deps: RerunDeps;
  originalRun: OriginalRunRow;
  originalRunId: string;
  newRunId: string;
  workflow: LockWorkflow;
  providerContext: Record<string, unknown>;
  triggeredBy: string | null;
}): Promise<void> {
  const { deps, originalRun, originalRunId, newRunId, workflow, providerContext, triggeredBy } =
    opts;

  // 8. Emit workflow.rerun system event via EventRouter (renumbered from 9)
  if (deps.eventRouter) {
    await deps.eventRouter.emit({
      eventName: 'workflow.rerun',
      payload: {
        parentRunId: originalRunId,
        newRunId,
        workflowName: workflow.name,
        repo: originalRun.repo_identifier,
        sha: originalRun.sha,
        triggeredBy,
      },
      sourceRepo: originalRun.repo_identifier,
      sourceRoutingKey: originalRun.routing_key ?? undefined,
    });
  }

  // 9. Create GitHub check run for the re-run
  if (deps.checkRunReporter) {
    const [owner, repo] = originalRun.repo_identifier.split('/');
    const staticJobs = workflow.jobs.filter(isLockStaticJob);
    const jobNames = staticJobs.map((j) => j.name);

    deps.checkRunReporter.setPending({
      provider: originalRun.provider,
      owner,
      repo,
      sha: originalRun.sha,
      workflowName: workflow.name,
      jobNames,
      installationId: (providerContext as { installationId?: number }).installationId,
      routingKey: originalRun.routing_key ?? undefined,
    });
  }
}
