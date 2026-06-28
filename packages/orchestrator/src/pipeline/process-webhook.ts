/**
 * Webhook processing pipeline.
 *
 * Splits the historic 1339-line `processWebhook` into typed phase helpers so
 * each piece can be reasoned about independently. The main exported function
 * is a narrative orchestrator that threads the typed results through the
 * pipeline:
 *
 *   dedup -> provider -> normalize -> (cross-source dispatch | per-repo path)
 *   per-repo path: extract repo + creds -> trust resolution -> lock file fetch
 *     -> (no lock file: global dispatch & return)
 *     -> security hold + workflow modifications -> default-branch registration
 *     -> match triggers -> dispatch matched same-source -> dispatch globals
 *     -> forward traces & event log
 *
 * Internal helpers are pure phase functions returning typed results; the only
 * top-level export is `processWebhook`, callable from server.ts / app.ts.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  enrichRequestContext,
  getRequestContext,
  toErrorMessage,
} from '@kici-dev/shared';
import type {
  LockFile as FullLockFile,
  LockWorkflow,
  SimulatedEvent,
  LockFileParseError,
} from '@kici-dev/engine';
import { EventLogStatus, EventLogSource, InitFailureCategory } from '@kici-dev/engine';
import { isLockStaticJob } from '@kici-dev/engine';
import { materializeFanout, matrixEnvelopeFields, partitionMatchers } from '@kici-dev/engine';
import { matchAllWorkflows } from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import { selectLockFileSource } from '../security/lock-source.js';
import {
  detectWorkflowModifications,
  type WorkflowModification,
} from '../security/workflow-diff.js';
import { parseKiciCommand, handleApprovalComment } from '../security/comment-handler.js';
import { extractRegisterableWorkflows, extractGlobalWorkflows } from '../registration/extractor.js';
import { payloadFromObject } from '../webhook/event-log.js';
import {
  webhooksReceivedTotal,
  webhooksProcessedTotal,
  triggerMatchDurationSeconds,
  dedupHitsTotal,
  crossSourceFanoutSize,
  crossSourceErrorsTotal,
} from '../metrics/prometheus.js';
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import {
  resolveOrgId,
  resolveLockFileWithFallback,
  eventTypeToTriggerType,
  extractInboundRepoIdentifier,
  isDefaultBranchPush,
  buildSecurityHoldSummary,
  anyTriggerHasPathPatterns,
  summarizeDecision,
  buildTriggerEvent,
  extractCommitMessage,
  type ProcessingDeps,
} from './processor.js';

const logger = createLogger({ prefix: 'pipeline' });

// ---------------------------------------------------------------------------
// Phase A — dedup + provider + normalize
// ---------------------------------------------------------------------------

/**
 * Resolve customer/org id for the inbound routing key with a default fallback.
 * The DB lookup may fail (table missing in dev/test); we tolerate that and
 * default to '__default__' so the pre-tenant code paths still work.
 */
async function resolveOrgIdSafe(deps: ProcessingDeps, routingKey: string): Promise<string> {
  if (!deps.db) return '__default__';
  try {
    return await resolveOrgId(deps.db, routingKey);
  } catch {
    return '__default__';
  }
}

/**
 * Record an event-log row for a path that decided to skip the inbound.
 * Centralises the duplicated boilerplate across early-return branches.
 */
async function recordSkipEventLog(
  info: WebhookInfo,
  deps: ProcessingDeps,
  resolvedOrgId: string,
  status: EventLogStatus,
): Promise<void> {
  if (!deps.eventLog) return;
  await deps.eventLog.record(info, payloadFromObject(info.payload), {
    orgId: resolvedOrgId,
    source: deps.eventLogSource ?? EventLogSource.enum.direct,
    status,
  });
}

interface DedupAndProviderContinue {
  status: 'continue';
  resolvedOrgId: string;
  bundle: ProviderBundle;
}

type DedupAndProviderResult = DedupAndProviderContinue | { status: 'skip' };

/**
 * Phase A.1 — Dedup + provider lookup. Resolves org id, drops duplicates, and
 * resolves the provider bundle. Records the appropriate event log + metric on
 * skip paths so the caller can early-return.
 */
async function dedupAndResolveProvider(
  info: WebhookInfo,
  deps: ProcessingDeps,
): Promise<DedupAndProviderResult> {
  const resolvedOrgId = await resolveOrgIdSafe(deps, info.routingKey);

  if (await deps.dedup.exists(info.deliveryId)) {
    logger.debug('Duplicate webhook, skipping', { deliveryId: info.deliveryId });
    dedupHitsTotal.add(1);
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.duplicate);
    return { status: 'skip' };
  }
  await deps.dedup.mark(info.deliveryId);
  webhooksReceivedTotal.add(1, { source: 'pipeline', event: info.event });

  const bundle = deps.providerRegistry.getByRoutingKey(info.routingKey);
  if (!bundle) {
    logger.debug('Unknown provider, skipping', {
      deliveryId: info.deliveryId,
      provider: info.provider,
      routingKey: info.routingKey,
    });
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
    return { status: 'skip' };
  }

  return { status: 'continue', resolvedOrgId, bundle };
}

/**
 * Phase A.2 — Invalidate contributor-cache entries on membership-related
 * events. Runs BEFORE normalizeEvent so it fires even for events that do not
 * map to a workflow trigger (member / organization / membership / team). The
 * 15-minute TTL remains the fallback for entries we don't explicitly drop.
 */
function invalidateContributorCacheForEvent(
  info: WebhookInfo,
  deps: ProcessingDeps,
  bundle: ProviderBundle,
): void {
  const invalidations = bundle.normalizer.getAccessCacheInvalidations?.(
    info.event,
    info.action,
    info.payload,
  );
  if (!invalidations || invalidations.length === 0 || !deps.contributorCache) return;
  const provider = bundle.normalizer.provider;
  let totalDeleted = 0;
  for (const inv of invalidations) {
    switch (inv.kind) {
      case 'repo-user':
        totalDeleted += deps.contributorCache.invalidate(provider, inv.repoFullName, inv.username);
        break;
      case 'repo':
        totalDeleted += deps.contributorCache.invalidateByRepo(provider, inv.repoFullName);
        break;
      case 'user-in-org':
        totalDeleted += deps.contributorCache.invalidateByUserInOrg(
          provider,
          inv.orgLogin,
          inv.username,
        );
        break;
    }
  }
  logger.info('Invalidated contributor cache entries', {
    deliveryId: info.deliveryId,
    event: info.event,
    action: info.action,
    invalidations: invalidations.length,
    entriesDeleted: totalDeleted,
  });
}

/**
 * Phase A.3 — Normalise the inbound event via the provider's normalizer.
 * Returns `null` (with skip metric + event log) for unknown event types.
 */
async function normalizeWebhookEvent(
  info: WebhookInfo,
  deps: ProcessingDeps,
  bundle: ProviderBundle,
  resolvedOrgId: string,
): Promise<SimulatedEvent | null> {
  const event = bundle.normalizer.normalizeEvent(info.event, info.action, info.payload);
  if (event) return event;
  logger.debug('Unknown event type, skipping', {
    deliveryId: info.deliveryId,
    event: info.event,
  });
  webhooksProcessedTotal.add(1, { result: 'skipped' });
  await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
  return null;
}

// ---------------------------------------------------------------------------
// Phase B — Cross-source dispatch (generic webhook fan-out)
// ---------------------------------------------------------------------------

interface CrossSourceCandidate {
  reg: RegisteredWorkflow;
  /**
   * 'event': matched via webhook-event index (synthetic event path).
   * 'repo': matched via repo index (git-trigger path: normalize via the
   * registration's bundle and match via the provider normalizer).
   */
  matchMode: 'event' | 'repo';
}

/**
 * Phase B.1 — Refresh the registration index (so we don't miss a registration
 * just inserted by a peer) and gather de-duplicated cross-source candidates.
 * Same-source registrations (where the routing key matches the inbound) are
 * filtered out — they go through the same-source per-repo path so the bundle
 * cache + `__build__` coordinator still applies.
 */
