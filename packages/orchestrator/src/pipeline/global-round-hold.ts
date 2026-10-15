/**
 * The security hold of a pre-run global evaluation round.
 *
 * A candidate with a `filter` or a `DynamicJobFn` needs the round before its
 * runs exist, and the round runs workflow-repository code on an agent with the
 * event's head checked out, so a held event's round must wait for approval too.
 * Instead of dispatching it, the pass records ONE held run per workflow
 * repository, named like the round job, in the same security queue with the
 * same hold row as a held per-repository workflow.
 *
 * Approval re-evaluates the round from the stored payload
 * (`releaseHeldGlobalEvalRound`); rejection cancels it like any workflow-scoped
 * security hold.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { HeldRun } from '../db/types.js';
import { buildSecurityHoldData, postPendingHoldCheck } from './dispatch-matched-workflow.js';
import { ROUND_JOB_PREFIX, type GlobalEvalCandidate } from './global-eval-round.js';
import { buildSecurityHoldSummary, type ProcessingDeps } from './processor.js';
import { storeWebhookPayload } from './webhook-payload-store.js';

const logger = createLogger({ prefix: 'global-round-hold' });

/** Inputs of one pass's held evaluation rounds. */
export interface HoldGlobalEvalRoundsArgs {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  candidates: readonly GlobalEvalCandidate[];
  /** The source repository. */
  repoIdentifier: string;
  /** The event's commit SHA. */
  ref: string;
  resolvedOrgId: string;
  /** Credentials the round would have run with, stored on the held row for its release. */
  dispatchCredentials: Record<string, unknown>;
  /** The source `dispatchCredentials` belongs to, when it is not the inbound one. */
  dispatchRoutingKey?: string;
  /** The inbound event's bundle and credentials: the security check lands on its repository. */
  bundle?: ProviderBundle;
  credentials?: Record<string, unknown>;
  trustResolution: TrustResolution | undefined;
  decision: Extract<TrustPolicyOutcome, { action: 'hold' }>;
}

/** The candidates of each workflow repository, which the release re-evaluates as one scope. */
function byWorkflowRepo(
  candidates: readonly GlobalEvalCandidate[],
): Map<string, GlobalEvalCandidate[]> {
  const groups = new Map<string, GlobalEvalCandidate[]>();
  for (const candidate of candidates) {
    const repo = candidate.reg.repoIdentifier;
    const existing = groups.get(repo);
    if (existing) existing.push(candidate);
    else groups.set(repo, [candidate]);
  }
  return groups;
}

/**
 * Hold the round of every workflow repository among `candidates`; returns the
 * held run ids in workflow-repository order.
 *
 * One run per workflow repository, not per SHA: the release re-evaluates the
 * whole repository, so two rows would dispatch its workflows twice.
 */
export async function holdGlobalEvalRounds(args: HoldGlobalEvalRoundsArgs): Promise<string[]> {
  const runIds: string[] = [];
  for (const [workflowRepo, group] of byWorkflowRepo(args.candidates)) {
    runIds.push(await holdOneRound(args, workflowRepo, group));
  }
  return runIds;
}

/** Record, queue, and announce the held round of one workflow repository. */
async function holdOneRound(
  args: HoldGlobalEvalRoundsArgs,
  workflowRepo: string,
  group: readonly GlobalEvalCandidate[],
): Promise<string> {
  const { info, deps, event, decision } = args;
  const runId = randomUUID();
  const reg = group[0].reg;

  // Stored before the hold exists, since the release re-evaluates from it.
  await storeWebhookPayload({ logStorage: deps.logStorage, runId, payload: info.payload });

  await deps.executionTracker?.recordRunHeld({
    runId,
    // The round job's own name, so the held row reads as the round it replaces.
    workflowName: `${ROUND_JOB_PREFIX}${workflowRepo}`,
    provider: info.provider,
    repoIdentifier: args.repoIdentifier,
    workflowRepoIdentifier: workflowRepo,
    workflowSha: reg.commitSha ?? null,
    workflowBranch: reg.defaultBranch ?? null,
    // The branch the run PRESENTS, as on every other run row.
    ref: event.targetBranch ?? '',
    sha: args.ref,
    deliveryId: info.deliveryId,
    providerContext: args.dispatchCredentials,
    routingKey: info.routingKey,
    ...(args.dispatchRoutingKey !== undefined && { dispatchRoutingKey: args.dispatchRoutingKey }),
    reason: decision.reason,
    triggerEvent: info.event,
    prNumber: event.prNumber ?? null,
    isGlobalEvalRound: true,
    // So the release can refuse to run the round without one of them.
    heldRoundWorkflows: group.map((candidate) => candidate.lockEntry.name),
  });

  let heldRow: HeldRun | undefined;
  if (deps.heldRunStore) {
    heldRow = await deps.heldRunStore.create(
      args.resolvedOrgId,
      buildSecurityHoldData(runId, decision),
    );
  }

  const poster = args.bundle?.checkStatusPoster;
  if (deps.heldRunStore && heldRow && poster) {
    await postPendingHoldCheck({
      poster,
      store: deps.heldRunStore,
      orgId: args.resolvedOrgId,
      heldRunIds: [heldRow.id],
      repoIdentifier: args.repoIdentifier,
      sha: args.ref,
      summary: buildSecurityHoldSummary(
        decision.reason,
        args.trustResolution?.tier,
        args.trustResolution?.contributorUsername,
      ),
      credentials: args.credentials ?? {},
      logContext: { runId, reason: decision.reason, workflowRepo },
      postFailureMessage: 'Failed to post the security hold check of a held evaluation round',
    });
  }

  logger.info('Held a global evaluation round with its held event', {
    deliveryId: info.deliveryId,
    runId,
    workflowRepo,
    sourceRepo: args.repoIdentifier,
    workflows: group.map((candidate) => candidate.lockEntry.name),
    reason: decision.reason,
  });
  return runId;
}
