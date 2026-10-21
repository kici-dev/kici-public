/**
 * Re-run handler: loads a completed run, validates it, and routes it to the
 * re-run of its kind — a failed global evaluation round is re-evaluated, a
 * cross-repository global run re-runs from the repository defining its workflow
 * (`rerun-global.ts`), and every other run re-runs through the pipeline its
 * original run went through (`rerun-repo.ts`). Each new run links to the
 * original by parent_run_id.
 *
 * Deliberately not processWebhook: a re-run skips dedup and trigger matching.
 */

import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
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
import { claimRequestId, type RunStartAnswer } from './request-idempotency.js';
import { ExecutionRunStatus, TERMINAL_RUN_STATES } from '@kici-dev/engine';
import {
  dispatchGlobalWorkflowsForOtherRepos,
  evaluateSecurityPolicy,
  isPullRequestEvent,
  resolveTrustForPR,
} from './process-webhook.js';
import type { ProcessingDeps } from './processor.js';
import type { TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import {
  loadDeliveryEventName,
  loadWebhookPayload,
  normalizeRoundEvent,
  RELEASED_DECISION,
  resolveRerunProviderBinding,
  withChangedFiles,
  type RerunProviderBinding,
} from './rerun-inputs.js';
import { isCrossRepoGlobalRun, rerunCrossRepoGlobalRun } from './rerun-global.js';
import { rerunRepositoryRun } from './rerun-repo.js';
import { startAcceptedDispatch } from './accepted-dispatch.js';
import { registrationsAtHeldCommit } from './held-round-registrations.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderType, SimulatedEvent } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'rerun' });

/**
 * Thrown when the run row is absent from PG AND the cold-store replay failed or
 * is unavailable (chunk missing, contentHash mismatch, S3 outage, or cold-store
 * probe disabled). The Platform proxy surfaces it as HTTP 410
 * (`errorCode: 'runArchivedNotRerunnable'`).
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
   * When set, a PG miss on `originalRunId` replays the row's chunk from cold
   * store and re-reads; `null` throws RunArchivedNotRerunnableError on a miss.
   */
  coldStore: ColdStore | null;
  /**
   * The live webhook-processing bag, assembled on demand. Only a failed global
   * eval round's re-run needs it (it re-drives the organization-wide pass, which
   * reaches the registration index, policy reader and pending-eval tracker). The
   * inbound webhook entry point supplies it, so the two cannot drift. Absent
   * means round re-runs are not available on this deployment.
   */
  processingDeps?: (() => ProcessingDeps) | null;
  /**
   * Test-only fault seam, awaited first inside an accepted dispatch (after the
   * requester was answered). Undefined in the shipped orchestrator.
   */
  beforeAcceptedDispatch?: (() => Promise<void>) | null;
}

/** Original run row from execution_runs (selectAll). */
export type OriginalRunRow = Selectable<ExecutionRunTable>;

export async function handleRerun(
  originalRunId: string,
  triggeredBy: string | null,
  triggeredByAgentLabel: string | null,
  deps: RerunDeps,
  /**
   * Platform-minted idempotency key, stable across an HA relay failover re-send
   * (the Platform re-sends the same message verbatim to a sibling coordinator on
   * a timeout). After read-only validation, the first coordinator to claim it
   * creates the run; a re-send returns that same run.
   */
  requestId: string,
  /**
   * Forwarded by the Platform in `run.rerun.request`; addresses the cold-store
   * chunk under the right tenant prefix.
   */
  routingKeyHint?: string,
): Promise<RunStartAnswer> {
  const originalRun = await loadAndValidateOriginalRun(originalRunId, routingKeyHint, deps);

  // A failed global eval round decided nothing, so it is re-evaluated, not
  // re-dispatched. Routed on the run row's marker, never on the round job's name.
  if (originalRun.is_global_eval_round === true) {
    return rerunGlobalEvalRound(originalRun, deps, requestId);
  }

  // A cross-repo global run re-runs from the repository that DEFINES its
  // workflow, at the commit it ran from. The path below reads `repo_identifier`'s
  // (the source repo's) lock file, so it would fail or silently run a same-named
  // workflow of that repo.
  if (isCrossRepoGlobalRun(originalRun)) {
    return rerunCrossRepoGlobalRun({
      originalRun,
      triggeredBy,
      triggeredByAgentLabel,
      deps,
      requestId,
    });
  }

  return rerunRepositoryRun({
    originalRun,
    triggeredBy,
    triggeredByAgentLabel,
    deps,
    requestId,
  });
}

/**
 * Load the original run (cold-store replay on a PG miss) and require a terminal,
 * non-test run. Throws on any precondition failure.
 */