async function gatherCrossSourceCandidates(
  info: WebhookInfo,
  deps: ProcessingDeps,
  resolvedOrgId: string,
  inboundEventName: string,
): Promise<CrossSourceCandidate[]> {
  if (!deps.registrationIndex) return [];

  if (deps.registrationStore) {
    try {
      const remoteVersion = await deps.registrationStore.getVersion();
      await deps.registrationIndex.refreshIfNeeded(remoteVersion);
    } catch (err) {
      logger.warn('Cross-source dispatch: registration index refresh failed', {
        deliveryId: info.deliveryId,
        error: toErrorMessage(err),
      });
    }
  }

  const eventRegistrations = deps.registrationIndex.getByOrgAndEvent(
    resolvedOrgId,
    inboundEventName,
  );
  const inboundRepoIdentifier = extractInboundRepoIdentifier(info.payload);
  const repoRegistrations =
    inboundRepoIdentifier !== null
      ? deps.registrationIndex.getByOrgAndRepo(resolvedOrgId, inboundRepoIdentifier)
      : [];

  const seenRegistrationIds = new Set<string>();
  const candidates: CrossSourceCandidate[] = [];
  for (const reg of eventRegistrations) {
    if (reg.routingKey === info.routingKey) continue;
    if (seenRegistrationIds.has(reg.id)) continue;
    seenRegistrationIds.add(reg.id);
    candidates.push({ reg, matchMode: 'event' });
  }
  for (const reg of repoRegistrations) {
    if (reg.routingKey === info.routingKey) continue;
    if (seenRegistrationIds.has(reg.id)) continue;
    seenRegistrationIds.add(reg.id);
    candidates.push({ reg, matchMode: 'repo' });
  }
  return candidates;
}

/**
 * Build the SimulatedEvent for a single cross-source candidate. Event-mode
 * candidates get a synthetic event whose `type` is the inbound name. Repo-mode
 * candidates delegate to the registration bundle's normalizer so git-trigger
 * workflows see provider-shaped payloads (branch, fork detection, sender, …).
 */
function buildCrossSourceEvent(
  info: WebhookInfo,
  deps: ProcessingDeps,
  candidate: CrossSourceCandidate,
  inboundEventName: string,
): SimulatedEvent | null {
  if (candidate.matchMode === 'event') {
    return {
      type: inboundEventName,
      action: undefined,
      payload: (info.payload ?? {}) as Record<string, unknown>,
      targetBranch: '',
      provider: 'generic',
    };
  }
  const regBundleForNormalization = deps.providerRegistry.getByRoutingKey(candidate.reg.routingKey);
  if (!regBundleForNormalization) return null;
  return regBundleForNormalization.normalizer.normalizeEvent(inboundEventName, null, info.payload);
}

/**
 * Phase B.2 — Dispatch a single cross-source candidate via
 * `dispatchMatchedWorkflow`. Mints a clone token through the registration's
 * bundle (fail-fast on errors — we MUST NOT fall back to the inbound generic
 * bundle which has no credentials for the registration's repo). Returns the
 * count of jobs successfully dispatched for this candidate.
 */
async function dispatchOneCrossSourceCandidate(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  candidate: CrossSourceCandidate;
  inboundEventName: string;
}): Promise<number> {
  const { info, deps, resolvedOrgId, candidate, inboundEventName } = args;
  const { reg } = candidate;

  const syntheticEvent = buildCrossSourceEvent(info, deps, candidate, inboundEventName);
  if (!syntheticEvent) {
    logger.debug('Cross-source repo dispatch: unable to normalize inbound event', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
      routingKey: reg.routingKey,
      inboundEventName,
    });
    return 0;
  }

  const decisions = matchAllWorkflows([reg.lockEntry], syntheticEvent);
  const matchedDecisions = decisions.filter((d) => d.matched);
  if (matchedDecisions.length === 0) return 0;

  // Composite dedup key: `${inboundDeliveryId}:${registrationId}`.
  // Each registration gets its own slot so re-delivery of the inbound webhook
  // is still idempotent per fan-out target.
  const crossDedupKey = `${info.deliveryId}:${reg.id}`;
  if (await deps.dedup.exists(crossDedupKey)) {
    logger.debug('Cross-source dispatch: composite dedup hit', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
    });
    return 0;
  }
  await deps.dedup.mark(crossDedupKey);

  const regBundle = deps.providerRegistry.getByRoutingKey(reg.routingKey);
  if (!regBundle) {
    logger.warn('Cross-source dispatch: registration bundle not found', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
      routingKey: reg.routingKey,
    });
    crossSourceErrorsTotal.add(1, { reason: 'bundle_missing' });
    return 0;
  }

  // Fail-fast clone-token issuance through the registration's bundle.
  let crossSourceCredentials: Record<string, unknown> = { ...reg.providerContext };
  try {
    const token = await regBundle.cloneTokenProvider?.createCloneToken(
      reg.repoIdentifier,
      reg.providerContext,
    );
    if (token) {
      crossSourceCredentials = { ...reg.providerContext, token };
    }
  } catch (err) {
    logger.error('Cross-source dispatch: clone token issuance failed', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
      routingKey: reg.routingKey,
      error: toErrorMessage(err),
    });
    crossSourceErrorsTotal.add(1, { reason: 'clone_token' });
    return 0;
  }

  let dispatchedCount = 0;
  for (const matched of matchedDecisions) {
    const crossRunId = randomUUID();
    enrichRequestContext({ runId: crossRunId });

    const syntheticEventWithFiles: SimulatedEvent = {
      ...syntheticEvent,
      changedFiles: [],
    };

    // Synthesize a single-workflow lockfile so the helper's internal lookup
    // (by workflow.name) still resolves. lockfileHash is cleared so the dep
    // cache check becomes a no-op; the bundle cache + build job path is also
    // disabled inside dispatchMatchedWorkflow via the `crossSource` flag (see
    // 28.4-VERIFICATION.md Gap 3 — bundles externalize @kici-dev/sdk and an
    // eval job in a fresh temp dir cannot resolve the package).
    // contentHash is preserved so the agent can still perform lock-file drift
    // detection on the compiled bundle.
    const crossSourceLockEntry: LockWorkflow = {
      ...(reg.lockEntry as LockWorkflow),
    };
    const syntheticLockFile = {
      workflows: [crossSourceLockEntry],
      lockfileHash: undefined,
      source: { file: reg.sourceFile ?? '.kici/workflows/unknown.ts' },
    };

    const helperResult = await dispatchMatchedWorkflow({
      info,
      deps,
      bundle: regBundle, // registration's bundle, NOT inbound generic
      payload: info.payload,
      repoIdentifier: reg.repoIdentifier,
      credentials: crossSourceCredentials,
      event: syntheticEvent,
      eventWithFiles: syntheticEventWithFiles,
      ref: reg.commitSha ?? 'HEAD',
      fullLockFile: syntheticLockFile,
      resolvedOrgId,
      workflow: crossSourceLockEntry,
      decision: matched,
      runId: crossRunId,
      trustResolution: undefined,
      lockFileSource: undefined,
      localWorkingTree: false,
      crossSource: true,
      crossSourceDeliveryId: crossDedupKey,
      effectiveRoutingKey: reg.routingKey,
      effectiveProvider: regBundle.normalizer.provider,
      extraJobConfig: {
        // Cross-source provenance fields — downstream agents and dashboard
        // rely on these for correct clone + logging.
        crossSource: true,
        inboundRoutingKey: info.routingKey,
        inboundEventName,
        workflowRepoUrl: regBundle.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '',
        // workflowRef is empty so the agent's gitClone() falls through to the
        // default-branch clone path. The registration's commitSha drives the
        // post-clone SHA verification + fetch-deepen path
        // (28.4-VERIFICATION.md Gap 2).
        workflowRef: '',
        workflowSha: reg.commitSha ?? '',
        workflowRepoIdentifier: reg.repoIdentifier,
      },
    });

    dispatchedCount += helperResult.dispatchedJobCount;
  }
  return dispatchedCount;
}

