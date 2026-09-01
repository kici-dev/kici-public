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
import { z } from 'zod';
import {
  createLogger,
  enrichRequestContext,
  getRequestContext,
  toErrorMessage,
} from '@kici-dev/shared';
import type {
  LockFile as FullLockFile,
  LockJob,
  LockWorkflow,
  MaterializedJob,
  SimulatedEvent,
  LockFileParseError,
  ChangedFilesResult,
  LockContentRequirement,
  WorkflowDecision,
  FileContentsFetcher,
} from '@kici-dev/engine';
import {
  EventLogStatus,
  EventLogSource,
  ExecutionJobStatus,
  InitFailureCategory,
} from '@kici-dev/engine';
import type { OrchestratorMode } from '@kici-dev/engine';
import { isLockStaticJob } from '@kici-dev/engine';
import { materializeFanout, matrixEnvelopeFields, partitionMatchers } from '@kici-dev/engine';
import { matchAllWorkflows, matchWorkflowsForEvent, TraceCheck } from '@kici-dev/engine';
import {
  appendChecks,
  createDispatchFailureTraceEntry,
  createContentRequirementsTraceEntry,
  createGlobalFilterTraceEntry,
} from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import { ProviderRegistry } from '../provider-registry.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { resolveRefTrust, type TrustResolution } from '../security/trust-resolver.js';
import {
  evaluateTrustPolicy,
  resolveEffectivePolicy,
  trustPolicyOutcomeReason,
  READ_FAILURE_POLICY,
  type TrustPolicyOutcome,
} from '../security/trust-policy-gate.js';
import type { StoredTrustPolicy } from '../security/trust-policy-store.js';
import { selectLockFileSource } from '../security/lock-source.js';
import {
  detectWorkflowModifications,
  type WorkflowModification,
} from '../security/workflow-diff.js';
import { parseKiciCommand, handleApprovalComment } from '../security/comment-handler.js';
import type { IdentityLink, PermissionLevel } from '../security/identity-link.js';
import { extractRegisterableWorkflows, extractGlobalWorkflows } from '../registration/extractor.js';
import { payloadFromObject } from '../webhook/event-log.js';
import {
  webhooksReceivedTotal,
  webhooksProcessedTotal,
  triggerMatchDurationSeconds,
  dedupHitsTotal,
  crossSourceFanoutSize,
  crossSourceErrorsTotal,
  trustPolicyDecisionsTotal,
  forkEventsIgnoredTotal,
} from '../metrics/prometheus.js';
import { storeWebhookPayload } from './webhook-payload-store.js';
import {
  dispatchMatchedWorkflow,
  catchUpNeedsGatedJobs,
  NEEDS_PENDING_JOB_ID_PREFIX,
} from './dispatch-matched-workflow.js';
import { resumeWorkflow, rejectWorkflow } from './resume-workflow.js';
import { insertEdgesForRun } from './needs-scheduler.js';
import { invokeParamsFromLockJob, isInvokeGate } from './invoke-gate.js';
import { JobKind } from '../db/types.js';
import { filterByContentRequirements } from './content-filter.js';
import {
  candidateKey,
  partitionCandidates,
  recordUnrunCandidates,
  runGlobalEvalRounds,
  truncateReasonText,
  ROUND_JOB_PREFIX,
  type GlobalEvalCandidate,
  type GlobalEvalDispatcher,
  type GlobalEvalRoundFailure,
} from './global-eval-round.js';
import {
  resolveOrgId,
  resolveLockFileWithFallback,
  eventTypeToTriggerType,
  extractInboundRepoIdentifier,
  isDefaultBranchPush,
  extractDefaultBranch,
  anyTriggerHasPathPatterns,
  summarizeDecision,
  capDecisionSummaries,
  buildTriggerEvent,
  extractCommitMessage,
  dispatchReadyJob,
  isRootJob,
  storePendingJobContext,
  type ProcessingDeps,
} from './processor.js';
import {
  registerDispatchedJobs,
  type DispatchedJobEntry,
  type RejectedJobEntry,
} from './route-or-dispatch-jobs.js';

const logger = createLogger({ prefix: 'pipeline' });

// ---------------------------------------------------------------------------
// Tier-1 content-requirements filter (declarative `requires` static filter)
// ---------------------------------------------------------------------------

/**
 * Build the per-delivery file-contents fetcher for the dispatch bundle. Prefers
 * a prebuilt fetcher; otherwise constructs one from the delivery credentials
 * (e.g. a GitHub installation id). `undefined` when the provider has none.
 */
function resolveFileContentsFetcher(
  bundle: ProviderBundle,
  credentials: Record<string, unknown>,
): FileContentsFetcher | undefined {
  return bundle.fileContentsFetcher ?? bundle.fileContentsFetcherFactory?.(credentials);
}

/**
 * The `requires` of the trigger that matched this decision, if any. Only the
 * push/pr/tag triggers carry `requires`; every other trigger contributes none.
 */
function extractMatchedRequires(
  workflow: LockWorkflow,
  matchedTrigger: number | undefined,
): readonly LockContentRequirement[] {
  if (matchedTrigger === undefined) return [];
  const trigger = workflow.triggers[matchedTrigger];
  if (trigger && (trigger._type === 'push' || trigger._type === 'pr' || trigger._type === 'tag')) {
    return trigger.requires ?? [];
  }
  return [];
}

/**
 * Tier-1 content filter over a lock file's own matched workflows. Returns the
 * decisions with any content-dropped workflow flipped to `matched: false` so the
 * downstream dispatch + event-log naturally skip it. A workflow whose matched
 * trigger carries no `requires` is untouched (the fast path — no fetch).
 */
async function applyContentFilterToDecisions(args: {
  deps: ProcessingDeps;
  decisions: WorkflowDecision[];
  fullLockFile: FullLockFile;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  repoIdentifier: string;
  ref: string;
  deliveryId: string;
}): Promise<WorkflowDecision[]> {
  const {
    deps,
    decisions,
    fullLockFile,
    dispatchBundle,
    dispatchCredentials,
    repoIdentifier,
    ref,
  } = args;

  const candidates = decisions
    .filter((d) => d.matched)
    .map((d) => {
      const workflow = fullLockFile.workflows.find((w) => w.name === d.workflowName);
      return {
        name: d.workflowName,
        requires: workflow ? extractMatchedRequires(workflow, d.matchedTrigger) : [],
      };
    });

  // Fast path: no matched workflow declares `requires` — nothing to fetch/filter.
  if (!candidates.some((c) => c.requires.length > 0)) return decisions;

  const { dropped } = await filterByContentRequirements(
    candidates,
    { repo: repoIdentifier, sha: ref },
    {
      fetcher: resolveFileContentsFetcher(dispatchBundle, dispatchCredentials),
      cache: deps.contentRequirementsCache,
      deliveryId: args.deliveryId,
    },
  );
  if (dropped.length === 0) return decisions;

  const droppedNames = new Set(dropped.map((d) => d.name));
  return decisions.map((d) =>
    droppedNames.has(d.workflowName)
      ? { ...d, matched: false, summary: 'Dropped by content requirements (requires)' }
      : d,
  );
}

/**
 * Tier-1 content filter for a single matched global-workflow registration whose
 * lock entry lives in another repo. The `requires` query reads the source
 * event's repo files at its ref, so global candidates share the same cache as
 * the per-repo path.
 *
 * Returns the decision with the gate's verdict appended to its trace: a
 * surviving candidate stays `matched`, a dropped one is demoted with the
 * filter's own reason. Returning the decision rather than a boolean is what
 * lets the caller say WHY a workflow produced nothing.
 *
 * The drop's `indeterminate` flag is carried into the entry, so an unreadable
 * file or a provider with no file-contents fetcher traces as "nothing evaluated
 * this" rather than as an exclusion the author's own requirement caused.
 */
async function globalCandidateSurvivesContentFilter(args: {
  deps: ProcessingDeps;
  lockEntry: LockWorkflow;
  decision: WorkflowDecision;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  repoIdentifier: string;
  ref: string;
  deliveryId: string;
}): Promise<WorkflowDecision> {
  const { deps, lockEntry, decision, dispatchBundle, dispatchCredentials, repoIdentifier, ref } =
    args;
  const requires = extractMatchedRequires(lockEntry, decision.matchedTrigger);
  if (requires.length === 0) return decision;

  const { survivors, dropped } = await filterByContentRequirements(
    [{ name: lockEntry.name, requires }],
    { repo: repoIdentifier, sha: ref },
    {
      fetcher: resolveFileContentsFetcher(dispatchBundle, dispatchCredentials),
      cache: deps.contentRequirementsCache,
      deliveryId: args.deliveryId,
    },
  );
  return appendChecks(decision, [
    createContentRequirementsTraceEntry({
      files: requires.map((req) => req.file),
      passed: survivors.length > 0,
      indeterminate: dropped[0]?.indeterminate === true,
      reason: dropped[0]?.reason,
    }),
  ]);
}

/**
 * Outcome of a single inbound-webhook ingestion. `duplicate` lets a direct-
 * ingress route return `{ duplicate: true }` to GitHub's Recent Deliveries
 * panel; `skipped` covers unknown provider / unknown event / no-repo paths;
 * `processed` means the pipeline matched and dispatched (or recorded a run).
 *
 * `queued` means the delivery is durably stored and its pipeline will run after
 * the response — the direct-ingress accept path's success outcome. It maps to
 * the same 202 `processed` always did, because from the sender's side both mean
 * "accepted, nothing more to do"; the distinction exists so the accept path can
 * be asserted on directly rather than through the HTTP status.
 */
export const WebhookIngestOutcome = z.enum(['processed', 'queued', 'duplicate', 'skipped', 'shed']);
export type WebhookIngestOutcome = z.infer<typeof WebhookIngestOutcome>;

/**
 * Annotation written to a `processed` event-log row when path filters were
 * evaluated against an unavailable changed-files diff (conservative match).
 * Reuses the existing free-text field so the outcome is never a silent
 * `processed / matched 0` — no new event-log status enum value is added.
 */
const DEGRADED_CHANGED_FILES_REASON =
  'trigger evaluation degraded: changed files unavailable — path filters matched conservatively';

/** Map a dedup/provider skip reason onto the ingest outcome a route reports. */
function skipReasonToOutcome(reason: 'duplicate' | 'unknown-provider'): WebhookIngestOutcome {
  return reason === 'duplicate'
    ? WebhookIngestOutcome.enum.duplicate
    : WebhookIngestOutcome.enum.skipped;
}

// ---------------------------------------------------------------------------
// Phase A — dedup + provider + normalize
// ---------------------------------------------------------------------------

/**
 * Resolve customer/org id for the inbound routing key with a default fallback.
 * The DB lookup may fail (table missing in dev/test); we tolerate that and
 * default to `'__default__'` so the pre-tenant code paths still work.
 *
 * The failure is logged rather than swallowed. `'__default__'` is the plane's
 * no-tenant anchor, so a downgrade to it is not neutral: it denies every
 * org-scoped decision downstream (global-workflow registration, the
 * multi-provider lock fallback) with a reason that reads as "the org has not
 * opted in" rather than "the org lookup failed". A silent catch makes a
 * transient DB fault indistinguishable from a deliberately unmapped source.
 */
async function resolveOrgIdSafe(deps: ProcessingDeps, routingKey: string): Promise<string> {
  if (!deps.db) return '__default__';
  try {
    return await resolveOrgId(deps.db, routingKey);
  } catch (err) {
    logger.warn('Org lookup failed; falling back to the __default__ org anchor', {
      routingKey,
      error: toErrorMessage(err),
    });
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

type DedupAndProviderResult =
  DedupAndProviderContinue | { status: 'skip'; reason: 'duplicate' | 'unknown-provider' };

/**
 * Resolve the provider bundle for a delivery, refreshing the registry from
 * server truth first when the source's own bundle is missing.
 *
 * The registry is an in-memory CACHE of `generic_webhook_sources`, filled by
 * three independent paths (startup enumeration, the admin write handler, the
 * LISTEN/NOTIFY drain). A delivery can arrive at a moment when none of them
 * has run for its source, and the miss is silent rather than loud: for a
 * `generic:` key `getByRoutingKey` yields the shared `generic:default`
 * bundle, whose normalizer reports "this payload carries no repository" for
 * EVERY payload. The pipeline then drops the delivery at its no-repo exit,
 * so a customer's webhook is answered 202, matched against nothing, and
 * recorded only as `received` with `matched_count = 0`.
 *
 * The database is the authority, so consult it before believing the cache.
 * Bounded: only on an exact miss, only for a generic key, and only when a
 * refresh seam is wired.
 */
async function resolveBundleWithRefresh(
  info: WebhookInfo,
  deps: ProcessingDeps,
): Promise<ProviderBundle | undefined> {
  const needsRefresh =
    deps.ensureProviderBundle !== undefined &&
    ProviderRegistry.isGenericRoutingKey(info.routingKey) &&
    !deps.providerRegistry.hasExact(info.routingKey);
  if (!needsRefresh) return deps.providerRegistry.getByRoutingKey(info.routingKey);

  // `false` is the ordinary steady state for a plain generic source, which
  // legitimately has no per-routing-key bundle and is meant to use the default
  // one — so only an actual repair is worth a line.
  const registered = await deps.ensureProviderBundle!(info.routingKey);
  if (registered) {
    logger.warn('Registered a missing provider bundle from the source row before matching', {
      deliveryId: info.deliveryId,
      routingKey: info.routingKey,
      event: info.event,
    });
  }
  return deps.providerRegistry.getByRoutingKey(info.routingKey);
}

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

  // Atomic claim: true => we own this delivery, false => duplicate. This is the
  // single dedup chokepoint shared by the relay, generic, and direct GitHub
  // ingestion paths — it replaces the historic exists()-then-mark() race (see
  // DedupCache.claim).
  const claimed = await deps.dedup.claim(info.deliveryId);
  if (!claimed) {
    logger.debug('Duplicate webhook, skipping', { deliveryId: info.deliveryId });
    dedupHitsTotal.add(1);
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.duplicate);
    return { status: 'skip', reason: 'duplicate' };
  }
  webhooksReceivedTotal.add(1, { source: 'pipeline', event: info.event });

  const bundle = await resolveBundleWithRefresh(info, deps);
  if (!bundle) {
    logger.warn('Unknown provider, skipping', {
      deliveryId: info.deliveryId,
      provider: info.provider,
      routingKey: info.routingKey,
      registeredRoutingKeys: deps.providerRegistry.getRoutingKeys(),
    });
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
    return { status: 'skip', reason: 'unknown-provider' };
  }

  return { status: 'continue', resolvedOrgId, bundle };
}