async function loadAndValidateOriginalRun(
  originalRunId: string,
  routingKeyHint: string | undefined,
  deps: RerunDeps,
): Promise<OriginalRunRow> {
  let originalRun = await deps.db
    .selectFrom('execution_runs')
    .selectAll()
    .where('run_id', '=', originalRunId)
    .executeTakeFirst();

  if (!originalRun) {
    // Replay needs a wired cold store and the Platform-forwarded routing key
    // (the tenant prefix). A standalone orchestrator without Platform
    // forwarding falls through to RunArchivedNotRerunnableError.
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
      // Cold store unavailable, no chunk found, or the replay returned no rows.
      throw new RunArchivedNotRerunnableError(originalRunId);
    }
  }

  if (!TERMINAL_RUN_STATES.has(originalRun.status)) {
    throw new Error(`Run is not in a terminal state (current: ${originalRun.status})`);
  }

  if (originalRun.is_test_run) {
    throw new Error('Test runs cannot be re-run');
  }

  return originalRun as OriginalRunRow;
}

/**
 * Re-run a failed global evaluation round: re-drive the organization-wide pass
 * for the round's workflow repo from the stored payload. The pass dispatches
 * what it admits, as on the original delivery. Every input is recomputed against
 * current state, so a fixed workflow repository flips the verdict without a new
 * commit.
 */
async function rerunGlobalEvalRound(
  originalRun: OriginalRunRow,
  deps: RerunDeps,
  requestId: string,
): Promise<RunStartAnswer> {
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

  // ALL read-only reconstruction runs before the claim: each step throws
  // identically on both failover hops, and a throw after the claim would report
  // the first hop's failure to the second as HTTP 200 with the round's run id —
  // a re-run that never ran. Anything that can throw belongs above the claim.
  const binding = resolveRerunProviderBinding(originalRun, deps);
  const dispatch = resolveRoundDispatchBinding(originalRun, deps, binding);
  const delivery = await loadDeliveryEventName(originalRun, deps);
  const workflowRepo = resolveRoundWorkflowRepo(originalRun);
  const event = normalizeRoundEvent(originalRun, binding.providerBundle, delivery, payload);

  // The re-evaluation dispatches, so the claim guards it; on a failover re-send
  // or a Platform retry the earlier delivery has already re-evaluated.
  const { claimed } = await claimRequestId(deps.db, requestId);
  if (!claimed) {
    logger.info('Eval-round rerun requestId already accepted by an earlier delivery; returning', {
      runId: originalRun.run_id,
      requestId,
    });
    return { newRunId: originalRun.run_id, alreadyAccepted: true };
  }

  // The re-evaluation runs DETACHED and the request is answered now, like the
  // original delivery: a webhook is answered 202 once durably queued
  // (`routes/webhooks.ts`), and the pipeline's outcomes reach the event log, the
  // run list and the check.
  //
  // Awaiting would always time out: a round is an agent job that clones both
  // repositories and runs every candidate's filter (minutes), while the relayed
  // dashboard call's budget is ten seconds.
  //
  // Answering early loses nothing: the response is the round's OWN run id (a
  // re-evaluation mints no run), and everything that can refuse has already run
  // above, so a later failure is operational and read from the round.
  startAcceptedDispatch({
    runId: originalRun.run_id,
    kind: 'Evaluation round re-run',
    context: { workflowRepo, requestId },
    work: async () => {
      const outcome = await reevaluateGlobalRound({
        originalRun,
        payload,
        processingDeps: buildProcessingDeps(),
        binding,
        dispatch,
        delivery,
        workflowRepo,
        event,
      });
      logger.info('Re-evaluated a failed global eval round', {
        runId: originalRun.run_id,
        workflowRepo: outcome.workflowRepo,
        admitted: outcome.matchedCount,
        decided: outcome.decided,
        failedAgain: outcome.failedAgain,
        skippedByPolicy: outcome.skippedByPolicy,
      });
    },
    // A re-evaluation mints no run, so there is no run to fail: the helper's
    // error log is the failure's only record.
    recordFailure: async () => {},
  });

  return { newRunId: originalRun.run_id };
}

/**
 * Release a held global evaluation round: re-evaluate it from the stored payload
 * with the approved event treated as passing, dispatch what it admits, and
 * settle the held run.
 *
 * Reached from `resumeWorkflow`. The held row stores no dispatch context, so
 * everything is rebuilt from the row, the payload and the delivery's event log
 * entry — the same reconstruction a failed round's re-run uses.
 *
 * Never throws. A round that cannot be rebuilt or decided fails the held run
 * with the reason an approver reads. A release that cannot claim the held row
 * (another release did) does nothing.
 */