/**
 * Phase B.3 — After all candidates are dispatched (or zero matched), forward
 * the cross-source delivery summary to Platform, record metrics, and write
 * the event log row. The caller returns immediately after this — there is no
 * per-repo path for cross-source dispatches.
 */
async function recordCrossSourceCompletion(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  inboundEventName: string;
  candidatesConsidered: number;
  jobsDispatched: number;
}): Promise<void> {
  const { info, deps, resolvedOrgId, inboundEventName, candidatesConsidered, jobsDispatched } =
    args;
  if (deps.platformClient) {
    deps.platformClient.send({
      type: 'execution.event',
      messageId: randomUUID(),
      runId: randomUUID(),
      event: 'started',
      data: {
        deliveryId: info.deliveryId,
        webhookEvent: info.event,
        action: info.action,
        repoIdentifier: null,
        ref: null,
        matchedWorkflows: jobsDispatched,
        totalWorkflows: candidatesConsidered,
        crossSource: true,
        inboundEventName,
      },
      timestamp: Date.now(),
    });
  }

  webhooksProcessedTotal.add(1, {
    result: jobsDispatched > 0 ? 'matched' : 'skipped',
  });

  logger.info('Cross-source webhook processed', {
    deliveryId: info.deliveryId,
    inboundEventName,
    registrationsConsidered: candidatesConsidered,
    jobsDispatched,
  });

  // Record event-log row for the cross-source dispatch path. Cross-source
  // dispatches don't have a per-repo concept (the inbound generic webhook has
  // no repo); the repo is only known on the registration side. We record
  // `processed` with `matched_count = jobsDispatched`.
  if (deps.eventLog) {
    await deps.eventLog.record(info, payloadFromObject(info.payload), {
      orgId: resolvedOrgId,
      source: deps.eventLogSource ?? EventLogSource.enum.direct,
      status: EventLogStatus.enum.processed,
      matchedCount: jobsDispatched,
    });
  }
}

/**
 * Phase B (top-level) — Cross-source dispatch for inbound generic webhooks.
 *
 * Inbound generic webhooks have no repo / no lock file, so the per-repo
 * same-source matching path would always early-return with `matchedCount=0`.
 * This branch looks up webhook-trigger registrations in the SAME ORG and fans
 * out to each registration's owning bundle.
 *
 * Branch entry: `info.provider === 'generic' && deps.registrationIndex`.
 *
 * Returns `{ handled: true }` when at least one cross-source candidate
 * matched (the caller MUST early-return). Returns `{ handled: false }` when
 * no cross-source candidates matched — the same-source per-repo path below
 * still runs (cross-source is a SUPPLEMENT, not a replacement; the
 * local provider reads the lock file from a
 * bind-mounted repo via the same-source path).
 */
async function dispatchCrossSourceWorkflows(
  info: WebhookInfo,
  deps: ProcessingDeps,
  event: SimulatedEvent,
  resolvedOrgId: string,
): Promise<{ handled: boolean }> {
  // Pitfall 5 guard: the inbound event name lives in event.action for generic
  // webhooks (the generic normalizer sets event.type = 'generic_webhook').
  // Fall back to info.event if action is unset.
  const inboundEventName = event.action ?? info.event;

  const candidates = await gatherCrossSourceCandidates(info, deps, resolvedOrgId, inboundEventName);

  // Always record fan-out size — we want the histogram to show no-match cases
  // too (e.g., to detect mis-configured event names).
  crossSourceFanoutSize.record(candidates.length, { event: inboundEventName });

  if (candidates.length === 0) {
    logger.debug('Cross-source: no registrations for event, falling through', {
      deliveryId: info.deliveryId,
      inboundEventName,
      orgId: resolvedOrgId,
    });
    return { handled: false };
  }

  let jobsDispatched = 0;
  for (const candidate of candidates) {
    jobsDispatched += await dispatchOneCrossSourceCandidate({
      info,
      deps,
      resolvedOrgId,
      candidate,
      inboundEventName,
    });
  }

  await recordCrossSourceCompletion({
    info,
    deps,
    resolvedOrgId,
    inboundEventName,
    candidatesConsidered: candidates.length,
    jobsDispatched,
  });
  return { handled: true };
}

// ---------------------------------------------------------------------------
// Phase C — repo + credentials + /kici approval comments
// ---------------------------------------------------------------------------

interface RepoAndCredentials {
  repoIdentifier: string;
  credentials: Record<string, unknown>;
}

/**
 * Phase C.1 — Extract repo identifier and credentials from the inbound payload.
 * Returns null + records skip metrics/event log when no repo identifier can be
 * derived (e.g., events that don't carry a repo).
 */
async function extractRepoAndCredentials(
  info: WebhookInfo,
  deps: ProcessingDeps,
  bundle: ProviderBundle,
  resolvedOrgId: string,
): Promise<RepoAndCredentials | null> {
  const repoIdentifier = bundle.normalizer.extractRepoIdentifier(info.payload);
  if (!repoIdentifier) {
    logger.debug('Missing repository info in payload, skipping', {
      deliveryId: info.deliveryId,
    });
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
    return null;
  }
  const credentials = bundle.normalizer.extractCredentials(info.payload);
  return { repoIdentifier, credentials };
}

/**
 * Phase C.2 — Handle `/kici approve|reject` commands in `issue_comment` events.
 * These intercept BEFORE normal trigger matching (the comment is a command,
 * not a trigger). The function never returns early — the event continues
 * through trigger matching afterwards in case workflows have issue_comment
 * triggers.
 */
async function handleApprovalCommentIfPresent(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  payload: Record<string, unknown>;
  resolvedOrgId: string;
  repoIdentifier: string;
  credentials: Record<string, unknown>;
}): Promise<void> {
  const { info, deps, bundle, event, payload, resolvedOrgId, repoIdentifier, credentials } = args;
  if (info.event !== 'issue_comment' || !deps.heldRunStore) return;

  const commentBody = (payload.comment as { body?: string } | undefined)?.body;
  const senderUsername = event.senderUsername;
  const prNumber = (payload.issue as { number?: number } | undefined)?.number;
  const prHead = (payload.issue as { pull_request?: { url?: string } } | undefined)?.pull_request;

  if (!commentBody || !senderUsername || !prNumber || !prHead) return;
  const command = parseKiciCommand(commentBody);
  if (!command) return;

  // Look up the held run's commit SHA from execution_runs so the check status
  // poster can update the right commit.
  let commitSha: string | undefined;
  if (deps.db) {
    const heldRun = await deps.db
      .selectFrom('held_runs')
      .innerJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
      .select(['execution_runs.sha'])
      .where('held_runs.org_id', '=', resolvedOrgId)
      .where('held_runs.queue_type', '=', 'security')
      .where('held_runs.status', '=', 'pending')
      .where('execution_runs.repo_identifier', '=', repoIdentifier)
      .orderBy('held_runs.created_at', 'desc')
      .executeTakeFirst();
    commitSha = heldRun?.sha;
  }

  const result = await handleApprovalComment({
    commentBody,
    commenterUsername: senderUsername,
    commenterUserId: event.senderUserId,
    provider: info.provider,
    repoIdentifier,
    prNumber,
    orgId: resolvedOrgId,
    identityLinks: deps.identityLinks ?? [],
    orgMemberPermissions: deps.orgMemberPermissions ?? new Map(),
    heldRunStore: deps.heldRunStore,
    checkStatusPoster: bundle.checkStatusPoster,
    commitSha,
    credentials,
  });

  if (result.handled) {
    logger.info('Handled /kici command from comment', {
      deliveryId: info.deliveryId,
      action: command.action,
      commenter: senderUsername,
      prNumber,
      reason: result.reason,
    });
    webhooksProcessedTotal.add(1, { result: 'handled' });
    // Don't return — let the event continue through trigger matching in case
    // workflows have issue_comment triggers.
  }
}

