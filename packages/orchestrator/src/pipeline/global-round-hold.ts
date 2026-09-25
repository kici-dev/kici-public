/**
 * The security hold of a pre-run global evaluation round.
 *
 * A global candidate that declares a `filter` or carries a `DynamicJobFn` needs
 * the evaluation round before any of its runs exist, and the round runs the
 * workflow repository's code on an agent that has the event's head checked out.
 * When the trust policy holds the event, that code must wait for the approval as
 * well. So instead of dispatching the round, the pass records ONE held run per
 * workflow repository — named like the round job it replaces — in the same
 * security queue, with the same hold row, as a held per-repository workflow.
 *
 * Approving that hold re-evaluates the round from the stored webhook payload
 * (`releaseHeldGlobalEvalRound`); rejecting it cancels the run like any other
 * workflow-scoped security hold.
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
  /** The candidates that needed the round. */
  candidates: readonly GlobalEvalCandidate[];
  /** The source repository the event came from. */
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
 * Hold the evaluation round of every workflow repository among `candidates`.
 * Returns the id of each held run, in workflow-repository order.
 *
 * One run per workflow repository, not per registered SHA: the release
 * re-evaluates a whole workflow repository, so two rows for one repository would
 * dispatch its workflows twice.
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

  // The release re-evaluates the event from this payload, so it is stored
  // before the hold that can release it exists.
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
    // The workflows this round covers, so its release can refuse to run the
    // round without one of them.
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