export async function releaseHeldGlobalEvalRound(
  runId: string,
  deps: ProcessingDeps,
): Promise<void> {
  const tracker = deps.executionTracker;
  if (!tracker) {
    logger.warn('Held global eval round not released: no execution tracker is wired', { runId });
    return;
  }
  // Claimed before anything dispatches: only the release that moves the row off
  // `held` may run the round, or a re-fired signal would dispatch twice.
  // fails-when: two release signals for one held round both dispatch it
  // breaks-if-wrong: the first release of a held round must still run it
  let claimed: boolean;
  try {
    claimed = await tracker.claimHeldGlobalEvalRound(runId);
  } catch (err) {
    logger.error('Failed to claim a held global eval round; not released', {
      runId,
      error: toErrorMessage(err),
    });
    return;
  }
  if (!claimed) {
    logger.warn('Held global eval round not released: it is no longer held', { runId });
    return;
  }
  let reason: string | undefined;
  try {
    const outcome = await reevaluateReleasedRound(runId, deps);
    logger.info('Released a held global eval round', {
      runId,
      workflowRepo: outcome.workflowRepo,
      admitted: outcome.matchedCount,
      decided: outcome.decided,
      failedAgain: outcome.failedAgain,
    });
    if (!outcome.decided) {
      reason =
        `The approved evaluation round for ` +
        `\`${outcome.workflowRepo}\` reached no verdict, so its workflows did not run.`;
    }
  } catch (err) {
    reason = `The approved evaluation round could not run: ${toErrorMessage(err)}`;
    logger.error('Failed to release a held global eval round', { runId, error: reason });
  }
  try {
    await tracker?.completeReleasedGlobalEvalRound(
      runId,
      reason === undefined
        ? { status: ExecutionRunStatus.enum.success }
        : { status: ExecutionRunStatus.enum.failed, reason },
    );
  } catch (err) {
    logger.error('Failed to settle a released global eval round', {
      runId,
      error: toErrorMessage(err),
    });
  }
}