// ---------------------------------------------------------------------------
// Phase D — trust resolution for PR events
// ---------------------------------------------------------------------------

interface TrustOutcome {
  trustResolution: TrustResolution | undefined;
  /** Default 'base' for PR events; trust resolution may override to 'head'. */
  lockFileSource: 'head' | 'base';
}

function isPullRequestEvent(eventName: string): boolean {
  return (
    eventName === 'pull_request' ||
    eventName === 'pull_request_review' ||
    eventName === 'pull_request_review_comment'
  );
}

/**
 * Phase D — Resolve the trust tier for the inbound event. For PR events the
 * result drives lock-file-source selection (trusted contributors get the head
 * lock file; everyone else gets base) and the user-cache write scope; failures
 * fail-closed to base. A push to the repo's default branch is itself a trusted
 * ref — only someone with write access can land a commit there — so it resolves
 * to `trusted`, which `deriveCacheRefScope` maps to the org-shared cache scope
 * (the GitHub Actions model: default-branch builds populate the shared cache,
 * fork/PR builds are confined to a per-run isolated scope).
 *
 * A non-PR event from a provider with no contributor model (generic webhook
 * sources, where the source's verification secret IS the trust boundary; local
 * sources, where the operator owns the on-disk repo — neither has a fork or
 * per-contributor permission concept) is likewise
 * trusted: the sender already proved ownership of the source, so its builds may
 * populate the org-shared cache.
 */
/** Build a `trusted`-tier TrustResolution with a fixed audit reason. */
function makeTrustedResolution(contributorUsername: string, reason: string): TrustResolution {
  return {
    tier: 'trusted',
    contributorUsername,
    identityLinked: false,
    providerPermission: 'write',
    reason,
  };
}

export async function resolveTrustForPR(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  payload: Record<string, unknown>;
  resolvedOrgId: string;
  repoIdentifier: string;
  credentials: Record<string, unknown>;
}): Promise<TrustOutcome> {
  const { info, deps, bundle, event, payload, resolvedOrgId, repoIdentifier, credentials } = args;
  const isPREvent = isPullRequestEvent(info.event);
  const initial: TrustOutcome = {
    trustResolution: undefined,
    lockFileSource: selectLockFileSource(isPREvent, undefined),
  };

  // A default-branch push is a trusted ref: only a write-or-higher contributor
  // can push to it. Mark it trusted so the user-cache write scope is `shared`.
  if (!isPREvent && isDefaultBranchPush(info, event, payload, bundle.normalizer)) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Push to the default branch -- trusted ref (org-shared cache scope)',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // A non-PR event from a provider with no contributor model (generic
  // sources, where the verification secret is the trust boundary; local
  // sources, where the operator owns the on-disk repo — neither has a fork
  // or per-contributor permission concept) is trusted by construction.
  if (!isPREvent && !bundle.contributorResolver) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Non-PR event from a contributor-less provider (generic/local) -- trusted ref',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  if (!isPREvent || !deps.trustResolver || !event.senderUsername) return initial;
  const contributorResolver = bundle.contributorResolver;
  if (!contributorResolver) return initial;

  try {
    const trustResolution = await deps.trustResolver.resolveTrustTier({
      providerUsername: event.senderUsername,
      providerUserId: event.senderUserId,
      provider: info.provider,
      repoIdentifier,
      isForkPR: event.isForkPR ?? false,
      orgId: resolvedOrgId,
      identityLinks: deps.identityLinks ?? [],
      orgMemberPermissions: deps.orgMemberPermissions ?? new Map(),
      contributorResolver,
      credentials,
    });
    const lockFileSource = selectLockFileSource(isPREvent, trustResolution.tier);
    logger.info('Trust tier resolved for PR', {
      deliveryId: info.deliveryId,
      sender: event.senderUsername,
      tier: trustResolution.tier,
      lockFileSource,
      reason: trustResolution.reason,
    });
    return { trustResolution, lockFileSource };
  } catch (err) {
    logger.warn('Trust resolution failed, defaulting to base lock file', {
      deliveryId: info.deliveryId,
      sender: event.senderUsername,
      error: toErrorMessage(err),
    });
    return {
      trustResolution: undefined,
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }
}

// ---------------------------------------------------------------------------
// Phase E — Lock file fetch (with multi-provider fallback)
// ---------------------------------------------------------------------------

interface LockFileOutcome {
  lockFile: unknown;
  /** True when a lock file was present at the repo ref but could not be parsed,
   *  and nothing else resolved. Routed to a lock_resolution init-failure run. */
  corrupt: boolean;
  corruptError?: LockFileParseError;
  headLockFileForDiff: FullLockFile | undefined;
  /** Bundle to use for clone URL + token issuance (may differ from inbound). */
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  resolvedFallbackBundle: ProviderBundle | undefined;
  resolvedFallbackRoutingKey: string | undefined;
}

/**
 * Phase E — Fetch the lock file via the multi-provider fallback resolver. The
 * resolver tries the inbound bundle's fetcher first, then iterates other
 * same-customer registrations for this repo. When fallback fires, the dispatch
 * bundle/credentials are swapped to the winning bundle (Layer 4 of the
 * cross-provider pipeline binding fix — without this, file:// URLs leak from
 * the local bundle and clone-token issuance fails).
 *
 * For PR events evaluated against the base branch, both base + head lock
 * files are fetched in parallel; the head lock file is used for workflow
 * modification detection.
 */
async function fetchLockFileWithFallbackPhase(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  resolvedOrgId: string;
  repoIdentifier: string;
  credentials: Record<string, unknown>;
  ref: string;
  isPREvent: boolean;
  lockFileSource: 'head' | 'base';
}): Promise<LockFileOutcome> {
  const {
    info,
    deps,
    bundle,
    event,
    resolvedOrgId,
    repoIdentifier,
    credentials,
    ref,
    isPREvent,
    lockFileSource,
  } = args;

  if (!bundle.lockFileFetcher) {
    logger.debug('No lock file fetcher available for inbound provider, relying on fallback', {
      deliveryId: info.deliveryId,
    });
  }

  let lockFile: unknown;
  let corrupt = false;
  let corruptError: LockFileParseError | undefined;
  let headLockFileForDiff: FullLockFile | undefined;
  let resolvedFallbackBundle: ProviderBundle | undefined;
  let resolvedFallbackCredentials: Record<string, unknown> | undefined;
  let resolvedFallbackRoutingKey: string | undefined;

  const baseBranchRef = event.baseBranch;
  if (isPREvent && lockFileSource === 'base' && baseBranchRef) {
    const [baseResult, headResult] = await Promise.all([
      resolveLockFileWithFallback({
        inboundBundle: bundle,
        inboundRoutingKey: info.routingKey,
        repoIdentifier,
        ref: baseBranchRef,
        inboundCredentials: credentials,
        customerId: resolvedOrgId,
        providerRegistry: deps.providerRegistry,
        registrationIndex: deps.registrationIndex,
        lockFileCache: deps.lockFileCache,
        deliveryId: info.deliveryId,
      }),
      resolveLockFileWithFallback({
        inboundBundle: bundle,
        inboundRoutingKey: info.routingKey,
        repoIdentifier,
        ref,
        inboundCredentials: credentials,
        customerId: resolvedOrgId,
        providerRegistry: deps.providerRegistry,
        registrationIndex: deps.registrationIndex,
        lockFileCache: deps.lockFileCache,
        deliveryId: info.deliveryId,
      }),
    ]);
    lockFile = baseResult.lockFile;
    // The base result is the one short-circuited on; surface its corrupt outcome.
    corrupt = baseResult.resolvedVia === 'corrupt';
    corruptError = baseResult.corruptError;
    headLockFileForDiff = headResult.lockFile as unknown as FullLockFile | undefined;
    // Prefer baseResult's fallback bundle (base triggers matching), fall back
    // to headResult's if base resolved via inbound but head via fallback.
    const fbSource = baseResult.resolvedVia === 'fallback' ? baseResult : headResult;
    if (fbSource.resolvedVia === 'fallback' && fbSource.fallbackBundle) {
      resolvedFallbackBundle = fbSource.fallbackBundle;
      resolvedFallbackCredentials = fbSource.fallbackCredentials;
      resolvedFallbackRoutingKey = fbSource.fallbackRoutingKey;
    }
  } else {
    const result = await resolveLockFileWithFallback({
      inboundBundle: bundle,
      inboundRoutingKey: info.routingKey,
      repoIdentifier,
      ref,
      inboundCredentials: credentials,
      customerId: resolvedOrgId,
      providerRegistry: deps.providerRegistry,
      registrationIndex: deps.registrationIndex,
      lockFileCache: deps.lockFileCache,
      deliveryId: info.deliveryId,
    });
    lockFile = result.lockFile;
    corrupt = result.resolvedVia === 'corrupt';
    corruptError = result.corruptError;
    if (result.resolvedVia === 'fallback' && result.fallbackBundle) {
      resolvedFallbackBundle = result.fallbackBundle;
      resolvedFallbackCredentials = result.fallbackCredentials;
      resolvedFallbackRoutingKey = result.fallbackRoutingKey;
    }
  }

  let dispatchBundle = bundle;
  let dispatchCredentials = credentials;
  if (resolvedFallbackBundle) {
    dispatchBundle = resolvedFallbackBundle;
    dispatchCredentials = resolvedFallbackCredentials ?? credentials;
    logger.info('Cross-provider dispatch: using fallback bundle for clone URL + token', {
      deliveryId: info.deliveryId,
      inboundRoutingKey: info.routingKey,
      fallbackRoutingKey: resolvedFallbackRoutingKey,
      repoIdentifier,
    });
  }

  return {
    lockFile,
    corrupt,
    corruptError,
    headLockFileForDiff,
    dispatchBundle,
    dispatchCredentials,
    resolvedFallbackBundle,
    resolvedFallbackRoutingKey,
  };
}