/**
 * Phase A.2 — Normalise the inbound event via the provider's normalizer.
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
  if (!(await deps.dedup.claim(crossDedupKey))) {
    logger.debug('Cross-source dispatch: composite dedup hit', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
    });
    return 0;
  }

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

  // Cross-source is a dispatch path, so it consults the policy through the same
  // evaluator as every other path rather than asserting a verdict of its own.
  // Today an inbound generic webhook normalizes to a non-PR event and the
  // evaluator short-circuits to `pass`; routing it through the evaluator anyway
  // is what stops that from silently becoming a bypass if a registration's
  // normalizer ever yields a PR-shaped event.
  //
  // Note what this path does NOT establish. It resolves no trust, so the
  // evaluator sees no tier — and a missing tier is not itself a denial: the
  // switch turns on `isForkPR`, so an event this path reports as non-fork
  // passes whatever the policy says. A registration whose normalizer starts
  // emitting PR-shaped events therefore needs a fork signal it can stand
  // behind, not just a trip through the evaluator.
  const crossSourceSecurityDecision = await evaluateSecurityPolicy({
    deps,
    bundle: regBundle,
    isPREvent: isPullRequestEvent(syntheticEvent.type),
    resolvedOrgId,
    mode: deps.orchestratorMode ?? 'platform',
    trustResolution: undefined,
    isForkPR: syntheticEvent.isForkPR ?? false,
  });

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
    // disabled inside dispatchMatchedWorkflow via the `crossSource` flag:
    // bundles externalize @kici-dev/sdk and an eval job in a fresh temp dir
    // cannot resolve the package.
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
      // A cross-source dispatch runs a registration's own workflow against its
      // own repository — the inbound generic event supplies the trigger, not a
      // second repository — so the defining repository IS `repoIdentifier`.
      workflowRepoIdentifier: reg.repoIdentifier,
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
      securityDecision: crossSourceSecurityDecision,
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
        // post-clone SHA verification + fetch-deepen path.
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
    // Names the normalizer that answered, because the two reasons a delivery
    // lands here are indistinguishable otherwise: a plain generic source has
    // no repository by design, while a repo-bearing source resolved to the
    // wrong bundle carries one the normalizer simply cannot read. Both drop
    // the delivery; only the second is a fault, and it is invisible at `info`
    // unless the line says which normalizer decided.
    logger.info('Missing repository info in payload, skipping', {
      deliveryId: info.deliveryId,
      routingKey: info.routingKey,
      deliveryProvider: info.provider,
      normalizerProvider: bundle.normalizer.provider,
    });
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
    return null;
  }
  const credentials = bundle.normalizer.extractCredentials(info.payload);
  return { repoIdentifier, credentials };
}

/**
 * Resolve the directory a `/kici approve` comment is authorized against.
 *
 * Two sources, and which one applies is decided by the caller that assembled
 * these deps rather than by the orchestrator's mode:
 *
 * - `server.ts` holds the Platform-pushed directory in memory and refreshes it
 *   on every `trust_policy.update`, so it always supplies both fields. An
 *   in-memory directory therefore wins outright — reading the row instead
 *   would answer from a cache the push has already superseded.
 * - Every other assembly supplies neither. That includes the direct-ingress
 *   pipeline in `app.ts`, which is the only path an independent orchestrator
 *   has, and where the operator's own `kici-admin trust-policy directory-set`
 *   registrations live only in the row. Reading it per command is also what
 *   makes a registration take effect immediately rather than at the next
 *   restart.
 *
 * A failed read degrades to an empty directory: the commenter is not resolved
 * and the command is refused, which is the same fail-closed answer an absent
 * directory already gives.
 */