/** Rebuild a held round's inputs from its run row and re-evaluate it as released. */
async function reevaluateReleasedRound(
  runId: string,
  deps: ProcessingDeps,
): Promise<RoundReevaluation> {
  const { db, logStorage } = deps;
  if (!db || !logStorage) {
    throw new Error(
      'this orchestrator has no database or object storage to rebuild the round from',
    );
  }
  const originalRun = (await db
    .selectFrom('execution_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst()) as OriginalRunRow | undefined;
  // fails-when: a release names a run that is not a held evaluation round
  // breaks-if-wrong: the held round row the pass recorded must still be released
  if (originalRun?.is_global_eval_round !== true) {
    throw new Error(`run ${runId} is not a global evaluation round`);
  }
  const payload = await loadWebhookPayload(runId, { logStorage });
  if (!payload) throw new Error(`its webhook payload was not stored`);
  const binding = resolveRerunProviderBinding(originalRun, deps);
  const delivery = await loadDeliveryEventName(originalRun, { db });
  const workflowRepo = resolveRoundWorkflowRepo(originalRun);
  return reevaluateGlobalRound({
    originalRun,
    payload,
    processingDeps: deps,
    binding,
    dispatch: resolveRoundDispatchBinding(originalRun, deps, binding),
    delivery,
    workflowRepo,
    event: normalizeRoundEvent(originalRun, binding.providerBundle, delivery, payload),
    released: true,
    admitRoundVerdicts: () => isStillClaimedRound(db, runId),
    registrations: await registrationsAtHeldCommit({
      row: originalRun,
      deps,
      workflowRepo,
      eventName: delivery.event,
    }),
  });
}

/**
 * Whether the round's row is still in its claimed state. Read after the round
 * decides and before dispatch: a run cancelled meanwhile has left `pending` and
 * must dispatch nothing.
 */
async function isStillClaimedRound(db: Kysely<Database>, runId: string): Promise<boolean> {
  const row = await db
    .selectFrom('execution_runs')
    .select(['status', 'is_global_eval_round'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  return row?.status === ExecutionRunStatus.enum.pending && row.is_global_eval_round === true;
}

/** The bundle a round's stored `provider_context` actually belongs to. */
interface RoundDispatchBinding {
  bundle: NonNullable<ReturnType<ProviderRegistry['getByRoutingKey']>>;
  routingKey: string;
}

/**
 * The provider bundle whose credentials the round's `provider_context` holds.
 *
 * `routing_key` is the source the event ARRIVED on; `provider_context` holds the
 * DISPATCH credentials, which for a cross-provider global belong to another
 * source. Pairing the inbound bundle with them makes the fetch fail or read the
 * wrong tree, so every candidate drops indeterminate and the round decides
 * nothing.
 *
 * `dispatch_routing_key` is NULL when the dispatch source is the inbound one
 * (every ordinary run, and every round recorded before the column existed), so
 * it reads back as the inbound key.
 *
 * Throws, so it runs pre-claim: a removed source is a reason to refuse, not to
 * re-evaluate with the wrong credentials.
 */
function resolveRoundDispatchBinding(
  originalRun: OriginalRunRow,
  deps: Pick<RerunDeps, 'providerRegistry'>,
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
 * A round decides ONE repository's global workflows against ANOTHER's event, so
 * its row always records the defining repository (`crossRepoWorkflowRepoOf`
 * narrows it away only when the two are equal, which the pass's same-repo skip
 * makes impossible).
 *
 * No fallback for a NULL column re-evaluates anything: the pass drops the source
 * repository's registrations BEFORE applying the scope, so falling back to it
 * scopes the pass to nothing — no candidates, no round, no failure — and a check
 * gated on no failure would report a clean re-evaluation of nothing. A round row
 * without the column is a writer defect; refuse.
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

/** What a re-evaluated round produced. */
interface RoundReevaluation {
  workflowRepo: string;
  matchedCount: number;
  /**
   * The pass reached a verdict for this workflow repository — the one condition
   * the success check is posted on.
   */
  decided: boolean;
  failedAgain: boolean;
  /**
   * The trust policy did not pass the event, so the round was held or rejected
   * instead of run, and decided nothing.
   */
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
  /**
   * An approver released the round's security hold: its event passes the trust
   * policy (the approval is that decision), and no success check is posted,
   * since the delivery posted no failure for a held round.
   */
  released?: boolean;
  /** Forwarded to the pass; see `dispatchGlobalWorkflowsForOtherRepos`. */
  admitRoundVerdicts?: () => Promise<boolean>;
  /** Forwarded to the pass; see `dispatchGlobalWorkflowsForOtherRepos`. */
  registrations?: readonly RegisteredWorkflow[];
}): Promise<RoundReevaluation> {
  const { originalRun, payload, processingDeps, binding, dispatch, delivery, workflowRepo, event } =
    opts;
  const { providerBundle, providerContext, routingKey } = binding;
  const { event: eventName, action } = delivery;

  // The inbound credentials, re-extracted as the delivery did. `provider_context`
  // holds the DISPATCH credentials, which for a cross-provider global are another
  // source's and must not touch the inbound repo.
  const credentials = providerBundle.normalizer.extractCredentials(payload) as Record<
    string,
    unknown
  >;

  const info: WebhookInfo = {
    routingKey,
    // Distinct, so dedup, logs and traces never confuse it with the original delivery.
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

  // Resolved even when released: approval lifts the hold, not the contributor's
  // tier, so admitted runs carry the tier a released per-repository run does.
  const trust = await resolveTrustForPR({ info, bundle: providerBundle, event, payload });
  const securityDecision: TrustPolicyOutcome =
    opts.released === true
      ? RELEASED_DECISION
      : await evaluateSecurityPolicy({
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
    // The delivery's dispatch pair, rebuilt from the round's row.
    dispatchBundle: dispatch.bundle,
    dispatchCredentials: providerContext,
    dispatchRoutingKey: dispatch.routingKey,
    // The inbound pair, which is what the check lands through.
    bundle: providerBundle,
    credentials,
    trustResolution: trust.trustResolution,
    securityDecision,
    onlyWorkflowRepo: workflowRepo,
    // Candidates that needed no round already dispatched or held on the original
    // delivery; re-dispatching would run them twice for one commit.
    onlyRoundCandidates: true,
    // Only an approved hold also held the result-aware-only candidates; a failed
    // round's re-run finds them already dispatched.
    ...(opts.released === true && { releasedHold: true }),
    ...(opts.admitRoundVerdicts !== undefined && { admitRoundVerdicts: opts.admitRoundVerdicts }),
    ...(opts.registrations !== undefined && { registrations: opts.registrations }),
  });

  // Gated on the pass's POSITIVE signal, never on no failure: a coordinator with
  // no pending-eval tracker or no registration index evaluates nothing and
  // reports no failure, and success on that silence would unblock a merge bot on
  // work that never ran.
  const decided = outcome.decidedWorkflowRepos.includes(workflowRepo);
  const failedAgain = outcome.roundFailureWorkflowRepos.includes(workflowRepo);
  const skippedByPolicy = securityDecision.action !== 'pass';
  if (decided && opts.released !== true) {
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
 * Post success on the organization-workflow-evaluation check for a cleanly
 * re-evaluated round, through the INBOUND repository's bundle and credentials:
 * the check lands on the repository that emitted the event.
 *
 * Known residual, deliberately unsolved: two rounds from different workflow
 * repositories can fail on one push and share one check name (last-write-wins,
 * as on the failure side), so re-running one posts success while the other is
 * still broken. The operator ruling keeps one check name; the summary names the
 * covered repository instead.
 *
 * Best-effort: the workflows are already dispatched, so a refused write must not
 * fail the re-run.
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