// ---------------------------------------------------------------------------
// Phase F — Global workflow dispatch (shared by no-lock-file + post-match paths)
// ---------------------------------------------------------------------------

/**
 * Build the per-static-job QueuedJobInput for a global workflow dispatched
 * from the inbound webhook. Shared by the lock-file-missing branch (Phase F)
 * and the post-per-repo dispatch branch (Phase J) — both paths build the same
 * inputs from the same registration shape.
 */
function buildGlobalWorkflowJobInputs(args: {
  info: WebhookInfo;
  reg: RegisteredWorkflow;
  globalWorkflow: LockWorkflow;
  globalRunId: string;
  ref: string;
  event: SimulatedEvent;
  repoIdentifier: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
}): { lockJobName: string; input: QueuedJobInput }[] {
  const {
    info,
    reg,
    globalWorkflow,
    globalRunId,
    ref,
    event,
    repoIdentifier,
    dispatchBundle,
    dispatchCredentials,
  } = args;
  const workflowRepoUrl = dispatchBundle.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '';
  const inputs: { lockJobName: string; input: QueuedJobInput }[] = [];
  const materialized = materializeFanout(globalWorkflow.jobs.filter(isLockStaticJob)).jobs;
  for (const mat of materialized) {
    const lockJob = mat.lockJob;
    const runsOnParts = partitionMatchers(lockJob.runsOn ?? []);
    const excludeParts = partitionMatchers(lockJob.excludeLabels ?? []);
    const flatLabels = runsOnParts.exact;
    const jobConfig: Record<string, unknown> = {
      source: globalWorkflow.source ?? reg.lockEntry.source,
      workflowName: globalWorkflow.name,
      ...matrixEnvelopeFields(mat),
      steps: lockJob.steps,
      needs: lockJob.needs,
      rules: lockJob.rules,
      isGlobalWorkflow: true,
      workflowRepoUrl,
      workflowRef: '',
      workflowSha: reg.commitSha ?? '',
      workflowRepoIdentifier: reg.repoIdentifier,
      // Cross-provider auth plumbing (Phase 4 Option B): when the
      // registration's routing key differs from the inbound, the dispatcher
      // resolves the workflow-repo bundle by this key and mints `workflowAuth`
      // independently from `sourceAuth`.
      workflowRoutingKey: reg.routingKey,
      workflowProviderContext: reg.providerContext,
    };
    inputs.push({
      lockJobName: mat.expandedName,
      input: {
        runId: globalRunId,
        workflowName: globalWorkflow.name,
        jobName: mat.expandedName,
        runsOnLabels: flatLabels,
        runsOnPatterns: runsOnParts.regex,
        excludeLabels: excludeParts.exact,
        excludePatterns: excludeParts.regex,
        jobConfig,
        repoUrl: dispatchBundle.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
        ref: event.sourceBranch ?? event.targetBranch,
        sha: ref,
        deliveryId: info.deliveryId,
        provider: info.provider,
        providerContext: dispatchCredentials as Record<string, unknown>,
        routingKey: info.routingKey,
        requestId: getRequestContext().requestId,
      },
    });
  }
  return inputs;
}

/**
 * Phase F — Lock file is missing for this repo — try global workflows in the
 * SAME ORG that target this event type. Even without a per-repo lock file,
 * global workflows in other repos may match. Returns the count of jobs
 * dispatched (used for metrics + event log).
 */
async function tryDispatchGlobalsWithoutLockFile(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
}): Promise<number> {
  const {
    info,
    deps,
    event,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
  } = args;
  if (!deps.registrationIndex) return 0;

  // Refresh registration index in case external changes were made.
  if (deps.registrationStore) {
    const remoteVersion = await deps.registrationStore.getVersion();
    await deps.registrationIndex.refreshIfNeeded(remoteVersion);
  }

  const triggerType = eventTypeToTriggerType(info.event);
  const globalRegistrations = deps.registrationIndex.getGlobalByOrgAndTriggerType(
    resolvedOrgId,
    triggerType,
  );

  let globalMatched = 0;
  for (const reg of globalRegistrations) {
    if (reg.repoIdentifier === repoIdentifier) continue;

    if (deps.globalWorkflowPolicy) {
      const sourceCheck = await deps.globalWorkflowPolicy.isSourceRepoAllowed(
        info.routingKey,
        repoIdentifier,
        resolvedOrgId,
      );
      if (!sourceCheck.allowed) {
        logger.info('Skipping global workflow dispatch: source repo in deny-list', {
          sourceRepo: repoIdentifier,
          eventRoutingKey: info.routingKey,
          workflowRoutingKey: reg.routingKey,
          reason: sourceCheck.reason,
        });
        continue;
      }
      const permission = await deps.globalWorkflowPolicy.isWorkflowRepoAllowed(
        reg.routingKey,
        reg.repoIdentifier,
        resolvedOrgId,
      );
      if (!permission.allowed) continue;
    }

    const eventWithSourceRepo: SimulatedEvent = { ...event, sourceRepo: repoIdentifier };
    const globalDecisions = matchAllWorkflows([reg.lockEntry], eventWithSourceRepo);

    for (const gDecision of globalDecisions) {
      if (!gDecision.matched) continue;
      globalMatched++;
      const globalRunId = randomUUID();
      enrichRequestContext({ runId: globalRunId });
      const inputs = buildGlobalWorkflowJobInputs({
        info,
        reg,
        globalWorkflow: reg.lockEntry,
        globalRunId,
        ref,
        event,
        repoIdentifier,
        dispatchBundle,
        dispatchCredentials,
      });
      for (const { lockJobName, input } of inputs) {
        const result = await deps.dispatcher.dispatch(input);
        if (result.status !== 'rejected') {
          logger.info('Global workflow job dispatched (no lock file path)', {
            runId: globalRunId,
            workflow: reg.lockEntry.name,
            job: lockJobName,
            status: result.status,
            sourceRepo: repoIdentifier,
            workflowRepo: reg.repoIdentifier,
          });
        }
      }
    }
  }

  return globalMatched;
}