export async function resolveApprovalDirectory(
  deps: ProcessingDeps,
  orgId: string,
): Promise<{ identityLinks: IdentityLink[]; orgMemberPermissions: Map<string, PermissionLevel> }> {
  if (deps.identityLinks !== undefined || deps.orgMemberPermissions !== undefined) {
    return {
      identityLinks: deps.identityLinks ?? [],
      orgMemberPermissions: deps.orgMemberPermissions ?? new Map(),
    };
  }
  if (!deps.trustDirectoryStore) {
    return { identityLinks: [], orgMemberPermissions: new Map() };
  }
  try {
    const stored = await deps.trustDirectoryStore.load(orgId);
    if (!stored) return { identityLinks: [], orgMemberPermissions: new Map() };
    return {
      identityLinks: stored.identityLinks,
      orgMemberPermissions: new Map(Object.entries(stored.memberCiTrustLevels)),
    };
  } catch (err) {
    logger.warn('Failed to read the approval directory; refusing this /kici command', {
      orgId,
      error: toErrorMessage(err),
    });
    return { identityLinks: [], orgMemberPermissions: new Map() };
  }
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
  event: SimulatedEvent;
  payload: Record<string, unknown>;
  resolvedOrgId: string;
  repoIdentifier: string;
}): Promise<void> {
  const { info, deps, event, payload, resolvedOrgId, repoIdentifier } = args;
  if (info.event !== 'issue_comment' || !deps.heldRunStore) return;

  const commentBody = (payload.comment as { body?: string } | undefined)?.body;
  const senderUsername = event.senderUsername;
  const prNumber = (payload.issue as { number?: number } | undefined)?.number;
  const prHead = (payload.issue as { pull_request?: { url?: string } } | undefined)?.pull_request;

  if (!commentBody || !senderUsername || !prNumber || !prHead) return;
  const command = parseKiciCommand(commentBody);
  if (!command) return;

  const { identityLinks, orgMemberPermissions } = await resolveApprovalDirectory(
    deps,
    resolvedOrgId,
  );

  const result = await handleApprovalComment({
    commentBody,
    commenterUsername: senderUsername,
    commenterUserId: event.senderUserId,
    provider: info.provider,
    repoIdentifier,
    prNumber,
    orgId: resolvedOrgId,
    identityLinks,
    orgMemberPermissions,
    heldRunStore: deps.heldRunStore,
    db: deps.db,
    // Each ended hold's check is completed on the commit ITS OWN run acted on,
    // through the bundle serving that run's routing key — not on the PR head at
    // comment time, and not through the bundle that delivered the comment.
    resolvePoster: (routingKey) =>
      deps.providerRegistry.getByRoutingKey(routingKey)?.checkStatusPoster,
    // Approving a security hold RUNS the gated work. Without this the row was
    // flipped and a green check posted while nothing dispatched.
    onJobRelease: async (signal) => {
      await dispatchReadyJob(
        signal.runId,
        signal.jobId,
        deps.dispatcher,
        deps.executionTracker,
        deps.coordinator,
        deps.db,
        deps.invokeGateDeps,
        // Approving the hold releases the gate, not a concurrency slot, so the
        // group's limit is re-checked before the job dispatches.
        deps.contextStore && deps.heldRunStore
          ? {
              matchContext: (o, n) => deps.contextStore!.matchContext(o, n),
              heldRunStore: deps.heldRunStore,
              accessLogWriter: deps.accessLogWriter,
              routingKey: info.routingKey ?? null,
            }
          : undefined,
      );
    },
    // The org trust policy's PR-wide hold is workflow-scoped: it fires before
    // any job exists, so approval replays the stored dispatch instead of
    // re-dispatching a job, and rejection cancels the run and drops that
    // context.
    onWorkflowRelease: (signal) => resumeWorkflow(signal, deps, deps.db),
    onWorkflowReject: (hold, reason) => rejectWorkflow(hold, deps, deps.db, reason),
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

/** Whether an inbound event name is one of the pull-request events. */
export function isPullRequestEvent(eventName: string): boolean {
  return (
    eventName === 'pull_request' ||
    eventName === 'pull_request_review' ||
    eventName === 'pull_request_review_comment'
  );
}

/**
 * Phase D — Resolve the trust tier for the inbound event from the git ref
 * alone. Every ref that lives in the base repo is trusted: only a
 * write-or-higher contributor can put one there. A fork head ref is the sole
 * untrusted case, and it resolves to `unknown`.
 *
 * For PR events the tier drives lock-file-source selection (a trusted ref gets
 * the head lock file; a fork ref gets base) and the user-cache write scope,
 * which `deriveCacheRefScope` maps from `trusted` to the org-shared scope and
 * from everything else to a per-run isolated scope.
 *
 * A PR event resolves a tier only for a provider that sets `hasForkModel`
 * (GitHub), whose fork signal comes from the forge's own payload. universal-git
 * reports an `isForkPR` too, but it compares two repo names read from fixed
 * payload keys — `repo.full_name`, falling back to `full_name`, under each of
 * `head` and `base` — that many forges' PR payloads do not carry, and yields
 * `false` whenever either is absent. It fails toward trust, so it cannot carry
 * HEAD-lock selection. Such a PR resolves
 * no tier, which `selectLockFileSource` maps to the base lock and
 * `deriveCacheRefScope` maps to the isolated cache scope.
 */
/** Build a `trusted`-tier TrustResolution with a fixed audit reason. */
function makeTrustedResolution(contributorUsername: string, reason: string): TrustResolution {
  return {
    tier: 'trusted',
    contributorUsername,
    reason,
  };
}

export async function resolveTrustForPR(args: {
  info: WebhookInfo;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  /** Raw webhook payload — read only to decide whether a push targets the default branch. */
  payload: Record<string, unknown>;
}): Promise<TrustOutcome> {
  const { info, bundle, event, payload } = args;
  const isPREvent = isPullRequestEvent(info.event);

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

  // A non-PR event from a provider with no fork model (generic sources, where
  // the verification secret is the trust boundary; local sources, where the
  // operator owns the on-disk repo — neither has a fork concept) is trusted by
  // construction.
  if (!isPREvent && !bundle.hasForkModel) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Non-PR event from a fork-less provider (generic/local) -- trusted ref',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // Any other non-PR event (branch push, tag push) is a same-repo ref:
  // only a write-or-higher contributor can create it. Trusted by
  // construction — same argument as the default-branch push above.
  if (!isPREvent) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Non-default-branch push — same-repo ref, trusted by construction',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // A PR from a provider with no fork model resolves no tier: its `isForkPR`
  // compares two repo names read from fixed payload keys that many forges' PR
  // payloads do not carry, and reads `false` when either is absent — it fails
  // toward trust, so it cannot carry HEAD-lock selection.
  if (!bundle.hasForkModel) {
    return {
      trustResolution: undefined,
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  const trustResolution = resolveRefTrust({
    isForkPR: event.isForkPR ?? false,
    contributorUsername: event.senderUsername ?? '',
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
 * One materialized global-workflow job ready to dispatch: its expanded name, the
 * lock job it came from (needed to classify the job as an invoke gate / root /
 * needs-gated), and the built queue input.
 */
interface GlobalJobInput {
  lockJobName: string;
  lockJob: LockJob;
  input: QueuedJobInput;
}

/**
 * The materialized job inputs plus the fan-out artefacts the needs scheduler
 * needs: the expanded `MaterializedJob` set and the base→children expansion map,
 * both fed to `insertEdgesForRun` so a global run's `needs` edges are wired the
 * same way a per-repository run's are.
 */
interface GlobalJobInputsResult {
  inputs: GlobalJobInput[];
  materialized: MaterializedJob[];
  expansionMap: Map<string, string[]>;
}

/**
 * Build the per-job QueuedJobInput for a global workflow dispatched from the
 * inbound webhook. Shared by the lock-file-missing branch (Phase F) and the
 * post-per-repo dispatch branch (Phase J) — both paths build the same inputs
 * from the same registration shape.
 *
 * The caller supplies `jobs`. A candidate that needs no eval round passes its
 * lock file's static entries; a candidate the round decided on passes those
 * plus the jobs its generators produced. Nothing here filters the list, so a
 * `DynamicJobFn` entry can no longer be dropped on the floor by this function.
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
  /**
   * Resolves the WORKFLOW repo's own provider bundle. Required rather than
   * optional: omitting it would leave every dispatched global job with no
   * workflow clone URL at all, which fails at the agent's checkout.
   */
  providerRegistry: ProviderRegistry;
  /** The exact job set to dispatch, already resolved by the caller. */
  jobs: readonly LockJob[];
}): GlobalJobInputsResult {
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
  // The WORKFLOW repo's clone URL comes from the bundle that owns the
  // workflow's routing key, not from the inbound event's. A local-source event
  // triggering a GitHub-authored global otherwise asks the file:// builder for a
  // GitHub repo and produces an unclonable URL. Same resolution the cross-source
  // path uses ("registration's bundle, NOT inbound generic") and the same one
  // `workflowRoutingKey` below already relies on for auth.
  const regBundle = args.providerRegistry.getByRoutingKey(reg.routingKey);
  const workflowRepoUrl = regBundle?.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '';
  const inputs: GlobalJobInput[] = [];
  const fanout = materializeFanout(args.jobs);
  const materialized = fanout.jobs;
  // An approval gate is applied by the per-repository dispatch path only; this
  // one never consults it. `kici compile` refuses `approval` on a global
  // workflow, so a static job cannot reach here carrying one — but a job a
  // GENERATOR produced is built on the agent and never passes through the
  // compiler, so this is the only place it can be seen at all. Loud, because
  // the author is relying on a control that is not going to run.
  const ungated = [
    ...(globalWorkflow.approval ? [`workflow "${globalWorkflow.name}"`] : []),
    ...args.jobs.filter((job) => job.approval).map((job) => `job "${job.name}"`),
  ];
  if (ungated.length > 0) {
    logger.error(
      'Approval gate ignored on an organization-wide workflow — it is not enforced on ' +
        'this dispatch path; move the gated jobs to a per-repository workflow',
      {
        deliveryId: info.deliveryId,
        workflow: globalWorkflow.name,
        workflowRepo: reg.repoIdentifier,
        sourceRepo: repoIdentifier,
        ungated,
      },
    );
  }

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
      // The normalized event envelope, exactly as the per-repository dispatch
      // path writes it. The agent reads it back as `ctx.event` and as the
      // argument to `concurrency.group(...)`; without it an organization-wide
      // workflow saw an empty object where the SDK type promises a payload, and
      // could not scope a concurrency group by the repository the event came
      // from. Already carries `sourceRepo` — every caller stamps it through
      // `withSourceRepo` before matching.
      event,
      isGlobalWorkflow: true,
      workflowRepoUrl,
      workflowRef: '',
      workflowSha: reg.commitSha ?? '',
      workflowRepoIdentifier: reg.repoIdentifier,
      // Cross-provider auth plumbing: when the
      // registration's routing key differs from the inbound, the dispatcher
      // resolves the workflow-repo bundle by this key and mints `workflowAuth`
      // independently from `sourceAuth`.
      workflowRoutingKey: reg.routingKey,
      workflowProviderContext: reg.providerContext,
    };
    inputs.push({
      lockJobName: mat.expandedName,
      lockJob,
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
  return { inputs, materialized, expansionMap: fanout.expansionMap };
}

/**
 * Fallbacks for the eval-round budgets, used only when a hand-built deps object
 * carries none. The cluster defaults live in `config.ts` and reach this module
 * through `ProcessingDeps`; the live per-cluster overrides are read inside the
 * round itself, once per round.
 */
const FALLBACK_GLOBAL_EVAL_ROUND_TIMEOUT_MS = 120_000;
const FALLBACK_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS = 20_000;
const FALLBACK_GLOBAL_EVAL_WAIT_TIMEOUT_MS = 240_000;

/** The lock file's own static entries for a global workflow. */
function staticJobsOf(lockEntry: LockWorkflow): LockJob[] {
  return lockEntry.jobs.filter(isLockStaticJob);
}

/**
 * Adapt the real dispatcher onto the round's narrower surface.
 *
 * `DispatchResult` carries no `jobId` on its `rejected` variant, so the two
 * types are not structurally assignable. The round refuses every status outside
 * its accepted set before it reads the id, so the placeholder below only ever
 * reaches a code path that has already thrown.
 */
function toRoundDispatcher(dispatcher: ProcessingDeps['dispatcher']): GlobalEvalDispatcher {
  return {
    dispatch: async (input) => {
      const result = await dispatcher.dispatch(input);
      return { status: result.status, jobId: 'jobId' in result ? result.jobId : '' };
    },
    // The round abandons its wait on a ceiling breach; without this the queue
    // row survives the abandonment and runs a dual checkout for nobody.
    cancelQueuedJob: (jobId, reason) => dispatcher.cancelQueuedJob(jobId, reason),
  };
}

/**
 * Match this event against every org global workflow authored in ANOTHER repo
 * and return the candidates that survive the org policy and the Tier-1
 * `requires` content filter.
 *
 * Shared by Phase F (no lock file resolved) and Phase J (post-per-repo
 * dispatch): both walk the same registration list and apply the same gates, so
 * a divergence between them would be a silent policy hole on one path only.
 */
/**
 * Stamp the source repository onto the event the organization-wide path works
 * with.
 *
 * `sourceRepo` is the only field naming the repository an event came from, and
 * an organization-wide workflow is by definition evaluated against events from
 * repositories other than its own — so both trigger matching and the dispatched
 * job need it. The lock-file path already stamps it while gathering changed
 * files; the no-lock-file path does not, so stating the invariant here is what
 * keeps the two paths' events identical instead of nearly so.
 *
 * Idempotent, and returns the input unchanged when it already carries the value
 * so a stamped event is not copied twice.
 */
function withSourceRepo(event: SimulatedEvent, repoIdentifier: string): SimulatedEvent {
  return event.sourceRepo === repoIdentifier ? event : { ...event, sourceRepo: repoIdentifier };
}

/**
 * Summarize one organization-wide decision for Platform forwarding, tagged with
 * the repository that defines the workflow.
 *
 * The tag is what separates a global entry from a per-repo one in the delivery's
 * trace: a global workflow is absent from the source repo's lock file, so its
 * name alone tells its author nothing about where it came from.
 */
function summarizeGlobalDecision(
  decision: WorkflowDecision,
  workflowRepoIdentifier: string,
): Record<string, unknown> {
  return { ...summarizeDecision(decision), workflowRepoIdentifier };
}

/** The organization-wide candidates a delivery produced, with their full trace. */
interface GlobalCandidateCollection {
  candidates: GlobalEvalCandidate[];
  /** One summary per global decision evaluated, matched or not. */
  decisionSummaries: Record<string, unknown>[];
  /**
   * Every workflow repository whose registrations this pass actually examined —
   * they cleared the policy and reached trigger matching, whether or not any of
   * them produced a candidate.
   *
   * The universe the pass's positive signal is computed against: a repository
   * the pass never reached (no registration index, a policy denial) is absent
   * here, so it can never be reported as decided.
   */
  consideredWorkflowRepos: string[];
}

async function collectGlobalCandidates(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /**
   * When set, only registrations authored in this repository are considered.
   *
   * The re-run of a failed evaluation round re-drives this pass for exactly the
   * repository whose round failed, so every other repository's globals — which
   * already reached their verdict on the original delivery — must not be
   * evaluated or dispatched a second time.
   */
  onlyWorkflowRepo?: string;
}): Promise<GlobalCandidateCollection> {
  const { info, deps, event, resolvedOrgId, repoIdentifier, ref, dispatchBundle } = args;
  const decisionSummaries: Record<string, unknown>[] = [];
  const consideredWorkflowRepos = new Set<string>();
  const registrationIndex = deps.registrationIndex;
  if (!registrationIndex) return { candidates: [], decisionSummaries, consideredWorkflowRepos: [] };

  const triggerType = eventTypeToTriggerType(info.event);
  const globalRegistrations = registrationIndex.getGlobalByOrgAndTriggerType(
    resolvedOrgId,
    triggerType,
  );

  const candidates: GlobalEvalCandidate[] = [];
  const droppedByRepoFilter: RepoFilterDrop[] = [];
  for (const reg of globalRegistrations) {
    // Skip workflows from the event's own repo (already matched via the
    // lock-file path).
    if (reg.repoIdentifier === repoIdentifier) continue;

    // Scoped pass: a re-run re-evaluates one workflow repository's round, so
    // everything authored elsewhere stays untouched.
    if (args.onlyWorkflowRepo !== undefined && reg.repoIdentifier !== args.onlyWorkflowRepo) {
      continue;
    }

    if (deps.globalWorkflowPolicy) {
      // Policy checks key the org_settings row by `customer_id` — single row
      // per org regardless of how many sources the org has. The two
      // routing-key arguments below are matched against per-entry qualifiers:
      // deny entries match the EVENT's routing key (events are filtered by
      // their own source), allow / elevate entries match the WORKFLOW's
      // routing key (workflows are filtered by where they were authored).
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

    // Past every gate that can suppress the registration without deciding it:
    // from here the pass reaches a real outcome for this repository's workflow,
    // whether it matches, is filtered out, or goes to the round.
    consideredWorkflowRepos.add(reg.repoIdentifier);

    const globalDecisions = matchAllWorkflows(
      [reg.lockEntry],
      withSourceRepo(event, repoIdentifier),
    );

    for (const gDecision of globalDecisions) {
      if (!gDecision.matched) {
        decisionSummaries.push(summarizeGlobalDecision(gDecision, reg.repoIdentifier));
        // A `repos` mismatch is the one exclusion that used to leave no record
        // at all, so a global workflow that never fired for a repo looked
        // exactly like one that was never registered. Collected rather than
        // logged here: a repo-scoped global drops on every delivery from every
        // repo it does not name, so a line per workflow would be the loudest
        // thing in the stream and would drown the signal it exists to carry.
        // Only this drop is collected — every other unmatched trigger (wrong
        // event, wrong branch) is the ordinary case on every delivery.
        const repos = repoFilterRejectionOf(gDecision);
        if (repos !== undefined) {
          droppedByRepoFilter.push({
            workflow: gDecision.workflowName,
            workflowRepo: reg.repoIdentifier,
            repos,
          });
        }
        continue;
      }
      // Tier-1 content filter: drop a matched global whose `requires` does not
      // match (or is indeterminate) against the source event repo at its ref.
      const decision = await globalCandidateSurvivesContentFilter({
        deps,
        lockEntry: reg.lockEntry,
        decision: gDecision,
        dispatchBundle,
        dispatchCredentials: args.dispatchCredentials,
        repoIdentifier,
        ref,
        deliveryId: info.deliveryId,
      });
      if (!decision.matched) {
        logGlobalDecisionTrace(decision, {
          deliveryId: info.deliveryId,
          workflowRepo: reg.repoIdentifier,
          sourceRepo: repoIdentifier,
        });
        decisionSummaries.push(summarizeGlobalDecision(decision, reg.repoIdentifier));
        continue;
      }
      candidates.push({ reg, lockEntry: reg.lockEntry, decision });
    }
  }

  if (droppedByRepoFilter.length > 0) {
    logGlobalReposFilterDrops(droppedByRepoFilter, {
      deliveryId: info.deliveryId,
      sourceRepo: repoIdentifier,
    });
  }
  return { candidates, decisionSummaries, consideredWorkflowRepos: [...consideredWorkflowRepos] };
}

/** One global workflow this delivery dropped because its `repos` filter said no. */
interface RepoFilterDrop {
  workflow: string;
  workflowRepo: string;
  /** The declared include / exclude pattern set, as the trace entry rendered it. */
  repos: string;
}

/**
 * The `repos` pattern set that rejected this workflow, or `undefined` when its
 * triggers were rejected for some other reason.
 *
 * A trigger list is a disjunction, so a workflow that matched nothing may carry
 * a failed repo check beside failures of every other kind. Reading a failed
 * repo entry as "dropped for a repo mismatch" is therefore an approximation —
 * but the caller has already established that nothing matched, so the entry
 * genuinely names one reason the workflow did not run.
 */
function repoFilterRejectionOf(decision: WorkflowDecision): string | undefined {
  const rejected = decision.checks.find(
    (check) => check.check === TraceCheck.RepoFilter && !check.passed,
  );
  return rejected?.pattern;
}

/**
 * Report, once per delivery, every global workflow the event's repo did not
 * match.
 *
 * This is the answer to "the workflow is registered and enabled, so why has it
 * never run for this repo?" — without it that outcome is byte-identical to the
 * workflow never having been registered, which is what made it cost a full
 * staging investigation to diagnose.
 *
 * Aggregated deliberately. An org whose globals declare `repos:
 * ['myorg/service-*']` drops all of them on every delivery from every other
 * repo, which is the steady state rather than an anomaly — so a line per
 * workflow would scale with the org's global count and bury the exclusions that
 * DO warrant per-workflow detail (`requires`, `filter`). One line per delivery
 * keeps the answer in the log at `info`, where an investigation finds it without
 * having to already suspect the cause and re-run at a raised level.
 */
function logGlobalReposFilterDrops(
  dropped: readonly RepoFilterDrop[],
  context: { deliveryId: string; sourceRepo: string },
): void {
  logger.info('Global workflows dropped by their repos filter', {
    ...context,
    droppedCount: dropped.length,
    dropped,
  });
}

/**
 * What an operator has to change to make the registration policy admit.
 *
 * The master switch is fleet-wide (`cluster_settings.global_workflows_enabled`,
 * set with `kici-admin cluster-settings`), so the anchor no longer has its own
 * per-org opt-in. An exclusion under the `'__default__'` anchor now means either
 * the fleet switch is off or the org's allow-list excludes the repo — and,
 * separately, that the routing key mapped to no `sources` /
 * `generic_webhook_sources` / `remote_sources` row carrying a `customer_id`, so
 * `resolveOrgId` fell back to the anchor. That unmapped-source diagnosis stands
 * on its own and is named alongside the fleet-switch remedy, because only the
 * operator knows whether the missing mapping is the real problem on this plane.
 */
function remedyForRegistrationExclusion(orgId: string, routingKey: string): string {
  const enable =
    'enable global workflows cluster-wide ' +
    '(kici-admin cluster-settings set --global-workflows-enabled true)';
  return orgId === '__default__'
    ? `the event resolved to the '__default__' org anchor, so no source maps ` +
        `${routingKey} to an organization: map it ` +
        `(kici-admin source update ${routingKey} --customer-id <org>), and ` +
        `${enable} if it is not already`
    : `${enable}, and allow-list the authoring repo for ${orgId} ` +
        `(kici-admin org-settings global-workflows allow-add <pattern> --org ${orgId})`;
}

/**
 * Report, once per registering push, every global workflow the org policy
 * refused to register — by name.
 *
 * This is the registration-time sibling of {@link logGlobalReposFilterDrops},
 * and it exists for the same reason: without the names, the outcome is
 * byte-identical to "this repo declares no global workflows". A registration
 * that silently loses its globals produces a cross-repo global that never
 * fires, with no registration row, no run, and no decision trace anywhere the
 * operator looks — the exclusion happens on the AUTHORING repo's push, hours or
 * days before the source event whose absence gets investigated.
 *
 * Carries the org it decided against, which the reason string does not: the
 * policy names the repo it denied but never the org whose `org_settings` it
 * read, so a denial under the `'__default__'` anchor reads as "the org has not
 * enabled global workflows" about an org the operator never knew was in play.
 *
 * At `warn` rather than `info`, unlike the repos-filter drop. That one is a
 * steady state — a repo-scoped global drops on every delivery from every repo
 * it does not name — whereas a registering push whose globals are refused is an
 * anomaly: the author committed a global workflow the org will not honour.
 */
function logGlobalRegistrationExclusions(
  excluded: readonly string[],
  context: {
    deliveryId: string;
    workflowRepo: string;
    routingKey: string;
    orgId: string;
    reason: string;
  },
): void {
  logger.warn('Global workflows excluded from registration', {
    ...context,
    excludedCount: excluded.length,
    excluded,
    remedy: remedyForRegistrationExclusion(context.orgId, context.routingKey),
  });
}

/**
 * Emit the full decision trace for a global workflow that produced nothing.
 *
 * A global workflow excluded by `requires` or by `filter` leaves no run row, no
 * check, and no artifact — so without this line its author has nothing at all to
 * inspect and no way to ask why. The trace carries every check that ran,
 * including the trigger checks that passed, so the answer is legible on its own
 * rather than only in contrast with a successful delivery.
 *
 * A `repos` mismatch is reported separately and in aggregate — see
 * {@link logGlobalReposFilterDrops} for why it does not belong here.
 *
 * Emitted alongside the existing per-exclusion lines rather than folded into
 * them: those messages and fields are what the Loki dashboards key off.
 */
function logGlobalDecisionTrace(
  decision: WorkflowDecision,
  context: { deliveryId: string; workflowRepo: string; sourceRepo: string },
): void {
  logger.info('Global workflow decision trace', {
    ...context,
    workflow: decision.workflowName,
    matched: decision.matched,
    summary: decision.summary,
    checks: decision.checks,
  });
}

/** A global candidate cleared for dispatch, with the exact job set to dispatch. */
interface ResolvedGlobalCandidate {
  candidate: GlobalEvalCandidate;
  jobs: readonly LockJob[];
}

/** What the eval round cleared, with the trace of everything it excluded. */
interface ResolvedRoundCandidates {
  resolved: ResolvedGlobalCandidate[];
  /** One summary per candidate the round excluded, carrying its `filter` entry. */
  decisionSummaries: Record<string, unknown>[];
  /**
   * The workflow repository of every round this pass could not decide.
   *
   * Reported rather than derived from the run rows, so a caller re-driving the
   * pass — the re-run of a failed round — can tell a clean re-evaluation from
   * one that failed again without reading the database back.
   */
  roundFailureWorkflowRepos: string[];
  /**
   * The workflow repository of every candidate this pass suppressed WITHOUT a
   * verdict — no pending-eval tracker, a round that reported nothing back, or a
   * verdict that came back indeterminate.
   *
   * A superset of {@link roundFailureWorkflowRepos}: a failed round is one way
   * to reach no verdict, and the fail-closed branches are the others. Only this
   * list can subtract such a repository from the pass's positive signal, which
   * is why the signal is not derived from the failure list.
   */
  unresolvedWorkflowRepos: string[];
}

/**
 * Cap on the check summary a failed round posts.
 *
 * GitHub rejects an `output.summary` over 65535 characters with a 422, and the
 * post is best-effort — so an oversize summary makes the check vanish in
 * exactly the case it exists to report. Both unbounded inputs feed this string:
 * the agent-authored reasons inside `failure.error` (already capped at the
 * round) and the workflow-name list, which grows with the org's global
 * workflows. Capping the finished string is what makes the bound hold whichever
 * one grew.
 */
const MAX_CHECK_SUMMARY_CHARS = 65_000;

/**
 * Human-readable account of a failed round, naming every workflow it
 * suppressed. Shared by the errored run row and the commit check so the two
 * cannot describe the same failure differently.
 */
function failedEvalRoundSummary(failure: GlobalEvalRoundFailure): string {
  const names = failure.workflowNames.map((name) => `\`${name}\``).join(', ');
  // `attempts: 0` is a round the orchestrator refused to dispatch at all, so
  // "failed after 0 attempt(s) … Last error" would describe a job that never
  // existed and send the reader looking for its logs.
  // A partial round decided its other candidates and dispatched them, so
  // "none of them ran" would be false for the repo — the names below are only
  // the ones it could not decide.
  const body = failure.partial
    ? `could not reach a verdict for all of them, so these did not run for this ` +
      `commit: ${names}. Reason: ${failure.error}`
    : failure.attempts === 0
      ? `could not be attempted, so none of them ran for this commit: ${names}. ` +
        `Reason: ${failure.error}`
      : `failed after ${failure.attempts} attempt(s), so none of them ran for this ` +
        `commit: ${names}. Last error: ${failure.error}`;
  return truncateReasonText(
    `Evaluating the organization's global workflows from ` +
      `\`${failure.workflowRepoIdentifier}\` ${body}`,
    MAX_CHECK_SUMMARY_CHARS,
  );
}

/**
 * Record a round that produced no verdicts: one errored run row and one commit
 * check on the source SHA.
 *
 * **One of each per round, not per candidate.** A failed round suppresses every
 * workflow it was deciding on, and the round exists to collapse those N
 * workflows into a single pre-run job — so N run rows and N checks would undo
 * the fan-out reduction the design is for. The single record names all of them
 * instead.
 *
 * Both writes are best-effort. Neither the run row nor the check is worth
 * failing the delivery over: the round already failed, its workflows are already
 * recorded indeterminate, and losing the delivery on top of that would take the
 * `event_log` row with it.
 */
async function surfaceFailedEvalRound(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  repoIdentifier: string;
  ref: string;
  dispatchCredentials: Record<string, unknown>;
  /**
   * The source `dispatchCredentials` belongs to, when a cross-provider
   * lock-file fallback made it a different source from `info.routingKey`.
   */
  dispatchRoutingKey?: string;
  bundle?: ProviderBundle;
  credentials?: Record<string, unknown>;
  failure: GlobalEvalRoundFailure;
}): Promise<void> {
  const { info, deps, repoIdentifier, ref, failure } = args;
  const summary = failedEvalRoundSummary(failure);

  try {
    await deps.executionTracker?.recordGlobalEvalRoundFailureRun({
      runId: failure.runId,
      // The round job's own name, so the run row, its `dispatch_queue` row, and
      // the attempt's logs read as one thing.
      workflowName: `${ROUND_JOB_PREFIX}${failure.workflowRepoIdentifier}`,
      provider: info.provider,
      repoIdentifier,
      // The run row's `ref` is the branch the run PRESENTS, matching what
      // `onExecutionStarted` writes everywhere else and what the context branch
      // gate evaluates. A job's checkout ref (the PR head branch) is a different
      // value and does not belong in this column.
      ref: args.event.targetBranch ?? '',
      sha: ref,
      deliveryId: info.deliveryId,
      providerContext: args.dispatchCredentials,
      routingKey: info.routingKey,
      // Paired with the context above: a re-run re-drives the pass and needs the
      // bundle those credentials actually belong to, which for a cross-provider
      // global is not the source the event arrived on.
      ...(args.dispatchRoutingKey !== undefined && {
        dispatchRoutingKey: args.dispatchRoutingKey,
      }),
      failureReason: summary,
      triggerEvent: info.event,
      // The round exists to decide THIS repository's global workflows, so it is
      // the repository that defines them — without it the failed round records a
      // null marker and reads as an ordinary per-repository run.
      workflowRepoIdentifier: failure.workflowRepoIdentifier,
    });
  } catch (err) {
    logger.warn('Failed to record the errored run for a global eval round', {
      deliveryId: info.deliveryId,
      runId: failure.runId,
      workflowRepo: failure.workflowRepoIdentifier,
      error: toErrorMessage(err),
    });
  }

  // A re-run of this round re-evaluates the original event, so the payload the
  // round was deciding on must survive with the run row. Best-effort like the
  // row and the check: the round already failed.
  await storeWebhookPayload({
    logStorage: deps.logStorage,
    runId: failure.runId,
    payload: info.payload,
  });

  // Posted through the INBOUND event's bundle and credentials: the check lands
  // on the inbound repo, and a cross-provider lock-file fallback swaps the
  // dispatch bundle for another source's, which must not be used to write here.
  try {
    await args.bundle?.checkStatusPoster?.postGlobalEvalFailedCheck?.(
      repoIdentifier,
      ref,
      summary,
      args.credentials ?? {},
    );
  } catch (err) {
    logger.warn('Failed to post the global-eval-failed check', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      workflowRepo: failure.workflowRepoIdentifier,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Run the Tier-2 eval round for every candidate that declares a `filter` or
 * carries a `DynamicJobFn`, and return the survivors with their resolved job
 * sets.
 *
 * A candidate the round did not clear (`run` other than `true`, indeterminate,
 * or a round that failed outright) dispatches nothing: only the agent may run
 * author code, so a verdict we could not obtain is not a verdict to act on.
 *
 * The verdict's `jobs` are handed back by reference — a cache hit returns the
 * stored result as-is — so they are concatenated into a fresh array and never
 * mutated, or the next redelivery would replay the mutation.
 */
async function resolveRoundCandidates(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  candidates: readonly GlobalEvalCandidate[];
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /** The source `dispatchCredentials` belongs to; forwarded to the failure record. */
  dispatchRoutingKey?: string;
  /** The inbound event's own bundle + credentials, used to post the failure check. */
  bundle?: ProviderBundle;
  credentials?: Record<string, unknown>;
}): Promise<ResolvedRoundCandidates> {
  const { info, deps, candidates, repoIdentifier } = args;
  const decisionSummaries: Record<string, unknown>[] = [];
  if (candidates.length === 0)
    return {
      resolved: [],
      decisionSummaries,
      roundFailureWorkflowRepos: [],
      unresolvedWorkflowRepos: [],
    };

  const pendingGlobalEvals = deps.pendingGlobalEvals;
  if (!pendingGlobalEvals) {
    // Fail closed: without the tracker the round can never settle, and
    // dispatching a workflow whose `filter` was never evaluated is exactly the
    // false assurance the round exists to remove.
    logger.warn('Global workflows needing an eval round skipped: no pending-eval tracker', {
      deliveryId: info.deliveryId,
      sourceRepo: repoIdentifier,
      workflows: candidates.map((candidate) => candidate.lockEntry.name),
    });
    // This suppresses every global workflow for the delivery, so it must not be
    // invisible to the round's own metrics — the log line alone is not something
    // an operator can alert on.
    recordUnrunCandidates(candidates.length);
    for (const candidate of candidates) {
      if (!candidate.decision) continue;
      const excluded = appendChecks(candidate.decision, [
        createGlobalFilterTraceEntry({
          run: false,
          indeterminate: true,
          reason: 'the orchestrator could not run an eval round (no pending-eval tracker)',
        }),
      ]);
      logGlobalDecisionTrace(excluded, {
        deliveryId: info.deliveryId,
        workflowRepo: candidate.reg.repoIdentifier,
        sourceRepo: repoIdentifier,
      });
      decisionSummaries.push(summarizeGlobalDecision(excluded, candidate.reg.repoIdentifier));
    }
    return {
      resolved: [],
      decisionSummaries,
      roundFailureWorkflowRepos: [],
      // Every candidate was suppressed without a verdict. Reported so a caller
      // cannot read the empty failure list above as a clean evaluation — this
      // branch is deliberately not a round failure, and it decided nothing.
      unresolvedWorkflowRepos: [...new Set(candidates.map((c) => c.reg.repoIdentifier))],
    };
  }

  const { verdicts, failures } = await runGlobalEvalRounds({
    deps: {
      dispatcher: toRoundDispatcher(deps.dispatcher),
      pendingGlobalEvals,
      providerRegistry: deps.providerRegistry,
      clusterSettings: deps.clusterSettings,
      globalEvalCache: deps.globalEvalCache,
      agentRegistry: deps.agentRegistry,
    },
    info,
    event: args.event,
    candidates,
    repoIdentifier,
    ref: args.ref,
    dispatchBundle: args.dispatchBundle,
    dispatchCredentials: args.dispatchCredentials,
    config: {
      globalEvalRoundTimeoutMs:
        deps.globalEvalRoundTimeoutMs ?? FALLBACK_GLOBAL_EVAL_ROUND_TIMEOUT_MS,
      globalEvalCandidateTimeoutMs:
        deps.globalEvalCandidateTimeoutMs ?? FALLBACK_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS,
      globalEvalWaitTimeoutMs: deps.globalEvalWaitTimeoutMs ?? FALLBACK_GLOBAL_EVAL_WAIT_TIMEOUT_MS,
    },
  });

  const roundFailureWorkflowRepos: string[] = [];
  for (const failure of failures) {
    roundFailureWorkflowRepos.push(failure.workflowRepoIdentifier);
    await surfaceFailedEvalRound({ ...args, failure });
  }

  const resolved: ResolvedGlobalCandidate[] = [];
  const unresolvedWorkflowRepos = new Set<string>();
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidateKey(candidate));
    // A missing or indeterminate verdict is not a decision — the round could
    // not answer for this candidate, so its repository is not one this pass can
    // report as evaluated.
    if (verdict === undefined || verdict.indeterminate === true) {
      unresolvedWorkflowRepos.add(candidate.reg.repoIdentifier);
    }
    if (verdict?.run !== true) {
      logger.info('Global workflow skipped by eval round', {
        deliveryId: info.deliveryId,
        workflow: candidate.lockEntry.name,
        workflowRepo: candidate.reg.repoIdentifier,
        sourceRepo: repoIdentifier,
        indeterminate: verdict?.indeterminate === true,
        reason: verdict?.reason,
      });
      // The `filter` predicate runs on an agent and returns nothing but a
      // boolean, so its exclusion is the least visible outcome in the pipeline.
      // Recording it in the trace is what makes it answerable.
      if (candidate.decision) {
        const excluded = appendChecks(candidate.decision, [
          createGlobalFilterTraceEntry({
            run: false,
            indeterminate: verdict?.indeterminate === true,
            reason: verdict?.reason,
          }),
        ]);
        logGlobalDecisionTrace(excluded, {
          deliveryId: info.deliveryId,
          workflowRepo: candidate.reg.repoIdentifier,
          sourceRepo: repoIdentifier,
        });
        decisionSummaries.push(summarizeGlobalDecision(excluded, candidate.reg.repoIdentifier));
      }
      continue;
    }
    resolved.push({
      candidate,
      jobs: [...staticJobsOf(candidate.lockEntry), ...(verdict.jobs ?? [])],
    });
  }
  return {
    resolved,
    decisionSummaries,
    roundFailureWorkflowRepos,
    unresolvedWorkflowRepos: [...unresolvedWorkflowRepos],
  };
}

/** One cleared global candidate's job inputs, under the run id they dispatch as. */
interface BuiltGlobalCandidate {
  globalRunId: string;
  inputs: GlobalJobInput[];
  /** The expanded job set + expansion map, threaded to `insertEdgesForRun`. */
  materialized: MaterializedJob[];
  expansionMap: Map<string, string[]>;
}

/**
 * Build one cleared global candidate's job inputs, minting the run id it will
 * dispatch under. The id is minted here because a candidate the round declined
 * never becomes a run.
 *
 * Deliberately split from the dispatch so a caller can bound its error handling
 * to the build alone. The two failures are not alike: a malformed generated job
 * throws HERE, before anything is queued, and may be swallowed; a dispatcher
 * failure — a wedged queue, a database error — is an infrastructure fault that
 * must propagate and fail the delivery rather than leave a half-queued run
 * nothing will ever complete.
 *
 * Failing the delivery does NOT buy a provider retry: `dedup.claim` has already
 * recorded this delivery id and nothing releases it, so the provider's
 * redelivery of the same id is dropped as a duplicate. What it buys is the
 * `failed` event-log row — the delivery is recorded as broken instead of
 * silently reported as processed with runs the pipeline never finished.
 */
function buildOneGlobalCandidate(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  resolved: ResolvedGlobalCandidate;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
}): BuiltGlobalCandidate {
  const { info, resolved, repoIdentifier } = args;
  const { reg, lockEntry } = resolved.candidate;
  const globalRunId = randomUUID();
  enrichRequestContext({ runId: globalRunId });
  const built = buildGlobalWorkflowJobInputs({
    info,
    reg,
    globalWorkflow: lockEntry,
    globalRunId,
    ref: args.ref,
    event: args.event,
    repoIdentifier,
    dispatchBundle: args.dispatchBundle,
    dispatchCredentials: args.dispatchCredentials,
    providerRegistry: args.deps.providerRegistry,
    jobs: resolved.jobs,
  });
  return {
    globalRunId,
    inputs: built.inputs,
    materialized: built.materialized,
    expansionMap: built.expansionMap,
  };
}

/**
 * Write the `execution_runs` row for one cleared global candidate, before any
 * of its jobs are queued.
 *
 * A cross-repo global workflow is a run like any other: it must be listable,
 * inspectable and cancellable, which every consumer keys on this row. Without
 * it the jobs execute invisibly — `ExecutionTracker.onJobStatus` cannot even
 * record their status, because `execution_jobs` carries a foreign key onto
 * `execution_runs` and the recovery path drops a status whose run is unknown.
 *
 * `repoIdentifier` is the **source** repo — the one that emitted the event and
 * whose code the jobs check out. The workflow's own repo is a column of its own
 * (`execution_runs.workflow_repo_identifier`), passed as the last argument
 * below, and it also travels per job in `jobConfig.workflowRepoIdentifier`. The
 * two are not redundant: the row is what the run list, the rerun path and the
 * either-repository access predicate read, none of which see a job config.
 *
 * Written BEFORE the dispatch loop, with no jobs: the dispatcher mints the job
 * ids, so they can only be registered afterwards (via `addJobsToRun`), and
 * recording the run first is what closes the window in which a fast job status
 * would arrive against a row that does not exist yet. A zero-job run is never
 * finalized early — `isRunComplete` requires at least one job — which is the
 * same two-step the re-run path uses.
 */
async function recordGlobalRunStart(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  candidate: GlobalEvalCandidate;
  runId: string;
  repoIdentifier: string;
  ref: string;
  dispatchCredentials: Record<string, unknown>;
}): Promise<void> {
  const { info, deps, event, candidate, runId, repoIdentifier, ref } = args;
  const tracker = deps.executionTracker;
  if (!tracker) return;
  const { lockEntry } = candidate;
  await tracker.onExecutionStarted(
    runId,
    lockEntry.name,
    info.provider,
    repoIdentifier,
    // The run row's `ref` is the branch the run PRESENTS, which is what every
    // other `onExecutionStarted` caller writes and what the context branch gate
    // evaluates. Not the ref the dispatched jobs carry: a job's checkout ref is
    // the PR head branch, which a fork contributor names freely, and this row is
    // read back as a branch claim by the internal-event branch inheritance.
    event.targetBranch,
    ref,
    info.deliveryId,
    args.dispatchCredentials,
    candidate.decision ? summarizeDecision(candidate.decision) : null,
    [], // Registered after dispatch — the dispatcher assigns the job ids.
    info.routingKey,
    undefined, // dispatchedContexts — this path binds no secret contexts.
    buildTriggerEvent(event.type, event.action),
    extractCommitMessage(info.event, info.payload),
    undefined, // parentRunId
    undefined, // triggeredBy
    undefined, // originalRunId
    lockEntry.concurrency
      ? {
          cancelInProgress: lockEntry.concurrency.cancelInProgress,
          max: lockEntry.concurrency.max,
        }
      : undefined,
    lockEntry.timeout, // workflowTimeoutMs
    undefined, // checkMode
    undefined, // localWorkingTree
    event.senderUsername ?? undefined,
    event.senderUserId ?? undefined,
    undefined, // triggeredByAgentLabel
    event.prNumber ?? null,
    // The repo that DEFINES this workflow, which for an organization-wide
    // dispatch is not the repo above. Without it the run row cannot say where
    // its own workflow lives, and the rerun path resolves the wrong lock file.
    candidate.reg.repoIdentifier,
  );
}

/** Dispatch a built candidate's jobs and return its run id. */
async function dispatchBuiltGlobalCandidate(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  built: BuiltGlobalCandidate;
  candidate: GlobalEvalCandidate;
  repoIdentifier: string;
  ref: string;
  dispatchCredentials: Record<string, unknown>;
  dispatchLogMessage: string;
}): Promise<string> {
  const { deps, built, candidate, repoIdentifier } = args;
  // A cleared candidate that materialized no jobs dispatches nothing, so it gets
  // no run either. A row with zero jobs can never complete — `isRunComplete`
  // ends `run.jobs.size > 0` — and nothing would ever reap it, so it would sit
  // `pending` forever in `runs list`.
  if (built.inputs.length === 0) {
    logger.warn('Organization-wide workflow cleared with no jobs to dispatch', {
      runId: built.globalRunId,
      workflow: candidate.lockEntry.name,
      sourceRepo: repoIdentifier,
      workflowRepo: candidate.reg.repoIdentifier,
    });
    return built.globalRunId;
  }
  await recordGlobalRunStart({ ...args, runId: built.globalRunId });
  // The event that triggered this run, stored under the global run's own id —
  // the same write the per-repository dispatch path makes. For an
  // organization-wide workflow the event comes from a repo the workflow's
  // author may not own, so it is the one artefact that explains why their
  // workflow ran at all; without it the run's payload view can only fail, and
  // a re-run of it has nothing to copy forward.
  await storeWebhookPayload({
    logStorage: deps.logStorage,
    runId: built.globalRunId,
    payload: args.info.payload,
  });
  const tracker = deps.executionTracker;
  // Hold the run open for the whole dispatch window. Without a token, a job
  // that reaches a terminal state while jobs 2..N are still being dispatched
  // finalizes the run early: `onJobStatus` recovers the not-yet-registered job
  // into `run.jobs`, `isRunComplete` then sees every job it knows about
  // terminal, and the run is written terminal with the wrong status and
  // duration, releases its concurrency slot, and — because `completedAt` is
  // set — never re-finalizes when the remaining jobs land. The per-repository
  // paths take the same token across their own registration windows.
  const held = tracker?.holdRunForPendingJobs(built.globalRunId) ?? false;
  try {
    await dispatchGlobalCandidateJobs({ ...args, tracker });
  } catch (err) {
    // The run row exists but may hold zero jobs — a throw on the first
    // dispatch, or one from the registration itself. Nothing can reap that
    // row: the stale-run detector scans from `execution_jobs` /
    // `dispatch_queue`, orphan recovery needs `status = 'running'`, cold-store
    // archival needs a terminal status, and cancel cannot terminalize it
    // either (`completeRunIfAllJobsTerminal` requires at least one job). It
    // would sit `pending` forever, uncancellable, while the deadline detector
    // re-fires against it every tick. `failRun` writes the terminal row and
    // evicts the in-memory run without needing a job to hang it off.
    if (tracker) {
      try {
        await tracker.failRun(
          built.globalRunId,
          `Organization-wide workflow dispatch failed: ${toErrorMessage(err)}`,
        );
      } catch (failErr) {
        logger.error(
          'Failed to terminalize an organization-wide workflow run after a dispatch error',
          {
            runId: built.globalRunId,
            workflow: candidate.lockEntry.name,
            error: toErrorMessage(failErr),
          },
        );
      }
    }
    // Still propagated: an infrastructure fault must fail the delivery rather
    // than be swallowed, for the reasons the dispatch loop's own comments give.
    throw err;
  } finally {
    // Releasing can finalize the run (DB writes, provider check, Platform
    // forwarding), so it can throw — and on the error path `failRun` may have
    // thrown and been swallowed above, leaving the run in memory still holding
    // this token, so the release can finalize a partially-registered run.
    // Swallow-and-log: a throw from a `finally` replaces whatever dispatch was
    // about to return or raise, turning a completed dispatch into a dispatch
    // error and hiding the original failure. On the happy path it would also
    // fail the delivery, which `dedup.claim` has already claimed — so the
    // event would be silently lost and every remaining candidate skipped.
    if (held) {
      try {
        await tracker?.releasePendingJobsHold(built.globalRunId);
      } catch (err) {
        logger.error('Failed to release pending-jobs hold', {
          runId: built.globalRunId,
          workflow: candidate.lockEntry.name,
          error: toErrorMessage(err),
        });
      }
    }
  }
  return built.globalRunId;
}

/**
 * Dispatch one built candidate's jobs and register them against its run.
 *
 * Split out of {@link dispatchBuiltGlobalCandidate} so the run-lifecycle
 * bookkeeping around it — the pending-jobs hold and the terminalize-on-throw
 * guard — reads as one window.
 */
async function dispatchGlobalCandidateJobs(args: {
  deps: ProcessingDeps;
  built: BuiltGlobalCandidate;
  candidate: GlobalEvalCandidate;
  repoIdentifier: string;
  dispatchLogMessage: string;
  tracker: ProcessingDeps['executionTracker'];
}): Promise<void> {
  const { deps, built, candidate, repoIdentifier, tracker } = args;
  const dispatchedJobs: DispatchedJobEntry[] = [];
  const rejectedJobs: RejectedJobEntry[] = [];
  for (const { lockJobName, lockJob, input } of built.inputs) {
    // `baseJobName` and `matrixValues` come from the envelope
    // `buildGlobalWorkflowJobInputs` already spread into the job config, so a
    // materialized child's `execution_jobs` row carries the same identity a
    // per-repository one does.
    const envelope = input.jobConfig as {
      matrixValues?: Record<string, unknown>;
      baseJobName?: string;
    };
    const tracked = {
      jobName: lockJobName,
      runsOnLabels: input.runsOnLabels,
      ...(envelope.matrixValues && { matrixValues: envelope.matrixValues }),
      ...(envelope.baseJobName && { baseJobName: envelope.baseJobName }),
    };

    // An invoke gate never reaches an agent: register it as a synthetic pending
    // `gate` row + stash its invoke params so the release path (`dispatchReadyJob`
    // → `releaseInvokeGate`) summons the source repo's subscribers instead of
    // dispatching the (stepless) job input. Root gates are nudged post-registration
    // by `invokeRootGlobalGates`; needs-gated ones are released by the scheduler.
    const invokeParams = invokeParamsFromLockJob(lockJob);
    if (invokeParams) {
      await storePendingJobContext(deps.db, built.globalRunId, lockJobName, {
        jobInput: input,
        runsOnLabels: [],
        invoke: invokeParams,
      });
      dispatchedJobs.push({
        jobId: `${NEEDS_PENDING_JOB_ID_PREFIX}${lockJobName}-${randomUUID()}`,
        ...tracked,
        jobKind: JobKind.Gate,
        ...(invokeParams.timeoutMs !== undefined && { timeoutMs: invokeParams.timeoutMs }),
      });
      continue;
    }

    // A non-root job waits for the needs scheduler: hold it as a synthetic
    // needs-pending row + stash its input for `dispatchReadyJob` to consume when
    // its upstreams complete. Without this the global path dispatched every job
    // at once, so a downstream `needs` edge never gated (and a gate's downstream
    // could not be released after the gate).
    if (!isRootJob(lockJob)) {
      await storePendingJobContext(deps.db, built.globalRunId, lockJobName, {
        jobInput: input,
        runsOnLabels: input.runsOnLabels,
      });
      dispatchedJobs.push({
        jobId: `${NEEDS_PENDING_JOB_ID_PREFIX}${lockJobName}-${randomUUID()}`,
        ...tracked,
      });
      continue;
    }

    // Root, non-gate: dispatch straight to the queue.
    const result = await deps.dispatcher.dispatch(input);
    if (result.status === 'rejected') {
      // A rejected dispatch — a full queue — is still tracked, under a
      // synthetic id the per-repository path also uses, and marked failed
      // below. Dropping it instead leaves the run holding fewer jobs than it
      // has: every job rejected leaves a run with NO jobs, which
      // `isRunComplete` can never finish and no sweeper reaps (the stale-run
      // detector scans from `execution_jobs` / `dispatch_queue`, and cold-store
      // archival requires a terminal status), so it sits `pending` forever;
      // and one job rejected lets the run roll up green with that job silently
      // absent.
      const syntheticId = `rejected-${randomUUID()}`;
      dispatchedJobs.push({ jobId: syntheticId, ...tracked });
      rejectedJobs.push({ jobId: syntheticId, reason: result.reason });
      logger.error('Organization-wide workflow job dispatch rejected', {
        runId: built.globalRunId,
        workflow: candidate.lockEntry.name,
        job: lockJobName,
        reason: result.reason,
        sourceRepo: repoIdentifier,
        workflowRepo: candidate.reg.repoIdentifier,
      });
      continue;
    }
    dispatchedJobs.push({ jobId: result.jobId, ...tracked });
    logger.info(args.dispatchLogMessage, {
      runId: built.globalRunId,
      workflow: candidate.lockEntry.name,
      job: lockJobName,
      status: result.status,
      sourceRepo: repoIdentifier,
      workflowRepo: candidate.reg.repoIdentifier,
    });
  }
  if (tracker) {
    await registerDispatchedJobs({
      newRunId: built.globalRunId,
      dispatchedJobs,
      rejectedJobs,
      executionTracker: tracker,
    });
    // Registration created the `execution_jobs` rows; now wire the needs graph
    // over them and nudge any root invoke gate. This runs inside the caller's
    // pending-jobs hold, so a gate that terminalizes immediately (zero
    // subscribers) does not finalize the run before its downstreams are settled.
    await wireGlobalNeedsAndGates({ deps, built, dispatchedJobs });
  }
}

/**
 * After a global run's jobs are registered, wire its needs graph the same way a
 * per-repository run's is: insert the static needs edges (which also marks root
 * jobs `needs_satisfied`), catch up any downstream whose upstream already
 * terminalized inside the dispatch window, then release every root invoke gate.
 */
async function wireGlobalNeedsAndGates(args: {
  deps: ProcessingDeps;
  built: BuiltGlobalCandidate;
  dispatchedJobs: readonly DispatchedJobEntry[];
}): Promise<void> {
  const { deps, built, dispatchedJobs } = args;
  const runId = built.globalRunId;
  if (!deps.db || !deps.executionTracker) return;
  try {
    await insertEdgesForRun(deps.db, runId, built.materialized, built.expansionMap);
    await catchUpNeedsGatedJobs({ ctx: { deps, runId }, dispatchedJobs });
  } catch (err) {
    logger.error('Failed to insert needs edges for organization-wide workflow run', {
      runId,
      error: toErrorMessage(err),
    });
  }
  await invokeRootGlobalGates({ deps, built });
}

/**
 * Release every root (no-needs) invoke gate in a global run once its jobs and
 * edges are registered. Mirrors the per-repository `invokeRootGates`: a root gate
 * has no upstream to fire the scheduler, so it is nudged through `dispatchReadyJob`,
 * whose gate branch summons the source repo's subscribers instead of reaching an
 * agent. Needs-gated gates are left for the scheduler.
 */
async function invokeRootGlobalGates(args: {
  deps: ProcessingDeps;
  built: BuiltGlobalCandidate;
}): Promise<void> {
  const { deps, built } = args;
  const runId = built.globalRunId;
  if (!deps.executionTracker || !deps.db) return;
  const seen = new Set<string>();
  for (const mat of built.materialized) {
    if (!isInvokeGate(mat.lockJob) || !isRootJob(mat.lockJob)) continue;
    if (seen.has(mat.expandedName)) continue;
    seen.add(mat.expandedName);
    if (!deps.invokeGateDeps) {
      logger.error('Root invoke gate cannot summon: invoke-gate deps unavailable', {
        runId,
        job: mat.expandedName,
      });
      await deps.executionTracker.onJobStatus(
        runId,
        mat.expandedName,
        ExecutionJobStatus.enum.failed,
        Date.now(),
        undefined,
        { error: 'invoke gate could not run: gate dependencies unavailable' },
      );
      continue;
    }
    await dispatchReadyJob(
      runId,
      mat.expandedName,
      deps.dispatcher,
      deps.executionTracker,
      deps.coordinator,
      deps.db,
      deps.invokeGateDeps,
    );
  }
}

/** What one organization-wide dispatch pass produced. */
interface GlobalDispatchOutcome {
  matchedCount: number;
  matchedRunIds: string[];
  /** One summary per global decision this pass reached, dispatched or excluded. */
  decisionSummaries: Record<string, unknown>[];
  /**
   * The workflow repository of every evaluation round this pass could not
   * decide. Empty means every round the pass ran reached a verdict.
   */
  roundFailureWorkflowRepos: string[];
  /**
   * Every workflow repository this pass actually evaluated: it examined that
   * repository's registrations and reached a real outcome for each of them —
   * dispatched, filtered out, or excluded by a verdict.
   *
   * The pass's POSITIVE signal, and the one a re-run gates its success check
   * on. An empty `roundFailureWorkflowRepos` cannot carry that meaning: a pass
   * with no registration index, no pending-eval tracker, or an event the trust
   * policy held evaluates nothing and reports no failure either, so reading its
   * silence as a clean verdict is the false assurance the round exists to
   * remove.
   */
  decidedWorkflowRepos: string[];
}

/**
 * Split the matched candidates into the ones the lock file fully describes and
 * the ones the eval round has to decide on, then dispatch both sets.
 *
 * Shared by Phase F and Phase J; the two differ only in the log message their
 * dispatched jobs carry, which Loki dashboards key off.
 */
async function dispatchGlobalCandidates(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  candidates: readonly GlobalEvalCandidate[];
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /** The inbound event's own bundle + credentials, used to post the failed-round check. */
  bundle?: ProviderBundle;
  credentials?: Record<string, unknown>;
  dispatchLogMessage: string;
  /** The source `dispatchCredentials` belongs to; forwarded to the failure record. */
  dispatchRoutingKey?: string;
  /**
   * Every workflow repository the collection examined, from
   * {@link GlobalCandidateCollection}. The universe `decidedWorkflowRepos` is
   * computed against; defaults to the repositories the candidates themselves
   * name, which is the same set minus any repository whose every registration
   * was filtered out before becoming a candidate.
   */
  consideredWorkflowRepos?: readonly string[];
}): Promise<GlobalDispatchOutcome> {
  const matchedRunIds: string[] = [];
  const decisionSummaries: Record<string, unknown>[] = [];
  const considered =
    args.consideredWorkflowRepos ?? args.candidates.map((c) => c.reg.repoIdentifier);
  if (args.candidates.length === 0)
    return {
      matchedCount: 0,
      matchedRunIds,
      decisionSummaries,
      roundFailureWorkflowRepos: [],
      // Nothing needed a verdict, so every repository the collection examined
      // was decided by trigger matching alone.
      decidedWorkflowRepos: [...new Set(considered)],
    };

  const { immediate, needsRound } = partitionCandidates(args.candidates);

  // A candidate declaring neither a `filter` nor a `DynamicJobFn` is fully
  // described by its lock file, so its static jobs dispatch straight away —
  // byte-identical to the behaviour before the round existed.
  for (const candidate of immediate) {
    const built = buildOneGlobalCandidate({
      ...args,
      resolved: { candidate, jobs: staticJobsOf(candidate.lockEntry) },
    });
    matchedRunIds.push(await dispatchBuiltGlobalCandidate({ ...args, built, candidate }));
    if (candidate.decision) {
      decisionSummaries.push(
        summarizeGlobalDecision(candidate.decision, candidate.reg.repoIdentifier),
      );
    }
  }

  const round = await resolveRoundCandidates({ ...args, candidates: needsRound });
  decisionSummaries.push(...round.decisionSummaries);
  for (const resolved of round.resolved) {
    let built: BuiltGlobalCandidate;
    try {
      built = buildOneGlobalCandidate({ ...args, resolved });
    } catch (err) {
      // A generated job arrives from the agent proven only to carry a usable
      // `name`, so materializing it can still throw on a malformed matcher or
      // matrix. Fail this workflow alone rather than the whole delivery.
      //
      // Only the BUILD is caught. A dispatcher failure past this point is an
      // infrastructure fault (a wedged queue, a database error), and swallowing
      // it would strand the jobs already queued under a run id nothing records
      // — so it propagates and fails the delivery, exactly as it does on the
      // immediate path.
      logger.error('Global workflow dispatch failed after eval round', {
        deliveryId: args.info.deliveryId,
        workflow: resolved.candidate.lockEntry.name,
        workflowRepo: resolved.candidate.reg.repoIdentifier,
        sourceRepo: args.repoIdentifier,
        error: toErrorMessage(err),
      });
      // The workflow matched, so it belongs in the trace whatever happened
      // next. Skipping the summary below would leave it absent from every
      // record the delivery has — no run row, no job, and no trace entry —
      // which is indistinguishable from never having been registered.
      if (resolved.candidate.decision) {
        decisionSummaries.push(
          summarizeGlobalDecision(
            appendChecks(resolved.candidate.decision, [
              createDispatchFailureTraceEntry(`Jobs could not be built: ${toErrorMessage(err)}`),
            ]),
            resolved.candidate.reg.repoIdentifier,
          ),
        );
      }
      continue;
    }
    matchedRunIds.push(
      await dispatchBuiltGlobalCandidate({ ...args, built, candidate: resolved.candidate }),
    );
    if (resolved.candidate.decision) {
      decisionSummaries.push(
        summarizeGlobalDecision(resolved.candidate.decision, resolved.candidate.reg.repoIdentifier),
      );
    }
  }

  const unresolved = new Set(round.unresolvedWorkflowRepos);
  return {
    matchedCount: matchedRunIds.length,
    matchedRunIds,
    decisionSummaries,
    roundFailureWorkflowRepos: round.roundFailureWorkflowRepos,
    decidedWorkflowRepos: [...new Set(considered)].filter((repo) => !unresolved.has(repo)),
  };
}

/**
 * How the globals-skipped notice names each non-passing verdict. A `Record` over
 * the non-passing actions, so a verdict added to `TrustPolicyOutcome` without a
 * word here is a compile error rather than a blank in a customer-visible check.
 */
const GLOBALS_SKIPPED_VERB: Record<Exclude<TrustPolicyOutcome['action'], 'pass'>, string> = {
  ignore: 'ignored',
  hold: 'held',
  reject: 'rejected',
};

/**
 * Post the neutral informational check recording that org global workflows were
 * skipped because the trust policy did not pass the event.
 *
 * Goes through the poster's own dedicated check name, NOT `postCheckStatus`:
 * that method owns the single "KiCI Security" check run per commit, which the
 * hold posts as pending and approve / reject later complete — so writing this
 * notice through it would resolve the still-held run's check to neutral and
 * unblock a branch protection rule that requires the security check.
 *
 * Deliberately neutral in BOTH the hold and reject cases: on `reject` the
 * same-source path already posts a failure check for the event, and a second
 * failure would double-report one decision. A skipped global has no run row, so
 * there is no held run to approve — approving the event's hold releases the
 * pull request's own workflows only.
 *
 * Posted through the INBOUND event's bundle and credentials, since the check
 * lands on the inbound repo; a cross-provider lock-file fallback swaps the
 * dispatch bundle for another source's, which must not be used to write here.
 */
async function postGlobalsSkippedCheck(args: {
  bundle: ProviderBundle;
  repoIdentifier: string;
  ref: string;
  credentials: Record<string, unknown>;
  decision: TrustPolicyOutcome;
}): Promise<void> {
  const { bundle, repoIdentifier, ref, credentials, decision } = args;
  if (decision.action === 'pass') return;
  const reason = trustPolicyOutcomeReason(decision);
  try {
    await bundle.checkStatusPoster?.postGlobalWorkflowsSkippedCheck(
      repoIdentifier,
      ref,
      `The organization trust policy ${GLOBALS_SKIPPED_VERB[decision.action]} this ` +
        `event${reason ? ` (${reason})` : ''}, so organization-wide global workflows did not ` +
        `run. Approving the hold releases this pull request's own workflows; it does not ` +
        `retroactively run the organization's global workflows for this event.`,
      credentials,
    );
  } catch (err) {
    logger.warn('Failed to post globals-skipped check', {
      repoIdentifier,
      reason,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Phase F — Lock file is missing for this repo — try global workflows in the
 * SAME ORG that target this event type. Even without a per-repo lock file,
 * global workflows in other repos may match. Returns the count of jobs
 * dispatched (used for metrics + event log) alongside the pass's own decision
 * summaries, which the caller forwards as this delivery's trace.
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
  /** The source `dispatchCredentials` belongs to; forwarded to the failure record. */
  dispatchRoutingKey?: string;
  /** The inbound event's own bundle, used to post the globals-skipped check. */
  bundle: ProviderBundle;
  credentials: Record<string, unknown>;
  securityDecision: TrustPolicyOutcome;
}): Promise<{ matchedCount: number; decisionSummaries: Record<string, unknown>[] }> {
  const {
    info,
    deps,
    event,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
    bundle,
    credentials,
    securityDecision,
  } = args;
  // Org global workflows run with ORG credentials against the event's head SHA,
  // so a held or rejected event must not dispatch them.
  if (securityDecision.action !== 'pass') {
    logger.info('Global workflows skipped by trust policy (no lock file path)', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      action: securityDecision.action,
      reason: trustPolicyOutcomeReason(securityDecision),
    });
    await postGlobalsSkippedCheck({
      bundle,
      repoIdentifier,
      ref,
      credentials,
      decision: securityDecision,
    });
    return { matchedCount: 0, decisionSummaries: [] };
  }
  if (!deps.registrationIndex) return { matchedCount: 0, decisionSummaries: [] };

  // Refresh registration index in case external changes were made.
  if (deps.registrationStore) {
    const remoteVersion = await deps.registrationStore.getVersion();
    await deps.registrationIndex.refreshIfNeeded(remoteVersion);
  }

  // One stamped event for both halves: the matcher and the dispatched job must
  // see the same envelope, and the no-lock-file path's raw event carries no
  // `sourceRepo`.
  const globalEvent = withSourceRepo(event, repoIdentifier);

  const collected = await collectGlobalCandidates({
    info,
    deps,
    event: globalEvent,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
  });

  const dispatched = await dispatchGlobalCandidates({
    info,
    deps,
    event: globalEvent,
    candidates: collected.candidates,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
    bundle,
    credentials,
    dispatchLogMessage: 'Global workflow job dispatched (no lock file path)',
    consideredWorkflowRepos: collected.consideredWorkflowRepos,
    ...(args.dispatchRoutingKey !== undefined && {
      dispatchRoutingKey: args.dispatchRoutingKey,
    }),
  });

  return {
    matchedCount: dispatched.matchedCount,
    decisionSummaries: [...collected.decisionSummaries, ...dispatched.decisionSummaries],
  };
}

// ---------------------------------------------------------------------------
// Phase G — Workflow modification detection + security hold check status
// ---------------------------------------------------------------------------

interface SecurityState {
  workflowModifications: WorkflowModification[];
  /**
   * True when this PR changes `.kici/` workflow definitions. Reported, not
   * enforced: the org trust policy is the fork switch, and it reads the fork
   * signal and the tier — never this one.
   */
  hasWorkflowModifications: boolean;
}

/**
 * Phase G — On PR events evaluated against the base lock file, detect workflow
 * modifications by diffing base vs. head and post a neutral informational check
 * (on its own dedicated check name).
 *
 * Detection and legibility only: the check tells a reviewer that this PR edits
 * the workflows it would run under. It feeds no policy decision — a PR that
 * edits `.kici/` from the base repo is written by a contributor who could
 * already push to it, and one from a fork is governed by the fork switch
 * whether or not it touches `.kici/`.
 */
export function applyWorkflowModificationsAndSecurityHold(args: {
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
    }

    if (workflowModifications.length > 0 && bundle.checkStatusPoster) {
      // Neutral informational check on its OWN check name so it never overwrites
      // the security-hold check the dispatch gate posts.
      bundle.checkStatusPoster
        .postWorkflowModificationCheck(repoIdentifier, ref, workflowModifications, credentials)
        .catch((err) => {
          logger.warn('Failed to post workflow modification check', {
            deliveryId: info.deliveryId,
            error: toErrorMessage(err),
          });
        });
    }
  }

  return { workflowModifications, hasWorkflowModifications: workflowModifications.length > 0 };
}

/**
 * Evaluate the org trust policy for a PR event.
 *
 * Scoped to providers with a fork model (`bundle.hasForkModel`): a source
 * without one passes regardless of policy. That is not a trust claim about such
 * a source — a PR from a fork-less provider resolves no tier at all. It is that
 * the policy's one condition cannot be established for it: universal-git does
 * compute an `isForkPR`, but from payload keys many forges omit, and it reads
 * `false` when they are absent. Gating on a signal that fails toward trust
 * would be worse than not gating.
 *
 * The policy read has two distinct failure shapes, and they get distinct
 * answers: no stored row is the unconfigured default (`FAIL_CLOSED_POLICY`),
 * while a read that THREW gets `READ_FAILURE_POLICY` — see there for why.
 */
export async function evaluateSecurityPolicy(args: {
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  isPREvent: boolean;
  resolvedOrgId: string;
  mode: OrchestratorMode;
  trustResolution: TrustResolution | undefined;
  isForkPR: boolean;
}): Promise<TrustPolicyOutcome> {
  const { deps, bundle, isPREvent, resolvedOrgId, mode } = args;
  if (!isPREvent || !bundle.hasForkModel) return { action: 'pass' };

  let stored: StoredTrustPolicy | null = null;
  let readFailed = false;
  try {
    stored = (await deps.trustPolicyStore?.get(resolvedOrgId)) ?? null;
  } catch (err) {
    // A failed read is not an unconfigured org, and answering both the same way
    // is not harmless: an org whose stored policy is `hold` or `allow` would
    // have its fork PRs dropped with no trace, on nothing more than a transient
    // database error. Hold instead — equally fail-closed, and recoverable.
    readFailed = true;
    logger.warn('Trust policy read failed; holding fork PRs for this delivery', {
      orgId: resolvedOrgId,
      error: toErrorMessage(err),
    });
  }

  const policy = readFailed ? READ_FAILURE_POLICY : resolveEffectivePolicy(stored, mode);
  const outcome = evaluateTrustPolicy(policy, {
    tier: args.trustResolution?.tier,
    isForkPR: args.isForkPR,
  });

  const reason = trustPolicyOutcomeReason(outcome);
  trustPolicyDecisionsTotal.add(1, {
    arm: reason ?? 'none',
    action: outcome.action,
  });

  if (outcome.action !== 'pass') {
    logger.info('Trust policy gate decision', {
      orgId: resolvedOrgId,
      action: outcome.action,
      reason,
      tier: args.trustResolution?.tier,
    });
  }
  return outcome;
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

  // Non-null by construction: the guard above returned only because the pushed
  // branch equals this value. Persisting it is what gives a `__schedule_fire`
  // run a branch to present to a context's branch restrictions — a scheduled
  // run executes this branch's lock file, so this IS its branch.
  const defaultBranch = extractDefaultBranch(payload, bundle.normalizer);

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
        const globalNames = new Set(globalWorkflows.map((w) => w.name));
        logGlobalRegistrationExclusions([...globalNames], {
          deliveryId: info.deliveryId,
          workflowRepo: repoIdentifier,
          routingKey: info.routingKey,
          orgId: resolvedOrgId,
          reason: permission.reason ?? 'not permitted',
        });
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
      defaultBranch,
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
  // When no trigger uses path patterns the fetch is skipped entirely (the
  // legitimate fast path); otherwise the fetcher reports whether the diff was
  // fetched authoritatively or is unavailable (a provider capability gap /
  // upstream degradation). `unavailable` is threaded so path filters match
  // conservatively downstream instead of a bare `[]` silently no-matching.
  const fetched: ChangedFilesResult | { files: string[]; status: 'skipped' } =
    dispatchBundle.changedFilesFetcher &&
    anyTriggerHasPathPatterns(fullLockFile.workflows as LockWorkflow[])
      ? await dispatchBundle.changedFilesFetcher.getChangedFiles(
          repoIdentifier,
          info.event,
          payload,
          dispatchCredentials,
        )
      : { files: [], status: 'skipped' };

  // Populate sourceRepo so same-repo global workflows (those authored in the
  // event's own repo and gated by `repos` patterns) evaluate correctly; the
  // cross-repo matching branch below skips same-repo globals on the
  // assumption that per-repo matching already covers them.
  const eventWithFiles: SimulatedEvent = {
    ...event,
    changedFiles: fetched.files,
    changedFilesStatus: fetched.status,
    sourceRepo: repoIdentifier,
  };

  const matchStart = process.hrtime.bigint();
  // Event-type-bucketed candidate scan: only workflows subscribed to
  // eventWithFiles.type are evaluated. The matched set is identical to
  // matchAllWorkflows (candidates are a superset of every match); the hot
  // dispatch path filters `.matched` then looks workflows up by name, never
  // positionally, so a candidates-only array is safe here.
  const decisions = matchWorkflowsForEvent(fullLockFile.workflows, eventWithFiles);
  const matchDuration = Number(process.hrtime.bigint() - matchStart) / 1e9;
  triggerMatchDurationSeconds.record(matchDuration);
  return { eventWithFiles, decisions };
}

/**
 * Phase I.2 — For each matched workflow, mint a fresh runId and delegate to
 * `dispatchMatchedWorkflow` which handles cache + build coordination, secret
 * resolution, environment evaluation, static dispatch, deferred init/dynamic
 * dispatch, and execution-tracker registration. Each matched workflow gets
 * its OWN runId so execution tracking and Platform event forwarding don't
 * collide when multiple workflows match.
 *
 * Check runs are NOT kept apart by that runId — a check run's identity is
 * `(owner, repo, sha, check name)`, with no run id anywhere in it. What
 * separates them here is that the matched workflows carry distinct names
 * within one lock file. A workflow defined in ANOTHER repository is free to
 * reuse a name this one uses, which is why the reporter qualifies a
 * cross-repository global workflow's check name with the repository that
 * defines it — see `CheckRunReporter.workflowLabel`.
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
  /** PR-wide workflow-modification security-hold signal from phase G. */
  securityDecision: TrustPolicyOutcome;
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
    securityDecision,
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
      // The per-repository path matches triggers against the repository's OWN
      // lock file, so the workflow is defined by the repository the run acts on.
      workflowRepoIdentifier: repoIdentifier,
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
      // A local `file://` in-place source runs against the operator's real
      // working tree — mark the run local-working-tree so the source-pack
      // `__build__` job is skipped and each job runs the tree directly.
      localWorkingTree: dispatchBundle.localInPlace === true,
      crossSource: false,
      securityDecision,
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
export async function dispatchGlobalWorkflowsForOtherRepos(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  eventWithFiles: SimulatedEvent;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /** The inbound event's own bundle, used to post the globals-skipped check. */
  bundle: ProviderBundle;
  credentials: Record<string, unknown>;
  securityDecision: TrustPolicyOutcome;
  /**
   * The source `dispatchCredentials` belongs to, when a cross-provider lock-file
   * fallback made it a different source from `info.routingKey`. Persisted on a
   * failed round's run row so its re-run can rebuild the same dispatch pair
   * instead of handing this source's credentials to the inbound source's client.
   */
  dispatchRoutingKey?: string;
  /**
   * Restrict the pass to global workflows authored in this repository. Set by
   * the re-run of a failed evaluation round, which re-decides that round alone.
   */
  onlyWorkflowRepo?: string;
}): Promise<GlobalDispatchOutcome> {
  const {
    info,
    deps,
    eventWithFiles,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
    bundle,
    credentials,
    securityDecision,
  } = args;
  // Org global workflows run with ORG credentials against the event's head SHA,
  // so a held or rejected event must not dispatch them. The same-source path
  // has already held or failed the PR's own run by this point; this stops the
  // org's globals from running for that same untrusted event.
  if (securityDecision.action !== 'pass') {
    logger.info('Global workflows skipped by trust policy', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      action: securityDecision.action,
      reason: trustPolicyOutcomeReason(securityDecision),
    });
    await postGlobalsSkippedCheck({
      bundle,
      repoIdentifier,
      ref,
      credentials,
      decision: securityDecision,
    });
    return {
      matchedCount: 0,
      matchedRunIds: [],
      decisionSummaries: [],
      roundFailureWorkflowRepos: [],
      // The pass never ran, so it decided nothing — and it reports no round
      // failure either, which is exactly why the caller must not read that
      // absence as a clean evaluation.
      decidedWorkflowRepos: [],
    };
  }
  if (!deps.registrationIndex)
    return {
      matchedCount: 0,
      matchedRunIds: [],
      decisionSummaries: [],
      roundFailureWorkflowRepos: [],
      decidedWorkflowRepos: [],
    };

  // `eventWithFiles` is already stamped by `gatherChangedFilesAndMatchTriggers`,
  // so this is a no-op that returns the same object — stated rather than
  // assumed, so the invariant holds by construction on both global paths.
  const globalEvent = withSourceRepo(eventWithFiles, repoIdentifier);

  const collected = await collectGlobalCandidates({
    info,
    deps,
    event: globalEvent,
    resolvedOrgId,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
    ...(args.onlyWorkflowRepo !== undefined && { onlyWorkflowRepo: args.onlyWorkflowRepo }),
  });

  const dispatched = await dispatchGlobalCandidates({
    info,
    deps,
    event: globalEvent,
    candidates: collected.candidates,
    repoIdentifier,
    ref,
    dispatchBundle,
    dispatchCredentials,
    bundle,
    credentials,
    dispatchLogMessage: 'Global workflow job dispatched',
    consideredWorkflowRepos: collected.consideredWorkflowRepos,
    ...(args.dispatchRoutingKey !== undefined && {
      dispatchRoutingKey: args.dispatchRoutingKey,
    }),
  });

  return {
    ...dispatched,
    decisionSummaries: [...collected.decisionSummaries, ...dispatched.decisionSummaries],
  };
}