// ---------------------------------------------------------------------------
// Phase G — Workflow modification detection + security hold check status
// ---------------------------------------------------------------------------

interface SecurityState {
  workflowModifications: WorkflowModification[];
  securityHold: { reason: string } | undefined;
}

/**
 * Phase G — On non-trusted PR events evaluated against the base lock file,
 * detect workflow modifications by diffing base vs. head, post a neutral
 * informational check status, and (if the contributor is unknown/known) set
 * a security hold so the matched workflows queue for approval.
 *
 * Also posts a pending check status for any security hold reason — the hold
 * itself is later set inside `dispatchMatchedWorkflow` based on environment
 * protection rules; this only handles the workflow_modification reason.
 */
function applyWorkflowModificationsAndSecurityHold(args: {
  info: WebhookInfo;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  fullLockFile: FullLockFile;
  headLockFileForDiff: FullLockFile | undefined;
  isPREvent: boolean;
  lockFileSource: 'head' | 'base';
  trustResolution: TrustResolution | undefined;
  repoIdentifier: string;
  ref: string;
  credentials: Record<string, unknown>;
}): SecurityState {
  const {
    info,
    bundle,
    event,
    fullLockFile,
    headLockFileForDiff,
    isPREvent,
    lockFileSource,
    trustResolution,
    repoIdentifier,
    ref,
    credentials,
  } = args;
  let workflowModifications: WorkflowModification[] = [];
  let securityHold: { reason: string } | undefined;

  if (isPREvent && lockFileSource === 'base' && headLockFileForDiff) {
    workflowModifications = detectWorkflowModifications(fullLockFile, headLockFileForDiff);

    if (workflowModifications.length > 0) {
      const tier = trustResolution?.tier ?? 'unknown';
      logger.info('Workflow modifications detected in PR', {
        deliveryId: info.deliveryId,
        sender: event.senderUsername,
        tier,
        modifications: workflowModifications.map((m) => `${m.changeType}:${m.workflowName}`),
      });

      if (tier === 'known' || tier === 'unknown') {
        securityHold = { reason: 'workflow_modification' };
      }
    }

    if (workflowModifications.length > 0 && bundle.checkStatusPoster) {
      const modLines = workflowModifications.map(
        (m) => `- **${m.changeType}**: \`${m.workflowName}\``,
      );
      const modSummary = [
        'This PR adds/modifies workflows -- changes will take effect after merge.',
        '',
        '### Detected changes',
        ...modLines,
      ].join('\n');
      bundle.checkStatusPoster
        .postCheckStatus(
          repoIdentifier,
          ref,
          'neutral',
          'Workflow changes detected',
          modSummary,
          credentials,
        )
        .catch((err) => {
          logger.warn('Failed to post workflow modification check', {
            deliveryId: info.deliveryId,
            error: toErrorMessage(err),
          });
        });
    }
  }

  if (securityHold && bundle.checkStatusPoster) {
    const holdSummary = buildSecurityHoldSummary(
      securityHold.reason,
      trustResolution?.tier ?? 'unknown',
      trustResolution?.contributorUsername,
    );
    bundle.checkStatusPoster
      .postCheckStatus(
        repoIdentifier,
        ref,
        'pending',
        'Held for approval',
        holdSummary,
        credentials,
      )
      .catch((err) => {
        logger.warn('Failed to post security hold check', {
          deliveryId: info.deliveryId,
          error: toErrorMessage(err),
        });
      });
  }

  return { workflowModifications, securityHold };
}

// ---------------------------------------------------------------------------
// Phase H — Workflow registration on default-branch push
// ---------------------------------------------------------------------------

/**
 * Phase H — When a push event lands on the repo's default branch, refresh the
 * workflow registration set so cross-source / global webhook lookups see the
 * latest set. Local sources only TRIGGER workflows — they
 * must not re-register them, otherwise the dashboard shows duplicates under
 * the generic routing key.
 */
async function registerWorkflowsOnDefaultBranchPush(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  payload: Record<string, unknown>;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  credentials: Record<string, unknown>;
  fullLockFile: FullLockFile;
}): Promise<void> {
  const {
    info,
    deps,
    bundle,
    event,
    payload,
    resolvedOrgId,
    repoIdentifier,
    ref,
    credentials,
    fullLockFile,
  } = args;

  if (!deps.registrationStore || !deps.registrationIndex) return;
  if (info.provider === 'local') return;
  if (!isDefaultBranchPush(info, event, payload, bundle.normalizer)) return;

  let registerableWorkflows = extractRegisterableWorkflows(fullLockFile);
  let globalWorkflowNames = new Set(extractGlobalWorkflows(fullLockFile).map((w) => w.name));

  // Check workflow-repo allow-list before registration. Registration is
  // about authoring, so the source-repo deny-list does not apply here.
  if (deps.globalWorkflowPolicy) {
    const globalWorkflows = extractGlobalWorkflows(fullLockFile);
    if (globalWorkflows.length > 0) {
      const permission = await deps.globalWorkflowPolicy.isWorkflowRepoAllowed(
        info.routingKey,
        repoIdentifier,
        resolvedOrgId,
      );
      if (!permission.allowed) {
        logger.warn('Skipping global workflow registration: not permitted', {
          reason: permission.reason,
          repo: repoIdentifier,
        });
        const globalNames = new Set(globalWorkflows.map((w) => w.name));
        registerableWorkflows = registerableWorkflows.filter((w) => !globalNames.has(w.name));
        globalWorkflowNames = new Set();
      }
    }
  }

  // Always replace (handles removals even at count 0). resolvedOrgId on every
  // registration row is what makes the cross-source webhook lookup org-isolated.
  await deps.registrationStore.replaceAll(
    repoIdentifier,
    registerableWorkflows,
    info.routingKey,
    credentials,
    {
      customerId: resolvedOrgId,
      commitSha: ref !== 'HEAD' ? ref : undefined,
      globalWorkflowNames,
    },
  );
  const newVersion = await deps.registrationStore.bumpVersion();
  await deps.registrationIndex.refreshIfNeeded(newVersion);

  if (deps.cronScheduler) {
    await deps.cronScheduler.refreshCache();
  }

  logger.info('Workflow registrations updated', {
    repoIdentifier,
    workflowCount: registerableWorkflows.length,
    registryVersion: newVersion,
  });

  if (deps.eventRouter) {
    await deps.eventRouter.emit({
      eventName: 'registration.updated',
      payload: {
        repo: repoIdentifier,
        workflowCount: registerableWorkflows.length,
        workflows: registerableWorkflows.map((w) => w.name),
      },
      sourceRepo: repoIdentifier,
      sourceRoutingKey: info.routingKey,
    });
  }
}

// ---------------------------------------------------------------------------
// Phase I — Match triggers + dispatch matched same-source workflows
// ---------------------------------------------------------------------------

interface MatchedSummary {
  decisions: ReturnType<typeof matchAllWorkflows>;
  matchedCount: number;
  matchedRunIds: string[];
}

/**
 * Phase I.1 — Lazily fetch changed files (skipped when no trigger uses path
 * patterns) and match all workflow triggers in the lock file against the
 * resulting event. Records the trigger-match duration metric.
 */
async function gatherChangedFilesAndMatchTriggers(args: {
  info: WebhookInfo;
  payload: Record<string, unknown>;
  event: SimulatedEvent;
  fullLockFile: FullLockFile;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  repoIdentifier: string;
}): Promise<{ eventWithFiles: SimulatedEvent; decisions: ReturnType<typeof matchAllWorkflows> }> {
  const {
    info,
    payload,
    event,
    fullLockFile,
    dispatchBundle,
    dispatchCredentials,
    repoIdentifier,
  } = args;
  const changedFiles =
    dispatchBundle.changedFilesFetcher &&
    anyTriggerHasPathPatterns(fullLockFile.workflows as LockWorkflow[])
      ? await dispatchBundle.changedFilesFetcher.getChangedFiles(
          repoIdentifier,
          info.event,
          payload,
          dispatchCredentials,
        )
      : [];

  // Populate sourceRepo so same-repo global workflows (those authored in the
  // event's own repo and gated by `repos` patterns) evaluate correctly; the
  // cross-repo matching branch below skips same-repo globals on the
  // assumption that per-repo matching already covers them.
  const eventWithFiles: SimulatedEvent = {
    ...event,
    changedFiles,
    sourceRepo: repoIdentifier,
  };

  const matchStart = process.hrtime.bigint();
  const decisions = matchAllWorkflows(fullLockFile.workflows, eventWithFiles);
  const matchDuration = Number(process.hrtime.bigint() - matchStart) / 1e9;
  triggerMatchDurationSeconds.record(matchDuration);
  return { eventWithFiles, decisions };
}

/**
 * Phase I.2 — For each matched workflow, mint a fresh runId and delegate to
 * `dispatchMatchedWorkflow` which handles cache + build coordination, secret
 * resolution, environment evaluation, static dispatch, deferred init/dynamic
 * dispatch, and execution-tracker registration. Each matched workflow gets
 * its OWN runId so execution tracking, check runs, and Platform event
 * forwarding don't collide when multiple workflows match.
 */
async function dispatchMatchedSameSourceWorkflows(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  payload: unknown;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  event: SimulatedEvent;
  eventWithFiles: SimulatedEvent;
  ref: string;
  fullLockFile: FullLockFile;
  resolvedOrgId: string;
  decisions: ReturnType<typeof matchAllWorkflows>;
  trustResolution: TrustResolution | undefined;
  lockFileSource: 'head' | 'base';
  repoIdentifier: string;
  resolvedFallbackRoutingKey: string | undefined;
  resolvedFallbackBundle: ProviderBundle | undefined;
}): Promise<MatchedSummary> {
  const {
    info,
    deps,
    payload,
    dispatchBundle,
    dispatchCredentials,
    event,
    eventWithFiles,
    ref,
    fullLockFile,
    resolvedOrgId,
    decisions,
    trustResolution,
    lockFileSource,
    repoIdentifier,
    resolvedFallbackRoutingKey,
    resolvedFallbackBundle,
  } = args;

  let matchedCount = 0;
  const matchedRunIds: string[] = [];

  for (const decision of decisions) {
    if (!decision.matched) continue;
    matchedCount++;
    const workflow = fullLockFile.workflows.find(
      (w: LockWorkflow) => w.name === decision.workflowName,
    );
    if (!workflow) continue;

    const runId = randomUUID();
    matchedRunIds.push(runId);
    enrichRequestContext({ runId });

    await dispatchMatchedWorkflow({
      info,
      deps,
      bundle: dispatchBundle,
      payload,
      repoIdentifier,
      credentials: dispatchCredentials,
      event,
      eventWithFiles,
      ref,
      fullLockFile,
      resolvedOrgId,
      workflow,
      decision,
      runId,
      trustResolution,
      lockFileSource,
      localWorkingTree: false,
      crossSource: false,
      effectiveRoutingKey: resolvedFallbackRoutingKey ?? undefined,
      effectiveProvider: resolvedFallbackBundle
        ? resolvedFallbackBundle.normalizer.provider
        : undefined,
    });
  }

  return { decisions, matchedCount, matchedRunIds };
}

// ---------------------------------------------------------------------------
// Phase J — Match + dispatch global workflows for OTHER repos
// ---------------------------------------------------------------------------

/**
 * Phase J — After per-repo workflows are dispatched, query the global index
 * for workflows authored in OTHER repos that target this event type via
 * cross-repo `repos` patterns. Same-org scope picks up both same-source and
 * cross-source globals (cross-provider global workflows).
 */
async function dispatchGlobalWorkflowsForOtherRepos(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  eventWithFiles: SimulatedEvent;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
}): Promise<{ matchedCount: number; matchedRunIds: string[] }> {
  const {
    info,
    deps,
    eventWithFiles,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
  } = args;
  if (!deps.registrationIndex) return { matchedCount: 0, matchedRunIds: [] };

  let matchedCount = 0;
  const matchedRunIds: string[] = [];

  const triggerType = eventTypeToTriggerType(info.event);
  const globalRegistrations = deps.registrationIndex.getGlobalByOrgAndTriggerType(
    resolvedOrgId,
    triggerType,
  );

  for (const reg of globalRegistrations) {
    // Skip workflows from the event's own repo (already matched via lock file
    // path -- pitfall 1).
    if (reg.repoIdentifier === repoIdentifier) continue;

    if (deps.globalWorkflowPolicy) {
      // Policy checks key the org_settings row by `customer_id` — single
      // row per org regardless of how many sources the org has. The two
      // routing-key arguments below are matched against per-entry
      // qualifiers: deny entries match the EVENT's routing key (events
      // are filtered by their own source), allow / elevate entries match
      // the WORKFLOW's routing key (workflows are filtered by where they
      // were authored).
      const sourceCheck = await deps.globalWorkflowPolicy.isSourceRepoAllowed(
        info.routingKey,
        repoIdentifier,
        resolvedOrgId,
      );
      if (!sourceCheck.allowed) {
        logger.info('Skipping global workflow dispatch: source repo in deny-list', {
          sourceRepo: repoIdentifier,
          eventRoutingKey: info.routingKey,
          workflowRoutingKey: reg.routingKey,
          reason: sourceCheck.reason,
        });
        continue;
      }
      const permission = await deps.globalWorkflowPolicy.isWorkflowRepoAllowed(
        reg.routingKey,
        reg.repoIdentifier,
        resolvedOrgId,
      );
      if (!permission.allowed) continue;
    }

    const eventWithSourceRepo: SimulatedEvent = {
      ...eventWithFiles,
      sourceRepo: repoIdentifier,
    };
    const globalDecisions = matchAllWorkflows([reg.lockEntry], eventWithSourceRepo);

    for (const gDecision of globalDecisions) {
      if (!gDecision.matched) continue;
      matchedCount++;
      const globalRunId = randomUUID();
      matchedRunIds.push(globalRunId);
      enrichRequestContext({ runId: globalRunId });

      const inputs = buildGlobalWorkflowJobInputs({
        info,
        reg,
        globalWorkflow: reg.lockEntry,
        globalRunId,
        ref,
        event: eventWithFiles,
        repoIdentifier,
        dispatchBundle,
        dispatchCredentials,
      });
      for (const { lockJobName, input } of inputs) {
        const result = await deps.dispatcher.dispatch(input);
        if (result.status !== 'rejected') {
          logger.info('Global workflow job dispatched', {
            runId: globalRunId,
            workflow: reg.lockEntry.name,
            job: lockJobName,
            status: result.status,
            sourceRepo: repoIdentifier,
            workflowRepo: reg.repoIdentifier,
          });
        }
      }
    }
  }

  return { matchedCount, matchedRunIds };
}

// ---------------------------------------------------------------------------
// Phase K — Forward Platform trace + record event log + final metrics
// ---------------------------------------------------------------------------