// ---------------------------------------------------------------------------
// Phase K — Forward Platform trace + record event log + final metrics
// ---------------------------------------------------------------------------

/**
 * Forward the delivery's decision trace to the Platform on a started
 * `execution.event`.
 *
 * Its own function because two dispatch paths reach it: the lock-file path via
 * Phase K, and the no-lock-file path, whose whole point is the organization-wide
 * pass. A repository with no `.kici/` lock file is the canonical target of an
 * organization-wide workflow, so leaving that path silent was leaving the case
 * the trace exists for — "why did the org's global not fire here?" — with no
 * answer at all.
 */
function sendDecisionTraceEvent(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  repoIdentifier: string;
  ref: string;
  matchedCount: number;
  /** The count the trace is being reported against. */
  totalWorkflows: number;
  decisions: Record<string, unknown>[];
}): void {
  const { info, deps, repoIdentifier, ref, matchedCount, totalWorkflows, decisions } = args;
  if (!deps.platformClient) return;
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
      totalWorkflows,
      decisions: capDecisionSummaries(decisions),
    },
    timestamp: Date.now(),
  });
}

async function forwardTracesAndRecordEventLog(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  payload: Record<string, unknown>;
  decisions: ReturnType<typeof matchAllWorkflows>;
  /** The organization-wide pass's own summaries, already tagged with their repo. */
  globalDecisionSummaries: Record<string, unknown>[];
  matchedCount: number;
  matchedRunIds: string[];
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  changedFilesStatus: SimulatedEvent['changedFilesStatus'];
}): Promise<void> {
  const {
    info,
    deps,
    payload,
    decisions,
    globalDecisionSummaries,
    matchedCount,
    matchedRunIds,
    resolvedOrgId,
    repoIdentifier,
    ref,
    changedFilesStatus,
  } = args;

  // One array over both halves — the per-repo lock file's decisions and the
  // organization-wide pass's — so the size budget is applied to what actually
  // goes on the wire rather than to either half alone.
  //
  // `totalWorkflows` counts THIS array. Reporting only the lock-file half beside
  // a trace that also carries the organization-wide one puts two fields on one
  // message that contradict each other.
  const allDecisions = [...decisions.map(summarizeDecision), ...globalDecisionSummaries];

  sendDecisionTraceEvent({
    info,
    deps,
    repoIdentifier,
    ref,
    matchedCount,
    totalWorkflows: allDecisions.length,
    decisions: allDecisions,
  });

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
      // Surface a degraded evaluation (path filters run against an unavailable
      // diff) so the operator sees it instead of a silent `processed / 0`.
      errorMessage:
        changedFilesStatus === 'unavailable' ? DEGRADED_CHANGED_FILES_REASON : undefined,
    });
  }

  logger.info('Webhook processed', {
    deliveryId: info.deliveryId,
    event: info.event,
    matchedWorkflows: matchedCount,
    totalWorkflows: decisions.length,
  });
}