async function forwardTracesAndRecordEventLog(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  payload: Record<string, unknown>;
  decisions: ReturnType<typeof matchAllWorkflows>;
  matchedCount: number;
  matchedRunIds: string[];
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
}): Promise<void> {
  const {
    info,
    deps,
    payload,
    decisions,
    matchedCount,
    matchedRunIds,
    resolvedOrgId,
    repoIdentifier,
    ref,
  } = args;

  if (deps.platformClient) {
    deps.platformClient.send({
      type: 'execution.event',
      messageId: randomUUID(),
      runId: randomUUID(),
      event: 'started',
      data: {
        deliveryId: info.deliveryId,
        webhookEvent: info.event,
        action: info.action,
        repoIdentifier,
        ref,
        matchedWorkflows: matchedCount,
        totalWorkflows: decisions.length,
        decisions: decisions.map(summarizeDecision),
      },
      timestamp: Date.now(),
    });
  }

  webhooksProcessedTotal.add(1, { result: matchedCount > 0 ? 'matched' : 'skipped' });

  // Fire-and-forget payload write (filesystem only — log storage is handled
  // elsewhere).
  if (deps.webhookPayloadDir) {
    const payloadDir = join(deps.webhookPayloadDir, repoIdentifier, info.deliveryId);
    mkdir(payloadDir, { recursive: true })
      .then(() => writeFile(join(payloadDir, 'payload.json'), JSON.stringify(payload, null, 2)))
      .catch((err) => logger.warn('Failed to write webhook payload', { error: String(err) }));
  }

  if (deps.eventLog) {
    const firstRunId = matchedRunIds[0] ?? null;
    await deps.eventLog.record(info, payloadFromObject(info.payload), {
      orgId: resolvedOrgId,
      source: deps.eventLogSource ?? EventLogSource.enum.direct,
      status: EventLogStatus.enum.processed,
      matchedCount,
      repoIdentifier,
      ref,
      runId: firstRunId,
    });
  }

  logger.info('Webhook processed', {
    deliveryId: info.deliveryId,
    event: info.event,
    matchedWorkflows: matchedCount,
    totalWorkflows: decisions.length,
  });
}

// ---------------------------------------------------------------------------
// Public entry point — narrative orchestrator
// ---------------------------------------------------------------------------

/**
 * Process a webhook through the complete pipeline.
 *
 * Flow:
 *   1. Dedup + provider lookup -> contributor cache invalidation -> normalize
 *   2. Cross-source dispatch (generic webhook fan-out, optional)
 *   3. Extract repo + credentials, handle /kici approval comments
 *   4. Trust resolution for PR events
 *   5. Lock file fetch (with multi-provider fallback)
 *      - No lock file: dispatch global workflows for this event (same org) and return
 *   6. Workflow modification detection + security hold check status
 *   7. Default-branch registration
 *   8. Match triggers + dispatch matched same-source workflows
 *   9. Match + dispatch global workflows for OTHER repos
 *  10. Forward Platform trace + record event log
 */
export async function processWebhook(info: WebhookInfo, deps: ProcessingDeps): Promise<void> {
  const provider = await dedupAndResolveProvider(info, deps);
  if (provider.status === 'skip') return;
  const { resolvedOrgId, bundle } = provider;

  invalidateContributorCacheForEvent(info, deps, bundle);

  const event = await normalizeWebhookEvent(info, deps, bundle, resolvedOrgId);
  if (!event) return;

  if (info.provider === 'generic' && deps.registrationIndex) {
    const cs = await dispatchCrossSourceWorkflows(info, deps, event, resolvedOrgId);
    if (cs.handled) return;
  }

  const repoCreds = await extractRepoAndCredentials(info, deps, bundle, resolvedOrgId);
  if (!repoCreds) return;
  const { repoIdentifier, credentials } = repoCreds;
  const payload = info.payload as Record<string, unknown>;

  await handleApprovalCommentIfPresent({
    info,
    deps,
    bundle,
    event,
    payload,
    resolvedOrgId,
    repoIdentifier,
    credentials,
  });

  const ref = bundle.normalizer.extractRef(info.event, payload);
  const isPREvent = isPullRequestEvent(info.event);

  const trust = await resolveTrustForPR({
    info,
    deps,
    bundle,
    event,
    payload,
    resolvedOrgId,
    repoIdentifier,
    credentials,
  });

  const lockOutcome = await fetchLockFileWithFallbackPhase({
    info,
    deps,
    bundle,
    event,
    resolvedOrgId,
    repoIdentifier,
    credentials,
    ref,
    isPREvent,
    lockFileSource: trust.lockFileSource,
  });

  if (lockOutcome.corrupt) {
    const corruptRunId = randomUUID();
    const message =
      lockOutcome.corruptError?.message ?? `Lock file for ${repoIdentifier} could not be parsed`;
    logger.warn('Lock file present but unparseable — recording lock_resolution init failure', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      ref,
    });
    if (deps.executionTracker) {
      await deps.executionTracker.recordInitFailureRun({
        runId: corruptRunId,
        workflowName: '(unresolved workflow)',
        provider: info.provider,
        repoIdentifier,
        ref: event.sourceBranch ?? event.targetBranch ?? ref,
        // The real commit SHA is unknown when the lock file can't be read; reuse
        // the resolved ref as the best available locator for the failed run.
        sha: ref,
        deliveryId: info.deliveryId ?? null,
        providerContext: (credentials ?? {}) as Record<string, unknown>,
        routingKey: info.routingKey,
        initFailure: {
          scope: 'run',
          category: InitFailureCategory.enum.lock_resolution,
          message,
        },
        triggerEvent: buildTriggerEvent(event.type, event.action),
        commitMessage: extractCommitMessage(info.event, payload),
      });
    }
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    if (deps.eventLog) {
      await deps.eventLog.record(info, payloadFromObject(info.payload), {
        orgId: resolvedOrgId,
        source: deps.eventLogSource ?? EventLogSource.enum.direct,
        status: EventLogStatus.enum.lockfile_corrupt,
        matchedCount: 0,
        repoIdentifier,
        ref,
      });
    }
    return;
  }

  if (!lockOutcome.lockFile) {
    logger.debug('No lock file found for per-repo matching, checking global workflows', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      ref,
      lockFileSource: trust.lockFileSource,
    });
    const globalMatched = await tryDispatchGlobalsWithoutLockFile({
      info,
      deps,
      event,
      resolvedOrgId,
      repoIdentifier,
      ref,
      dispatchBundle: lockOutcome.dispatchBundle,
      dispatchCredentials: lockOutcome.dispatchCredentials,
    });
    webhooksProcessedTotal.add(1, { result: globalMatched > 0 ? 'dispatched' : 'skipped' });
    if (deps.eventLog) {
      await deps.eventLog.record(info, payloadFromObject(info.payload), {
        orgId: resolvedOrgId,
        source: deps.eventLogSource ?? EventLogSource.enum.direct,
        status: EventLogStatus.enum.lockfile_missing,
        matchedCount: globalMatched,
        repoIdentifier,
        ref,
      });
    }
    return;
  }

  const fullLockFile = lockOutcome.lockFile as unknown as FullLockFile;

  applyWorkflowModificationsAndSecurityHold({
    info,
    bundle,
    event,
    fullLockFile,
    headLockFileForDiff: lockOutcome.headLockFileForDiff,
    isPREvent,
    lockFileSource: trust.lockFileSource,
    trustResolution: trust.trustResolution,
    repoIdentifier,
    ref,
    credentials,
  });

  await registerWorkflowsOnDefaultBranchPush({
    info,
    deps,
    bundle,
    event,
    payload,
    resolvedOrgId,
    repoIdentifier,
    ref,
    credentials,
    fullLockFile,
  });

  const { eventWithFiles, decisions } = await gatherChangedFilesAndMatchTriggers({
    info,
    payload,
    event,
    fullLockFile,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
    repoIdentifier,
  });

  const sameSource = await dispatchMatchedSameSourceWorkflows({
    info,
    deps,
    payload,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
    event,
    eventWithFiles,
    ref,
    fullLockFile,
    resolvedOrgId,
    decisions,
    trustResolution: trust.trustResolution,
    lockFileSource: trust.lockFileSource,
    repoIdentifier,
    resolvedFallbackRoutingKey: lockOutcome.resolvedFallbackRoutingKey,
    resolvedFallbackBundle: lockOutcome.resolvedFallbackBundle,
  });

  const globals = await dispatchGlobalWorkflowsForOtherRepos({
    info,
    deps,
    eventWithFiles,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
  });

  await forwardTracesAndRecordEventLog({
    info,
    deps,
    payload,
    decisions,
    matchedCount: sameSource.matchedCount + globals.matchedCount,
    matchedRunIds: [...sameSource.matchedRunIds, ...globals.matchedRunIds],
    resolvedOrgId,
    repoIdentifier,
    ref,
  });
}