/**
 * Phases I–K — Once a lock file resolves, gather changed files, match + dispatch
 * same-source and cross-repo global workflows, then forward the Platform trace
 * and record the `processed` event-log row (annotated when path filters ran
 * against an unavailable diff). Extracted from `processWebhook` to keep the
 * narrative orchestrator under the function-length budget.
 */
async function matchDispatchAndRecordOutcome(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  payload: Record<string, unknown>;
  event: SimulatedEvent;
  fullLockFile: FullLockFile;
  lockOutcome: Awaited<ReturnType<typeof fetchLockFileWithFallbackPhase>>;
  trust: Awaited<ReturnType<typeof resolveTrustForPR>>;
  resolvedOrgId: string;
  repoIdentifier: string;
  ref: string;
  /** The inbound event's own bundle, used to post the globals-skipped check. */
  bundle: ProviderBundle;
  /** Source-repo credentials, used to post the globals-skipped check. */
  credentials: Record<string, unknown>;
  /**
   * The PR-wide org trust-policy verdict for this event. Gates both the
   * same-source dispatch and the org's global workflows.
   */
  securityDecision: TrustPolicyOutcome;
}): Promise<WebhookIngestOutcome> {
  const {
    info,
    deps,
    payload,
    event,
    bundle,
    credentials,
    fullLockFile,
    lockOutcome,
    trust,
    resolvedOrgId,
    repoIdentifier,
    ref,
    securityDecision,
  } = args;

  const { eventWithFiles, decisions: rawDecisions } = await gatherChangedFilesAndMatchTriggers({
    info,
    payload,
    event,
    fullLockFile,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
    repoIdentifier,
  });

  // Tier-1: evaluate declarative content `requires` (pure data) against the
  // event repo's files at its ref, dropping non-matching / indeterminate
  // candidates BEFORE dispatch. No author code is executed here.
  const decisions = await applyContentFilterToDecisions({
    deps,
    decisions: rawDecisions,
    fullLockFile,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
    repoIdentifier,
    ref,
    deliveryId: info.deliveryId,
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
    securityDecision,
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
    ...(lockOutcome.resolvedFallbackRoutingKey !== undefined && {
      dispatchRoutingKey: lockOutcome.resolvedFallbackRoutingKey,
    }),
    bundle,
    credentials,
    securityDecision,
  });

  await forwardTracesAndRecordEventLog({
    info,
    deps,
    payload,
    decisions,
    globalDecisionSummaries: globals.decisionSummaries,
    matchedCount: sameSource.matchedCount + globals.matchedCount,
    matchedRunIds: [...sameSource.matchedRunIds, ...globals.matchedRunIds],
    resolvedOrgId,
    repoIdentifier,
    ref,
    changedFilesStatus: eventWithFiles.changedFilesStatus,
  });
  return WebhookIngestOutcome.enum.processed;
}

// ---------------------------------------------------------------------------
// Public entry point — narrative orchestrator
// ---------------------------------------------------------------------------

/**
 * Process a webhook through the complete pipeline, recording a `failed` event-log
 * row for a delivery the pipeline could not finish.
 *
 * The row is the only per-delivery record of such a failure. Nothing the pipeline
 * decides after acknowledgement can reach the sender — `acceptWebhookDelivery`
 * answers 202 and runs this detached — and the dashboard's webhook-activity view
 * counts `event_log.status = 'failed'` for exactly this. Without the write that
 * count is structurally always zero, and a post-acknowledgement failure appears
 * in the orchestrator's own logs and nowhere a customer can see.
 *
 * Best-effort and non-masking: the write is wrapped, and the original error is
 * rethrown either way. The delivery still reverts to `buffered` for the drain
 * pass to retry, so a redelivery that succeeds writes its own `processed` row
 * beside this one — the two are distinct rows, not a mutation.
 */
export async function processWebhook(
  info: WebhookInfo,
  deps: ProcessingDeps,
): Promise<WebhookIngestOutcome> {
  try {
    return await processWebhookPipeline(info, deps);
  } catch (err) {
    if (deps.eventLog) {
      try {
        // Resolved again rather than threaded out of the pipeline: the throw may
        // have escaped before the pipeline had an org, and this lookup is safe
        // and idempotent (it falls back to the no-tenant anchor on its own).
        const orgId = await resolveOrgIdSafe(deps, info.routingKey);
        await deps.eventLog.record(info, payloadFromObject(info.payload), {
          orgId,
          source: deps.eventLogSource ?? EventLogSource.enum.direct,
          status: EventLogStatus.enum.failed,
          errorMessage: toErrorMessage(err),
        });
      } catch (logErr) {
        logger.error('Failed to record a failed delivery in the event log', {
          deliveryId: info.deliveryId,
          routingKey: info.routingKey,
          error: toErrorMessage(logErr),
        });
      }
    }
    throw err;
  }
}

/**
 * Process a webhook through the complete pipeline.
 *
 * Flow:
 *   1. Dedup + provider lookup -> normalize
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
async function processWebhookPipeline(
  info: WebhookInfo,
  deps: ProcessingDeps,
): Promise<WebhookIngestOutcome> {
  const provider = await dedupAndResolveProvider(info, deps);
  if (provider.status === 'skip') return skipReasonToOutcome(provider.reason);
  const { resolvedOrgId, bundle } = provider;

  const event = await normalizeWebhookEvent(info, deps, bundle, resolvedOrgId);
  if (!event) return WebhookIngestOutcome.enum.skipped;

  if (info.provider === 'generic' && deps.registrationIndex) {
    const cs = await dispatchCrossSourceWorkflows(info, deps, event, resolvedOrgId);
    if (cs.handled) return WebhookIngestOutcome.enum.processed;
  }

  const repoCreds = await extractRepoAndCredentials(info, deps, bundle, resolvedOrgId);
  if (!repoCreds) return WebhookIngestOutcome.enum.skipped;
  const { repoIdentifier, credentials } = repoCreds;
  const payload = info.payload as Record<string, unknown>;

  // No `bundle` / `credentials`: each ended hold's check is completed on the
  // commit its own run acted on, through the bundle and credentials that run
  // recorded — not through the ones that delivered this comment.
  await handleApprovalCommentIfPresent({
    info,
    deps,
    event,
    payload,
    resolvedOrgId,
    repoIdentifier,
  });

  const ref = bundle.normalizer.extractRef(info.event, payload);
  const isPREvent = isPullRequestEvent(info.event);

  const trust = await resolveTrustForPR({ info, bundle, event, payload });

  // Phase D.1 — the org fork switch, read ONCE for this delivery and threaded
  // into every dispatch path below. Its signals (the tier and the fork flag) are
  // both settled by now, so evaluating it here rather than after the lock-file
  // fetch is what lets an `ignore` verdict drop the event before anything
  // observable exists — no run row, no check status, no clone token.
  const securityDecision = await evaluateSecurityPolicy({
    deps,
    bundle,
    isPREvent,
    resolvedOrgId,
    // The fail-closed side is the default: a deps object built without an
    // explicit mode must never open the gate.
    mode: deps.orchestratorMode ?? 'platform',
    trustResolution: trust.trustResolution,
    isForkPR: event.isForkPR ?? false,
  });

  if (securityDecision.action === 'ignore') {
    logger.info('Fork PR event ignored by org fork policy', {
      deliveryId: info.deliveryId,
      orgId: resolvedOrgId,
      repo: repoIdentifier,
      sender: event.senderUsername,
    });
    forkEventsIgnoredTotal.add(1, { provider: info.provider });
    // Same shape as the other no-dispatch exits (unknown provider, unknown
    // event type): the delivery is recorded, counted as skipped, and reported
    // to the ingress as `skipped`.
    webhooksProcessedTotal.add(1, { result: 'skipped' });
    await recordSkipEventLog(info, deps, resolvedOrgId, EventLogStatus.enum.received);
    return WebhookIngestOutcome.enum.skipped;
  }

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
        // The lock file that failed to parse is this repository's own, so the
        // failure is per-repository however the workflows inside it were
        // declared. No organization-wide workflow is in scope here: the global
        // arm runs against registrations, never against this file.
        workflowRepoIdentifier: repoIdentifier,
        // The run row's `ref` is the branch the run PRESENTS, matching what
        // `onExecutionStarted` writes everywhere else and what the context branch
        // gate evaluates. A job's checkout ref (the PR head branch) is a different
        // value and does not belong in this column.
        ref: event.targetBranch ?? ref,
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
    return WebhookIngestOutcome.enum.processed;
  }

  if (!lockOutcome.lockFile) {
    logger.debug('No lock file found for per-repo matching, checking global workflows', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      ref,
      lockFileSource: trust.lockFileSource,
    });
    // The trust-policy verdict is a property of the EVENT, not of one dispatch
    // path, so this branch enforces the same decision the lock-file path does.
    // It used to return before the policy was read at all, so a fork PR the
    // policy did not pass still ran the org's global workflows against its head
    // SHA with org credentials — the exact false assurance this gate exists to
    // remove.
    const globals = await tryDispatchGlobalsWithoutLockFile({
      info,
      deps,
      event,
      resolvedOrgId,
      repoIdentifier,
      ref,
      dispatchBundle: lockOutcome.dispatchBundle,
      dispatchCredentials: lockOutcome.dispatchCredentials,
      ...(lockOutcome.resolvedFallbackRoutingKey !== undefined && {
        dispatchRoutingKey: lockOutcome.resolvedFallbackRoutingKey,
      }),
      bundle,
      credentials,
      securityDecision,
    });
    const globalMatched = globals.matchedCount;
    // The organization-wide pass IS this delivery's evaluation, so its trace is
    // forwarded here exactly as Phase K forwards the lock-file path's. Without
    // it, the one delivery shape a global workflow is written for — a source
    // repository that declares no workflows of its own — reported nothing.
    sendDecisionTraceEvent({
      info,
      deps,
      repoIdentifier,
      ref,
      matchedCount: globalMatched,
      totalWorkflows: globals.decisionSummaries.length,
      decisions: globals.decisionSummaries,
    });
    // Terminal summary at parity with the lock-file path's `Webhook processed`
    // line below. This branch previously logged only a `debug` entry, so on
    // staging (which does not capture `debug`) a delivery that resolved no
    // per-repo lock file and matched no global workflow produced no run with
    // nothing above `debug` to say why — the class of silent drop that made a
    // gate-not-reached / no-match delivery undiagnosable from Loki.
    logger.info('Webhook processed (no per-repo lock file)', {
      deliveryId: info.deliveryId,
      event: info.event,
      repoIdentifier,
      ref,
      globalWorkflowsMatched: globalMatched,
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
    return WebhookIngestOutcome.enum.processed;
  }

  const fullLockFile = lockOutcome.lockFile as unknown as FullLockFile;

  // Called for the informational check it posts. Its returned report describes
  // what the diff found; no dispatch decision on this path reads it, because
  // the fork switch was already decided above.
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

  return matchDispatchAndRecordOutcome({
    info,
    deps,
    payload,
    event,
    fullLockFile,
    lockOutcome,
    trust,
    resolvedOrgId,
    repoIdentifier,
    ref,
    bundle,
    credentials,
    securityDecision,
  });
}
