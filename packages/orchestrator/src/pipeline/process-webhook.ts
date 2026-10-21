/**
 * Webhook processing pipeline. `processWebhook` (called from server.ts / app.ts)
 * threads typed phase results through:
 *
 *   dedup -> provider -> normalize -> (cross-source dispatch | per-repo path)
 *   per-repo path: extract repo + creds -> trust resolution -> lock file fetch
 *     -> (no lock file: global dispatch & return)
 *     -> security hold + workflow modifications -> default-branch registration
 *     -> match triggers -> dispatch matched same-source -> dispatch globals
 *     -> forward traces & event log
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createLogger,
  depCacheKeyOf,
  enrichRequestContext,
  toErrorMessage,
} from '@kici-dev/shared';
import type {
  LockFile as FullLockFile,
  LockJob,
  LockJobOrFactory,
  LockWorkflow,
  SimulatedEvent,
  LockFileParseError,
  LockContentRequirement,
  WorkflowDecision,
  FileContentsFetcher,
} from '@kici-dev/engine';
import {
  EventLogStatus,
  EventLogSource,
  InitFailureCategory,
  PLATFORM_CONNECTED_MODES,
  truncateReasonText,
} from '@kici-dev/engine';
import type { OrchestratorMode } from '@kici-dev/engine';
import { isLockDynamicJobFn, isLockStaticJob } from '@kici-dev/engine';
import { partitionMatchers } from '@kici-dev/engine';
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
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import { resolveRefTrust, type TrustResolution } from '../security/trust-resolver.js';
import {
  evaluateTrustPolicy,
  forkDropExplanation,
  resolveEffectivePolicy,
  trustPolicyOutcomeReason,
  READ_FAILURE_POLICY,
  EffectivePolicySource,
  type ForkSwitchContext,
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
import { dispatchMatchedWorkflow } from './dispatch-matched-workflow.js';
import {
  dispatchGlobalCandidateViaPipeline,
  type ResolvedGlobalCandidate,
  type RoundClearedCandidate,
} from './global-dispatch.js';
import { resumeWorkflow, rejectWorkflow } from './resume-workflow.js';
import {
  resolveEventChangedFiles,
  stampChangedFiles,
  withDefaultBranch,
  withoutCrossSourcePrDeferral,
  type ResolvedChangedFiles,
} from './changed-files.js';
import { withCrossSourceTally, type CrossSourceTally } from './cross-source-tally.js';
import { DEGRADED_CHANGED_FILES_REASON } from './degraded-reason.js';
import { holdGlobalEvalRounds } from './global-round-hold.js';
import { filterByContentRequirements } from './content-filter.js';
import {
  candidateKey,
  hasDeferredGenerator,
  isDeferredGenerator,
  isRoundGenerator,
  partitionCandidates,
  recordUnrunCandidates,
  runGlobalEvalRounds,
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
  anyTriggerHasPathPatterns,
  isDefaultBranchPush,
  extractDefaultBranch,
  summarizeDecision,
  capDecisionSummaries,
  buildTriggerEvent,
  extractCommitMessage,
  dispatchReadyJob,
  type ProcessingDeps,
} from './processor.js';
import { warnStaleCompileSchemas } from '../registration/compile-schema-staleness.js';

const logger = createLogger({ prefix: 'pipeline' });

// ---------------------------------------------------------------------------
// Tier-1 content-requirements filter (declarative `requires` static filter)
// ---------------------------------------------------------------------------

/**
 * The bundle's prebuilt file-contents fetcher, else one built from the delivery
 * credentials (e.g. a GitHub installation id); `undefined` when the provider has none.
 */
function resolveFileContentsFetcher(
  bundle: ProviderBundle,
  credentials: Record<string, unknown>,
): FileContentsFetcher | undefined {
  return bundle.fileContentsFetcher ?? bundle.fileContentsFetcherFactory?.(credentials);
}

/** The matched trigger's `requires`; only push/pr/tag triggers carry one. */
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
 * Tier-1 content filter over a lock file's own matched workflows: a dropped
 * workflow flips to `matched: false` so dispatch and the event log skip it. No
 * `requires` on any matched trigger means no fetch.
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
 * Tier-1 content filter for one matched global workflow whose lock entry lives
 * in another repo. `requires` reads the source event's repo at its ref, so it
 * shares the per-repo path's cache.
 *
 * Returns the decision (not a boolean) with the verdict appended to its trace,
 * so the caller can say WHY a workflow produced nothing. The drop's
 * `indeterminate` flag is carried over, so an unreadable file or a provider
 * with no fetcher traces as "nothing evaluated this", not as an author-caused
 * exclusion.
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
 * Outcome of one inbound-webhook ingestion. `duplicate` lets a direct-ingress
 * route return `{ duplicate: true }` to GitHub's Recent Deliveries panel;
 * `skipped` covers unknown provider / unknown event / no-repo paths;
 * `processed` means the pipeline matched and dispatched (or recorded a run).
 *
 * `queued` (the direct-ingress accept path) means the delivery is durably
 * stored and its pipeline runs after the response. It maps to the same 202 as
 * `processed` — to the sender both mean "accepted" — and exists so the accept
 * path can be asserted on directly rather than through the HTTP status.
 */
export const WebhookIngestOutcome = z.enum(['processed', 'queued', 'duplicate', 'skipped', 'shed']);
export type WebhookIngestOutcome = z.infer<typeof WebhookIngestOutcome>;

function skipReasonToOutcome(reason: 'duplicate' | 'unknown-provider'): WebhookIngestOutcome {
  return reason === 'duplicate'
    ? WebhookIngestOutcome.enum.duplicate
    : WebhookIngestOutcome.enum.skipped;
}

// ---------------------------------------------------------------------------
// Phase A — dedup + provider + normalize
// ---------------------------------------------------------------------------

/**
 * Resolve the org id for the inbound routing key, falling back to
 * `'__default__'` when the DB lookup fails (table missing in dev/test) so the
 * pre-tenant code paths still work.
 *
 * The failure is logged, not swallowed: `'__default__'` is the no-tenant
 * anchor, so the downgrade denies every org-scoped decision downstream
 * (global-workflow registration, the multi-provider lock fallback) with a
 * reason that reads as "the org has not opted in". Silently, a transient DB
 * fault would look like a deliberately unmapped source.
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

/** Record the event-log row for an early-return skip path. */
async function recordSkipEventLog(
  info: WebhookInfo,
  deps: ProcessingDeps,
  resolvedOrgId: string,
  status: EventLogStatus,
  /**
   * Why the delivery was skipped, when the status alone cannot say. Free-text
   * `errorMessage` avoids a new `EventLogStatus` member — a wire-enum change an
   * older dashboard could not render.
   */
  errorMessage?: string,
): Promise<void> {
  if (!deps.eventLog) return;
  await deps.eventLog.record(info, payloadFromObject(info.payload), {
    orgId: resolvedOrgId,
    source: deps.eventLogSource ?? EventLogSource.enum.direct,
    status,
    errorMessage,
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
 * Resolve the delivery's provider bundle, refreshing the registry from the
 * database first when the source's own bundle is missing.
 *
 * The registry is an in-memory CACHE of `generic_webhook_sources` filled by
 * startup enumeration, the admin write handler and the LISTEN/NOTIFY drain; a
 * delivery can beat all three. The miss is silent: a `generic:` key falls back
 * to the shared `generic:default` bundle, whose normalizer finds no repository
 * in EVERY payload, so the webhook is answered 202, matched against nothing,
 * and recorded as `received` with `matched_count = 0`.
 *
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

  // `false` is the steady state for a plain generic source (it uses the default
  // bundle), so only an actual repair is logged.
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
 * Phase A.1 — Dedup + provider lookup. Skip paths record their event log and
 * metric here so the caller can early-return.
 */
async function dedupAndResolveProvider(
  info: WebhookInfo,
  deps: ProcessingDeps,
): Promise<DedupAndProviderResult> {
  const resolvedOrgId = await resolveOrgIdSafe(deps, info.routingKey);

  // Atomic claim (false => duplicate): the single dedup chokepoint for the
  // relay, generic and direct GitHub ingestion paths, free of an
  // exists()-then-mark() race (see DedupCache.claim).
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

/** Phase A.2 — Normalise the event; `null` (skip recorded) for unknown event types. */
async function normalizeWebhookEvent(
  info: WebhookInfo,
  deps: ProcessingDeps,
  bundle: ProviderBundle,
  resolvedOrgId: string,
): Promise<SimulatedEvent | null> {
  const event = bundle.normalizer.normalizeEvent(info.event, info.action, info.payload);
  if (event) return withDefaultBranch(event, info.payload, bundle.normalizer);
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
   * 'event': matched via the webhook-event index (synthetic event).
   * 'repo': matched via the repo index (git triggers; normalized through the
   * registration's bundle).
   */
  matchMode: 'event' | 'repo';
}

/**
 * Phase B.1 — Refresh the registration index (a peer may have just inserted a
 * registration) and gather de-duplicated cross-source candidates. Same-source
 * registrations are left to the per-repo path, where the bundle cache +
 * `__build__` coordinator applies.
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
 * Event-mode candidates get a synthetic event typed with the inbound name;
 * repo-mode ones use the registration bundle's normalizer, so git-trigger
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
  const normalized = regBundleForNormalization.normalizer.normalizeEvent(
    inboundEventName,
    null,
    info.payload,
  );
  return normalized
    ? withDefaultBranch(normalized, info.payload, regBundleForNormalization.normalizer)
    : null;
}

/**
 * Phase B.2a — Resolve a repo-mode candidate's changed files through the
 * registration's own bundle and credentials. No `paths` trigger resolves to
 * `skipped` without a fetch; the rest share one resolve per (source,
 * repository) per delivery. A failure resolves `unavailable`, so one candidate
 * never aborts the fan-out.
 */
function resolveCrossSourceChangedFiles(args: {
  info: WebhookInfo;
  reg: RegisteredWorkflow;
  regBundle: ProviderBundle;
  syntheticEvent: SimulatedEvent;
  inboundEventName: string;
  changedFilesMemo: Map<string, Promise<ResolvedChangedFiles>>;
}): Promise<ResolvedChangedFiles> {
  const { info, reg, regBundle, syntheticEvent, inboundEventName, changedFilesMemo } = args;
  const resolveArgs = {
    bundle: regBundle,
    credentials: reg.providerContext,
    repoIdentifier: reg.repoIdentifier,
    eventName: inboundEventName,
    payload: info.payload,
    event: syntheticEvent,
  };
  const workflows = [reg.lockEntry as LockWorkflow];
  // A memoized answer must never be a `skipped` that a sibling registration
  // with `paths` would then read as "no diff".
  if (!anyTriggerHasPathPatterns(workflows)) {
    return resolveEventChangedFiles({ ...resolveArgs, workflows });
  }
  const key = `${reg.routingKey}\u0000${reg.repoIdentifier}`;
  let pending = changedFilesMemo.get(key);
  if (!pending) {
    pending = resolveEventChangedFiles(resolveArgs);
    changedFilesMemo.set(key, pending);
  }
  return pending;
}

/**
 * Phase B.2 — Dispatch one cross-source candidate via `dispatchMatchedWorkflow`.
 * A repo-mode candidate first resolves its changed files through the
 * registration's bundle, so its `paths` filters decide as the same-source
 * path's do. Fails fast unless the registration's bundle can mint a clone
 * token — it MUST NOT fall back to the inbound generic bundle, which has no
 * credentials for the registration's repo; dispatch mints the token again.
 * `degraded` means paths were evaluated against an unavailable diff.
 */
async function dispatchOneCrossSourceCandidate(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  candidate: CrossSourceCandidate;
  inboundEventName: string;
  /** Per-delivery changed-files memo, keyed by (routing key, repository). */
  changedFilesMemo: Map<string, Promise<ResolvedChangedFiles>>;
}): Promise<{ jobsDispatched: number; degraded: boolean }> {
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
    return { jobsDispatched: 0, degraded: false };
  }

  const regBundle = deps.providerRegistry.getByRoutingKey(reg.routingKey);
  const resolved =
    candidate.matchMode === 'repo' && regBundle
      ? await resolveCrossSourceChangedFiles({
          info,
          reg,
          regBundle,
          syntheticEvent,
          inboundEventName,
          changedFilesMemo: args.changedFilesMemo,
        })
      : undefined;
  // An event-mode candidate's `webhook()` trigger has no `paths`.
  const eventWithFiles = resolved
    ? stampChangedFiles(syntheticEvent, resolved)
    : { ...syntheticEvent, changedFiles: [] };
  const noDispatch = { jobsDispatched: 0, degraded: resolved?.status === 'unavailable' };

  const decisions = matchAllWorkflows([reg.lockEntry], eventWithFiles).map((d) =>
    withoutCrossSourcePrDeferral(d, eventWithFiles),
  );
  const matchedDecisions = decisions.filter((d) => d.matched);
  if (matchedDecisions.length === 0) return noDispatch;

  // One dedup slot per registration keeps re-delivery idempotent per fan-out target.
  const crossDedupKey = `${info.deliveryId}:${reg.id}`;
  if (!(await deps.dedup.claim(crossDedupKey))) {
    logger.debug('Cross-source dispatch: composite dedup hit', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
    });
    return noDispatch;
  }

  if (!regBundle) {
    logger.warn('Cross-source dispatch: registration bundle not found', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
      routingKey: reg.routingKey,
    });
    crossSourceErrorsTotal.add(1, { reason: 'bundle_missing' });
    return noDispatch;
  }

  // The token is not kept: the credentials persist with the run, its queued jobs
  // and any hold, and dispatch mints each job's clone auth through the same
  // bundle, keyed by the job's routing key.
  const crossSourceCredentials: Record<string, unknown> = { ...reg.providerContext };
  try {
    await regBundle.cloneTokenProvider?.createCloneToken(reg.repoIdentifier, reg.providerContext);
  } catch (err) {
    logger.error('Cross-source dispatch: clone token issuance failed', {
      deliveryId: info.deliveryId,
      registrationId: reg.id,
      routingKey: reg.routingKey,
      error: toErrorMessage(err),
    });
    crossSourceErrorsTotal.add(1, { reason: 'clone_token' });
    return noDispatch;
  }

  // Consult the policy through the shared evaluator rather than asserting a
  // verdict: a generic webhook normalizes to a non-PR event and short-circuits
  // to `pass` today, and this keeps a normalizer that ever yields a PR-shaped
  // event from becoming a silent bypass.
  //
  // This path resolves no trust, and a missing tier is not a denial: the switch
  // turns on `isForkPR`, so a non-fork event passes whatever the policy says. A
  // normalizer emitting PR-shaped events needs a fork signal it can stand
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

    // A single-workflow lockfile so the helper's lookup by name resolves.
    // lockfileHash is cleared so the dep cache check is a no-op; `crossSource`
    // also disables the bundle cache + build job path, because bundles
    // externalize @kici-dev/sdk and an eval job in a fresh temp dir cannot
    // resolve it. contentHash is kept for the agent's lock-file drift detection.
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
      // The inbound event supplies only the trigger; the registration's own repo
      // defines the workflow.
      workflowRepoIdentifier: reg.repoIdentifier,
      credentials: crossSourceCredentials,
      // Init and eval jobs recompute the diff from `event`; execution jobs
      // carry the resolved files.
      event: syntheticEvent,
      eventWithFiles,
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
        // Agents and the dashboard read these for clone + logging.
        crossSource: true,
        inboundRoutingKey: info.routingKey,
        inboundEventName,
        workflowRepoUrl: regBundle.repoUrlBuilder?.buildCloneUrl(reg.repoIdentifier) ?? '',
        // Empty so gitClone() clones the default branch; commitSha drives the
        // post-clone SHA verification + fetch-deepen path.
        workflowRef: '',
        workflowSha: reg.commitSha ?? '',
        workflowRepoIdentifier: reg.repoIdentifier,
      },
    });

    dispatchedCount += helperResult.dispatchedJobCount;
  }
  return { jobsDispatched: dispatchedCount, degraded: noDispatch.degraded };
}

/**
 * Phase B.3 — Forward the cross-source summary to Platform and log it. The
 * event-log row and processed metric belong to whichever half finishes the
 * delivery: `recordCrossSourceOnlyOutcome` for a plain generic delivery, the
 * same-source path otherwise.
 */
async function recordCrossSourceCompletion(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  inboundEventName: string;
  candidatesConsidered: number;
  jobsDispatched: number;
}): Promise<void> {
  const { info, deps, inboundEventName, candidatesConsidered, jobsDispatched } = args;
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

  logger.info('Cross-source webhook processed', {
    deliveryId: info.deliveryId,
    inboundEventName,
    registrationsConsidered: candidatesConsidered,
    jobsDispatched,
  });
}

/**
 * Phase B.4 — Processed metric and event-log row for a plain generic delivery
 * (no repository), where the cross-source half is the whole delivery. The row
 * carries no repo; `matched_count = jobsDispatched`.
 */
async function recordCrossSourceOnlyOutcome(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  tally: CrossSourceTally;
}): Promise<void> {
  const { info, deps, resolvedOrgId, tally } = args;
  webhooksProcessedTotal.add(1, {
    result: tally.jobsDispatched > 0 ? 'matched' : 'skipped',
  });
  if (deps.eventLog) {
    await deps.eventLog.record(info, payloadFromObject(info.payload), {
      orgId: resolvedOrgId,
      source: deps.eventLogSource ?? EventLogSource.enum.direct,
      status: EventLogStatus.enum.processed,
      matchedCount: tally.jobsDispatched,
      ...(tally.degraded && { errorMessage: DEGRADED_CHANGED_FILES_REASON }),
    });
  }
}

/**
 * Phase B (top-level) — Cross-source dispatch for inbound generic webhooks.
 *
 * Fans out to other sources' registrations in the SAME ORG, found by event
 * name (`webhook()` triggers) and by the payload's repository (git triggers,
 * whose `paths` filters resolve through the registration's own bundle).
 *
 * Writes no event-log row: the caller decides whether the same-source path
 * also runs (always, when the inbound normalizer reads a repository) and which
 * half records the delivery.
 */
async function dispatchCrossSourceWorkflows(
  info: WebhookInfo,
  deps: ProcessingDeps,
  event: SimulatedEvent,
  resolvedOrgId: string,
): Promise<CrossSourceTally> {
  // The generic normalizer sets type = 'generic_webhook' and puts the event
  // name in action.
  const inboundEventName = event.action ?? info.event;

  const candidates = await gatherCrossSourceCandidates(info, deps, resolvedOrgId, inboundEventName);

  // Recorded even at zero, to surface mis-configured event names.
  crossSourceFanoutSize.record(candidates.length, { event: inboundEventName });

  if (candidates.length === 0) {
    logger.debug('Cross-source: no registrations for event, falling through', {
      deliveryId: info.deliveryId,
      inboundEventName,
      orgId: resolvedOrgId,
    });
    return { candidatesConsidered: 0, jobsDispatched: 0, degraded: false };
  }

  const changedFilesMemo = new Map<string, Promise<ResolvedChangedFiles>>();
  let jobsDispatched = 0;
  let degraded = false;
  for (const candidate of candidates) {
    const outcome = await dispatchOneCrossSourceCandidate({
      info,
      deps,
      resolvedOrgId,
      candidate,
      inboundEventName,
      changedFilesMemo,
    });
    jobsDispatched += outcome.jobsDispatched;
    degraded ||= outcome.degraded;
  }

  await recordCrossSourceCompletion({
    info,
    deps,
    inboundEventName,
    candidatesConsidered: candidates.length,
    jobsDispatched,
  });
  return { candidatesConsidered: candidates.length, jobsDispatched, degraded };
}

/** How the same-source half proceeds after the cross-source half ran. */
type CrossSourceRouting =
  | { done: true }
  | {
      done: false;
      /** Fold the cross-source tally into the same-source event-log row. */
      deps: ProcessingDeps;
      /** The repository cross-source repo mode read registrations for, when it ran. */
      crossSourceRepo: string | null;
    };

/**
 * Phase B (routing) — Run the cross-source half of a generic delivery and
 * decide the same-source half. The halves are disjoint: cross-source
 * dispatches only other sources' registrations, and the inbound source's own
 * workflows always evaluate when its normalizer reads a repository.
 *
 * - A plain generic delivery with candidates finishes here, event-log row and
 *   metric included.
 * - A repository-reading delivery continues with deps that fold the tally into
 *   the single event-log row the same-source path writes.
 */
async function routeCrossSource(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  resolvedOrgId: string;
  bundle: ProviderBundle;
}): Promise<CrossSourceRouting> {
  const { info, deps, event, resolvedOrgId, bundle } = args;
  if (info.provider !== 'generic' || !deps.registrationIndex) {
    return { done: false, deps, crossSourceRepo: null };
  }
  const tally = await dispatchCrossSourceWorkflows(info, deps, event, resolvedOrgId);
  const crossSourceRepo = extractInboundRepoIdentifier(info.payload);
  if (tally.candidatesConsidered === 0) return { done: false, deps, crossSourceRepo };
  if (!bundle.normalizer.extractRepoIdentifier(info.payload)) {
    await recordCrossSourceOnlyOutcome({ info, deps, resolvedOrgId, tally });
    return { done: true };
  }
  return { done: false, deps: withCrossSourceTally(deps, tally), crossSourceRepo };
}

// ---------------------------------------------------------------------------
// Phase C — repo + credentials + /kici approval comments
// ---------------------------------------------------------------------------

interface RepoAndCredentials {
  repoIdentifier: string;
  credentials: Record<string, unknown>;
}

/** Phase C.1 — Repo + credentials; `null` (skip recorded) when the payload names no repo. */
async function extractRepoAndCredentials(
  info: WebhookInfo,
  deps: ProcessingDeps,
  bundle: ProviderBundle,
  resolvedOrgId: string,
): Promise<RepoAndCredentials | null> {
  const repoIdentifier = bundle.normalizer.extractRepoIdentifier(info.payload);
  if (!repoIdentifier) {
    // Names the normalizer to tell a plain generic source (no repository by
    // design) from a repo-bearing source resolved to the wrong bundle (a fault).
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
 * The deps' assembler, not the orchestrator mode, picks the source:
 *
 * - `server.ts` supplies the Platform-pushed in-memory directory (refreshed on
 *   every `trust_policy.update`), which wins outright — the row would be a
 *   superseded cache.
 * - Every other assembly supplies neither, including `app.ts`'s direct-ingress
 *   pipeline (an independent orchestrator's only path), where
 *   `kici-admin trust-policy directory-set` registrations live only in the row.
 *   Reading it per command makes a registration take effect immediately.
 *
 * A failed read degrades to an empty directory, so the command is refused —
 * the same fail-closed answer as an absent directory.
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
 * Phase C.2 — Handle `/kici approve|reject` in `issue_comment` events, BEFORE
 * trigger matching. The event still continues through trigger matching, for
 * workflows with issue_comment triggers.
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
    // Approving a security hold RUNS the gated work; otherwise the row flips and
    // a green check posts while nothing dispatches.
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
              contextData: () => deps,
            }
          : undefined,
      );
    },
    // The PR-wide trust-policy hold fires before any job exists: approval
    // replays the stored dispatch, rejection cancels the run and drops it.
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

export function isPullRequestEvent(eventName: string): boolean {
  return (
    eventName === 'pull_request' ||
    eventName === 'pull_request_review' ||
    eventName === 'pull_request_review_comment'
  );
}

function makeTrustedResolution(contributorUsername: string, reason: string): TrustResolution {
  return {
    tier: 'trusted',
    contributorUsername,
    reason,
  };
}

/**
 * Phase D — Resolve the trust tier from the git ref alone. Every base-repo ref
 * is trusted (only a write-or-higher contributor can put one there); a fork
 * head ref is the sole untrusted case and resolves to `unknown`.
 *
 * For PR events the tier picks the lock-file source (trusted: head; fork:
 * base) and the user-cache write scope (`deriveCacheRefScope`: `trusted` is
 * org-shared, everything else per-run isolated).
 *
 * A PR resolves a tier only for a provider with `hasForkModel` (GitHub), whose
 * fork signal comes from the forge's payload. universal-git's `isForkPR`
 * compares repo names from fixed keys (`repo.full_name`, falling back to
 * `full_name`, under `head` and `base`) that many forges omit, and yields
 * `false` when either is absent — it fails toward trust, so it cannot carry
 * HEAD-lock selection. Such a PR resolves no tier: base lock, isolated cache.
 */
export async function resolveTrustForPR(args: {
  info: WebhookInfo;
  bundle: ProviderBundle;
  event: SimulatedEvent;
  /** Raw webhook payload — read only to decide whether a push targets the default branch. */
  payload: Record<string, unknown>;
}): Promise<TrustOutcome> {
  const { info, bundle, event, payload } = args;
  const isPREvent = isPullRequestEvent(info.event);

  // Only a write-or-higher contributor can push the default branch; trusted
  // gives the `shared` user-cache write scope.
  if (!isPREvent && isDefaultBranchPush(info, event, payload, bundle.normalizer)) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Push to the default branch -- trusted ref (org-shared cache scope)',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // No fork concept: for generic sources the verification secret is the trust
  // boundary; for local sources the operator owns the on-disk repo.
  if (!isPREvent && !bundle.hasForkModel) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Non-PR event from a fork-less provider (generic/local) -- trusted ref',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // A branch or tag push is a same-repo ref only a write-or-higher contributor
  // can create.
  if (!isPREvent) {
    return {
      trustResolution: makeTrustedResolution(
        event.senderUsername ?? '',
        'Non-default-branch push — same-repo ref, trusted by construction',
      ),
      lockFileSource: selectLockFileSource(isPREvent, undefined),
    };
  }

  // No tier: this provider's `isForkPR` fails toward trust (see the JSDoc).
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
  /** A lock file was present but unparseable and nothing else resolved (lock_resolution init failure). */
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
 * Phase E.1 — A lock file is present but unparseable and nothing else
 * resolved: record a `lock_resolution` init-failure run and the
 * `lockfile_corrupt` event-log row.
 */
async function recordCorruptLockFile(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  event: SimulatedEvent;
  payload: Record<string, unknown>;
  resolvedOrgId: string;
  repoIdentifier: string;
  credentials: Record<string, unknown>;
  ref: string;
  corruptError: LockFileParseError | undefined;
}): Promise<void> {
  const { info, deps, event, payload, resolvedOrgId, repoIdentifier, credentials, ref } = args;
  const corruptRunId = randomUUID();
  const message =
    args.corruptError?.message ?? `Lock file for ${repoIdentifier} could not be parsed`;
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
      // The unparseable lock is this repo's own, so the failure is per-repository;
      // the global arm runs against registrations, never this file.
      workflowRepoIdentifier: repoIdentifier,
      // The branch the run PRESENTS (as `onExecutionStarted` writes and the
      // context branch gate evaluates), not a job's checkout ref.
      ref: event.targetBranch ?? ref,
      // The commit SHA is unknown; the resolved ref is the best locator.
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
}

/**
 * Phase E — Fetch the lock file: the inbound bundle's fetcher first, then other
 * same-customer registrations for this repo. On fallback the dispatch bundle
 * and credentials swap to the winning bundle — otherwise file:// URLs leak from
 * the local bundle and clone-token issuance fails.
 *
 * For PR events evaluated against base, base + head lock files are fetched in
 * parallel; head feeds workflow modification detection.
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
  /** False when cross-source repo mode already evaluated this repository's registrations. */
  allowRegistrationFallback: boolean;
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
  const resolveArgs = {
    inboundBundle: bundle,
    inboundRoutingKey: info.routingKey,
    repoIdentifier,
    inboundCredentials: credentials,
    customerId: resolvedOrgId,
    providerRegistry: deps.providerRegistry,
    registrationIndex: deps.registrationIndex,
    lockFileCache: deps.lockFileCache,
    deliveryId: info.deliveryId,
    allowRegistrationFallback: args.allowRegistrationFallback,
  };

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
      resolveLockFileWithFallback({ ...resolveArgs, ref: baseBranchRef }),
      resolveLockFileWithFallback({ ...resolveArgs, ref }),
    ]);
    lockFile = baseResult.lockFile;
    // The base result is the one short-circuited on; surface its corrupt outcome.
    corrupt = baseResult.resolvedVia === 'corrupt';
    corruptError = baseResult.corruptError;
    headLockFileForDiff = headResult.lockFile as unknown as FullLockFile | undefined;
    // Prefer base's fallback bundle (base drives matching), else head's.
    const fbSource = baseResult.resolvedVia === 'fallback' ? baseResult : headResult;
    if (fbSource.resolvedVia === 'fallback' && fbSource.fallbackBundle) {
      resolvedFallbackBundle = fbSource.fallbackBundle;
      resolvedFallbackCredentials = fbSource.fallbackCredentials;
      resolvedFallbackRoutingKey = fbSource.fallbackRoutingKey;
    }
  } else {
    const result = await resolveLockFileWithFallback({ ...resolveArgs, ref });
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
 * Eval-round budgets for a hand-built deps object that carries none. Cluster
 * defaults come from `config.ts` via `ProcessingDeps`; live per-cluster
 * overrides are read once per round.
 */
const FALLBACK_GLOBAL_EVAL_ROUND_TIMEOUT_MS = 120_000;
const FALLBACK_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS = 20_000;
const FALLBACK_GLOBAL_EVAL_WAIT_TIMEOUT_MS = 240_000;

function staticJobsOf(lockEntry: LockWorkflow): LockJob[] {
  return lockEntry.jobs.filter(isLockStaticJob);
}

/**
 * A round-cleared candidate's jobs: static, round-generated, and result-aware
 * generators (run on the pipeline's deferred path with upstream outputs).
 */
function roundClearedJobsOf(
  lockEntry: LockWorkflow,
  generated: readonly LockJob[] | undefined,
): LockJobOrFactory[] {
  return [
    ...staticJobsOf(lockEntry),
    ...(generated ?? []),
    // fails-when: a result-aware generator is dropped from a round-cleared workflow
    // breaks-if-wrong: a needs-free generator must never reach the pipeline unexpanded
    ...lockEntry.jobs.filter(isDeferredGenerator),
  ];
}

/**
 * A candidate that skipped the round: everything but a needs-free generator,
 * which only the round may run (it carries none).
 */
function immediateJobsOf(lockEntry: LockWorkflow): LockJobOrFactory[] {
  return lockEntry.jobs.filter((job) => !isRoundGenerator(job));
}

/**
 * Adapt the dispatcher onto the round's narrower surface. `DispatchResult`'s
 * `rejected` variant has no `jobId`; the round refuses every status outside its
 * accepted set before reading the id, so the placeholder only reaches a path
 * that has already thrown.
 */
function toRoundDispatcher(dispatcher: ProcessingDeps['dispatcher']): GlobalEvalDispatcher {
  return {
    dispatch: async (input) => {
      const result = await dispatcher.dispatch(input);
      return { status: result.status, jobId: 'jobId' in result ? result.jobId : '' };
    },
    // On a ceiling breach the round abandons its wait; without this the queue
    // row survives and runs a dual checkout for nobody.
    cancelQueuedJob: (jobId, reason) => dispatcher.cancelQueuedJob(jobId, reason),
  };
}

/**
 * Stamp `sourceRepo` — the only field naming the event's repository, which
 * both trigger matching and the dispatched job of an organization-wide
 * workflow need. The lock-file path stamps it while gathering changed files
 * and the no-lock-file path does not, so this keeps the two paths' events
 * identical. Idempotent; an already-stamped event is returned as-is.
 */
function withSourceRepo(event: SimulatedEvent, repoIdentifier: string): SimulatedEvent {
  return event.sourceRepo === repoIdentifier ? event : { ...event, sourceRepo: repoIdentifier };
}

/**
 * Summarize a global decision for Platform forwarding, tagged with its defining
 * repo: a global workflow is absent from the source repo's lock file, so its
 * name alone does not say where it came from.
 */
function summarizeGlobalDecision(
  decision: WorkflowDecision,
  workflowRepoIdentifier: string,
): Record<string, unknown> {
  return { ...summarizeDecision(decision), workflowRepoIdentifier };
}

interface GlobalCandidateCollection {
  candidates: GlobalEvalCandidate[];
  /** One summary per global decision evaluated, matched or not. */
  decisionSummaries: Record<string, unknown>[];
  /**
   * Workflow repos whose registrations cleared the policy and reached trigger
   * matching, candidate or not. The universe of the pass's positive signal: a
   * repo never reached (no index, a policy denial) can never be reported decided.
   */
  consideredWorkflowRepos: string[];
}

/**
 * Match this event against every org global workflow authored in ANOTHER repo
 * and return the candidates that survive the org policy and the Tier-1
 * `requires` filter. Shared by Phase F and Phase J so the gates cannot diverge
 * into a silent policy hole on one path.
 */
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
   * Only registrations authored in this repo. A failed round's re-run uses it:
   * other repos' globals already reached their verdict on the original
   * delivery and must not be evaluated or dispatched again.
   */
  onlyWorkflowRepo?: string;
  /** The registrations to evaluate instead of the index's; see {@link dispatchGlobalWorkflowsForOtherRepos}. */
  registrations?: readonly RegisteredWorkflow[];
}): Promise<GlobalCandidateCollection> {
  const { info, deps, event, resolvedOrgId, repoIdentifier, ref, dispatchBundle } = args;
  const decisionSummaries: Record<string, unknown>[] = [];
  const consideredWorkflowRepos = new Set<string>();
  const registrationIndex = deps.registrationIndex;
  if (!registrationIndex) return { candidates: [], decisionSummaries, consideredWorkflowRepos: [] };

  const triggerType = eventTypeToTriggerType(info.event);
  const globalRegistrations =
    args.registrations ??
    registrationIndex.getGlobalByOrgAndTriggerType(resolvedOrgId, triggerType);

  const candidates: GlobalEvalCandidate[] = [];
  const droppedByRepoFilter: RepoFilterDrop[] = [];
  for (const reg of globalRegistrations) {
    // The event's own repo is matched via the lock-file path.
    if (reg.repoIdentifier === repoIdentifier) continue;

    if (args.onlyWorkflowRepo !== undefined && reg.repoIdentifier !== args.onlyWorkflowRepo) {
      continue;
    }

    if (deps.globalWorkflowPolicy) {
      // One org_settings row per org, keyed by `customer_id`. Deny entries match
      // the EVENT's routing key (its own source); allow / elevate entries match
      // the WORKFLOW's (where it was authored).
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

    // Past every gate that suppresses without deciding: from here the pass
    // reaches a real outcome for this repo's workflow.
    consideredWorkflowRepos.add(reg.repoIdentifier);

    const globalDecisions = matchAllWorkflows(
      [reg.lockEntry],
      withSourceRepo(event, repoIdentifier),
    );

    for (const gDecision of globalDecisions) {
      if (!gDecision.matched) {
        decisionSummaries.push(summarizeGlobalDecision(gDecision, reg.repoIdentifier));
        // Collect `repos` mismatches (logged once per delivery, see
        // logGlobalReposFilterDrops) so a global that never fires for a repo is
        // distinguishable from an unregistered one. Other unmatched triggers
        // (wrong event, wrong branch) are the ordinary case and not collected.
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

interface RepoFilterDrop {
  workflow: string;
  workflowRepo: string;
  /** The declared include / exclude pattern set, as the trace entry rendered it. */
  repos: string;
}

/**
 * The `repos` pattern set that rejected this workflow, if any. Triggers are a
 * disjunction, so this is one reason among possibly several — but the caller
 * has established nothing matched, so it genuinely names a reason.
 */
function repoFilterRejectionOf(decision: WorkflowDecision): string | undefined {
  const rejected = decision.checks.find(
    (check) => check.check === TraceCheck.RepoFilter && !check.passed,
  );
  return rejected?.pattern;
}

/**
 * Report, once per delivery, every global workflow the event's repo did not
 * match — otherwise "registered and enabled but never ran here" is
 * byte-identical to never registered.
 *
 * Aggregated: `repos: ['myorg/service-*']` drops on every delivery from every
 * other repo (steady state), so a line per workflow would bury the exclusions
 * that DO warrant detail (`requires`, `filter`). One `info` line per delivery
 * keeps the answer findable without re-running at a raised level.
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
 * What an operator changes to make the registration policy admit.
 *
 * The master switch is fleet-wide (`cluster_settings.global_workflows_enabled`,
 * via `kici-admin cluster-settings`); the anchor has no per-org opt-in. An
 * exclusion under `'__default__'` means the fleet switch is off or the
 * allow-list excludes the repo — and, separately, that the routing key mapped
 * to no `sources` / `generic_webhook_sources` / `remote_sources` row with a
 * `customer_id`. Both remedies are named, since only the operator knows whether
 * the missing mapping is the real problem.
 */
function remedyForRegistrationExclusion(orgId: string, routingKey: string): string {
  const enable =
    'enable global workflows cluster-wide ' +
    '(kici-admin cluster-settings set --global-workflows-enabled true)';
  return orgId === '__default__'
    ? `the event resolved to the '__default__' org anchor, so no source maps ` +
        `${routingKey} to an organization: map it ` +
        `(kici-admin source update ${routingKey} --org <org>), and ` +
        `${enable} if it is not already`
    : `${enable}, and allow-list the authoring repo for ${orgId} ` +
        `(kici-admin org-settings global-workflows allow-add <pattern> --org ${orgId})`;
}

/**
 * Report, once per registering push, every global workflow the org policy
 * refused to register, by name — the registration-time sibling of
 * {@link logGlobalReposFilterDrops}. Without it the outcome is byte-identical
 * to "this repo declares no global workflows", and the exclusion happens on
 * the AUTHORING repo's push, hours or days before the source event whose
 * absence gets investigated.
 *
 * Carries the org, which the policy's reason never names, so a denial under
 * the `'__default__'` anchor is not misread as about the operator's own org.
 *
 * At `warn`, unlike the steady-state repos-filter drop: refused globals are an
 * anomaly the author committed and the org will not honour.
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
 * Emit the full decision trace for a global workflow that produced nothing. An
 * exclusion by `requires` or `filter` leaves no run row, check or artifact; the
 * trace carries every check that ran, passed ones included, so it reads on its
 * own. `repos` mismatches go to {@link logGlobalReposFilterDrops}.
 *
 * Emitted beside the per-exclusion lines, not folded into them: the Loki
 * dashboards key off those messages and fields.
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

interface ResolvedRoundCandidates {
  resolved: RoundClearedCandidate[];
  /** One summary per candidate the round excluded, carrying its `filter` entry. */
  decisionSummaries: Record<string, unknown>[];
  /**
   * Workflow repo of every round this pass could not decide — reported, not
   * derived from run rows, so a failed round's re-run can tell a clean
   * re-evaluation from another failure without reading the database.
   */
  roundFailureWorkflowRepos: string[];
  /**
   * Workflow repo of every candidate suppressed WITHOUT a verdict (no
   * pending-eval tracker, nothing reported back, or indeterminate). A superset
   * of {@link roundFailureWorkflowRepos}, and the only list that can subtract
   * such a repo from the pass's positive signal.
   */
  unresolvedWorkflowRepos: string[];
}

/**
 * Cap on a failed round's check summary, in characters. GitHub rejects an
 * `output.summary` over 65535 with a 422 and the post is best-effort, so an
 * oversize summary makes the check vanish. Capping the finished string bounds
 * both unbounded inputs: agent-authored `failure.error` and the workflow-name
 * list.
 */
const MAX_CHECK_SUMMARY_CHARS = 65_000;

/**
 * A failed round's account, naming every workflow it suppressed; shared by the
 * errored run row and the commit check so the two cannot disagree.
 */
function failedEvalRoundSummary(failure: GlobalEvalRoundFailure): string {
  const names = failure.workflowNames.map((name) => `\`${name}\``).join(', ');
  // `attempts: 0` means the round was never dispatched, so there are no job
  // logs to point at. A partial round dispatched its other candidates, so only
  // the undecided ones are named.
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
 * check on the source SHA — **per round, not per candidate**, since the round
 * exists to collapse N workflows into one job. The record names all of them.
 *
 * Both writes are best-effort: the workflows are already recorded
 * indeterminate, and failing the delivery would lose its `event_log` row too.
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
      // The round job's name, so run row, `dispatch_queue` row and logs match.
      workflowName: `${ROUND_JOB_PREFIX}${failure.workflowRepoIdentifier}`,
      provider: info.provider,
      repoIdentifier,
      // The branch the run PRESENTS (as `onExecutionStarted` writes and the
      // context branch gate evaluates), not a job's checkout ref.
      ref: args.event.targetBranch ?? '',
      sha: ref,
      deliveryId: info.deliveryId,
      providerContext: args.dispatchCredentials,
      routingKey: info.routingKey,
      // A re-run needs the bundle these credentials belong to, which for a
      // cross-provider global is not the event's source.
      ...(args.dispatchRoutingKey !== undefined && {
        dispatchRoutingKey: args.dispatchRoutingKey,
      }),
      failureReason: summary,
      triggerEvent: info.event,
      // Without it the failed round reads as an ordinary per-repository run.
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

  // A re-run re-evaluates the original event, so its payload must survive with
  // the run row. Best-effort.
  await storeWebhookPayload({
    logStorage: deps.logStorage,
    runId: failure.runId,
    payload: info.payload,
  });

  // Through the INBOUND bundle and credentials: the check lands on the inbound
  // repo, and a lock-file fallback's dispatch bundle belongs to another source.
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
 * Run the Tier-2 eval round for every candidate with a `filter` or a
 * `DynamicJobFn`; return the survivors with their resolved jobs.
 *
 * A candidate not cleared (`run` not `true`, indeterminate, or a failed round)
 * dispatches nothing: only the agent may run author code, so a verdict we could
 * not obtain is not one to act on.
 *
 * A cache hit returns the verdict's `jobs` by reference, so they are copied
 * into a fresh array, never mutated — or the next redelivery replays the mutation.
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
    // Fail closed: without the tracker the round never settles, and an
    // unevaluated `filter` must not dispatch.
    logger.warn('Global workflows needing an eval round skipped: no pending-eval tracker', {
      deliveryId: info.deliveryId,
      sourceRepo: repoIdentifier,
      workflows: candidates.map((candidate) => candidate.lockEntry.name),
    });
    // Counted in the round's metrics so an operator can alert on it.
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
      // Deliberately not a round failure, but it decided nothing: reported so
      // the empty failure list is not read as a clean evaluation.
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
    ...(args.dispatchRoutingKey !== undefined && { dispatchRoutingKey: args.dispatchRoutingKey }),
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

  const resolved: RoundClearedCandidate[] = [];
  const unresolvedWorkflowRepos = new Set<string>();
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidateKey(candidate));
    // A missing or indeterminate verdict is not a decision.
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
      // `filter` returns only a boolean from an agent; the trace is the only
      // record of its exclusion.
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
      jobs: roundClearedJobsOf(candidate.lockEntry, verdict.jobs),
    });
  }
  return {
    resolved,
    decisionSummaries,
    roundFailureWorkflowRepos,
    unresolvedWorkflowRepos: [...unresolvedWorkflowRepos],
  };
}

interface GlobalDispatchOutcome {
  matchedCount: number;
  matchedRunIds: string[];
  /** One summary per global decision this pass reached, dispatched or excluded. */
  decisionSummaries: Record<string, unknown>[];
  /** Workflow repo of every round this pass could not decide. */
  roundFailureWorkflowRepos: string[];
  /**
   * Every workflow repo this pass reached a real outcome for (dispatched,
   * filtered out, or excluded by a verdict) — the POSITIVE signal a re-run gates
   * its success check on. An empty `roundFailureWorkflowRepos` cannot carry it:
   * a pass with no registration index, no pending-eval tracker, or a held event
   * evaluates nothing and reports no failure either.
   */
  decidedWorkflowRepos: string[];
}

/**
 * The error message if a round-cleared candidate's jobs cannot be materialized.
 *
 * A generated job is proven only to carry a usable `name`, so a malformed label
 * matcher throws at materialization; checking here bounds that to its own
 * workflow, while the pipeline's own throws (infrastructure faults) propagate.
 * An unexpandable matrix is left to the pipeline, which records a failed job.
 */
function generatedJobsBuildError(jobs: readonly LockJobOrFactory[]): string | undefined {
  try {
    // A result-aware generator is expanded later; everything else is checked,
    // including a generated job missing `_type`.
    for (const job of jobs) {
      if (isLockDynamicJobFn(job)) continue;
      partitionMatchers(job.runsOn ?? []);
      partitionMatchers(job.excludeLabels ?? []);
    }
    return undefined;
  } catch (err) {
    return toErrorMessage(err);
  }
}

/**
 * Split candidates into those the round decides, those dispatched now, and
 * those held with the round.
 *
 * A held event holds every generator-carrying candidate with its workflow
 * repo's round, result-aware-only ones included, so one approval releases
 * them. Releasing that hold (`onlyRoundCandidates` + `releasedHold`) dispatches
 * exactly those beside the round's, whenever the hold was recorded, and never a
 * static-only candidate, which was held on its own.
 */
function splitForPass(args: {
  candidates: readonly GlobalEvalCandidate[];
  securityDecision: TrustPolicyOutcome;
  onlyRoundCandidates?: boolean;
  releasedHold?: boolean;
}): {
  needsRound: GlobalEvalCandidate[];
  immediate: GlobalEvalCandidate[];
  heldWithRound: GlobalEvalCandidate[];
} {
  const partitioned = partitionCandidates(args.candidates);
  const deferredOnly = partitioned.immediate.filter((c) => hasDeferredGenerator(c.lockEntry));
  const staticOnly = partitioned.immediate.filter((c) => !hasDeferredGenerator(c.lockEntry));
  // fails-when: releasing a held round drops a result-aware-only candidate it held
  // breaks-if-wrong: a static-only candidate, held on its own, must not dispatch again on release
  // fails-when: a failed round's re-run dispatches a result-aware-only candidate the delivery already dispatched
  if (args.onlyRoundCandidates === true) {
    return {
      needsRound: partitioned.needsRound,
      immediate: args.releasedHold === true ? deferredOnly : [],
      heldWithRound: [],
    };
  }
  if (args.securityDecision.action === 'hold') {
    return {
      needsRound: partitioned.needsRound,
      immediate: staticOnly,
      heldWithRound: deferredOnly,
    };
  }
  return {
    needsRound: partitioned.needsRound,
    immediate: partitioned.immediate,
    heldWithRound: [],
  };
}

interface GlobalPassDispatchArgs {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  event: SimulatedEvent;
  repoIdentifier: string;
  ref: string;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  /** The source `dispatchCredentials` belongs to, when it is not the inbound one. */
  dispatchRoutingKey?: string;
  /** The event's trust resolution, recorded on each global run. */
  trustResolution: TrustResolution | undefined;
  /** The event's trust-policy verdict, applied to each global run. */
  securityDecision: TrustPolicyOutcome;
  dispatchLogMessage: string;
}

async function dispatchResolvedGlobal(
  args: GlobalPassDispatchArgs,
  resolved: ResolvedGlobalCandidate,
): Promise<string | undefined> {
  const runId = await dispatchGlobalCandidateViaPipeline({
    info: args.info,
    deps: args.deps,
    payload: args.info.payload,
    sourceBundle: args.dispatchBundle,
    ...(args.dispatchRoutingKey !== undefined && { sourceRoutingKey: args.dispatchRoutingKey }),
    sourceRepoIdentifier: args.repoIdentifier,
    sourceCredentials: args.dispatchCredentials,
    event: args.event,
    eventWithFiles: args.event,
    ref: args.ref,
    resolvedOrgId: args.resolvedOrgId,
    trustResolution: args.trustResolution,
    securityDecision: args.securityDecision,
    resolved,
  });
  if (runId !== undefined) {
    logger.info(args.dispatchLogMessage, {
      deliveryId: args.info.deliveryId,
      runId,
      workflow: resolved.candidate.lockEntry.name,
      sourceRepo: args.repoIdentifier,
      workflowRepo: resolved.candidate.reg.repoIdentifier,
      action: args.securityDecision.action,
    });
  }
  return runId;
}

/**
 * Repos a pass under a non-passing verdict decided: only those with nothing to
 * run. A repo with a candidate was held, rejected or ignored with the event,
 * so nothing was evaluated and a re-run must not read it as a clean verdict.
 */
function undecidedUnderPolicy(
  considered: readonly string[],
  candidates: readonly GlobalEvalCandidate[],
): string[] {
  const withCandidates = new Set(candidates.map((candidate) => candidate.reg.repoIdentifier));
  // fails-when: a repository whose candidates were held counts as decided
  // breaks-if-wrong: a repository with no matching candidate is still decided
  return [...new Set(considered)].filter((repo) => !withCandidates.has(repo));
}

/**
 * Settle round candidates of an event that did not pass the trust policy. No
 * round runs: it would execute the workflow repo's code next to the event's
 * head before anyone approved the event.
 *
 * - `hold` records one held round run per workflow repo, released through the
 *   security queue.
 * - `reject` and `ignore` go to the pipeline with the lock file's job list,
 *   where the trust gate records a rejected run or nothing. Neither reaches a job.
 */
async function withholdRoundCandidates(
  args: GlobalPassDispatchArgs & {
    bundle?: ProviderBundle;
    credentials?: Record<string, unknown>;
  },
  needsRound: readonly GlobalEvalCandidate[],
): Promise<{ runIds: string[]; decisionSummaries: Record<string, unknown>[] }> {
  const decisionSummaries: Record<string, unknown>[] = [];
  const decision = args.securityDecision;
  if (decision.action === 'ignore' || needsRound.length === 0) {
    return { runIds: [], decisionSummaries };
  }
  for (const candidate of needsRound) {
    if (candidate.decision) {
      decisionSummaries.push(
        summarizeGlobalDecision(candidate.decision, candidate.reg.repoIdentifier),
      );
    }
  }
  if (decision.action === 'hold') {
    const runIds = await holdGlobalEvalRounds({
      info: args.info,
      deps: args.deps,
      event: args.event,
      candidates: needsRound,
      repoIdentifier: args.repoIdentifier,
      ref: args.ref,
      resolvedOrgId: args.resolvedOrgId,
      dispatchCredentials: args.dispatchCredentials,
      ...(args.dispatchRoutingKey !== undefined && { dispatchRoutingKey: args.dispatchRoutingKey }),
      bundle: args.bundle ?? args.dispatchBundle,
      credentials: args.credentials ?? args.dispatchCredentials,
      trustResolution: args.trustResolution,
      decision,
    });
    return { runIds, decisionSummaries };
  }
  const runIds: string[] = [];
  for (const candidate of needsRound) {
    const runId = await dispatchResolvedGlobal(args, {
      candidate,
      jobs: candidate.lockEntry.jobs,
    });
    if (runId !== undefined) runIds.push(runId);
  }
  return { runIds, decisionSummaries };
}

/**
 * Dispatch the matched candidates — those the lock file fully describes and
 * those the eval round decides — through the shared pipeline. The trust-policy
 * verdict applies as for per-repository runs: `pass` dispatches, `hold` parks
 * in the security queue, `reject` records a failed run. Shared by Phase F and
 * Phase J, which differ only in the dispatch log line.
 */
async function dispatchGlobalCandidates(
  args: GlobalPassDispatchArgs & {
    candidates: readonly GlobalEvalCandidate[];
    /** The inbound event's own bundle + credentials, used to post the failed-round check. */
    bundle?: ProviderBundle;
    credentials?: Record<string, unknown>;
    /**
     * {@link GlobalCandidateCollection.consideredWorkflowRepos}: the universe of
     * `decidedWorkflowRepos`. Defaults to the candidates' repos, which omits a
     * repo whose every registration was filtered out.
     */
    consideredWorkflowRepos?: readonly string[];
    /** See the same option on {@link dispatchGlobalWorkflowsForOtherRepos}. */
    onlyRoundCandidates?: boolean;
    /** See the same option on {@link dispatchGlobalWorkflowsForOtherRepos}. */
    releasedHold?: boolean;
    /** See the same option on {@link dispatchGlobalWorkflowsForOtherRepos}. */
    admitRoundVerdicts?: () => Promise<boolean>;
  },
): Promise<GlobalDispatchOutcome> {
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
      // Trigger matching alone decided every examined repo.
      decidedWorkflowRepos: [...new Set(considered)],
    };

  const { needsRound, immediate, heldWithRound } = splitForPass(args);

  // No `filter` and no needs-free `DynamicJobFn`: static jobs dispatch now,
  // result-aware generators wait on the pipeline's deferred path.
  for (const candidate of immediate) {
    const runId = await dispatchResolvedGlobal(args, {
      candidate,
      jobs: immediateJobsOf(candidate.lockEntry),
    });
    if (runId !== undefined) matchedRunIds.push(runId);
    if (candidate.decision) {
      decisionSummaries.push(
        summarizeGlobalDecision(candidate.decision, candidate.reg.repoIdentifier),
      );
    }
  }

  if (args.securityDecision.action !== 'pass') {
    const withheld = await withholdRoundCandidates(args, [...needsRound, ...heldWithRound]);
    matchedRunIds.push(...withheld.runIds);
    decisionSummaries.push(...withheld.decisionSummaries);
    return {
      matchedCount: matchedRunIds.length,
      matchedRunIds,
      decisionSummaries,
      roundFailureWorkflowRepos: [],
      decidedWorkflowRepos: undecidedUnderPolicy(considered, args.candidates),
    };
  }

  const round = await resolveRoundCandidates({ ...args, candidates: needsRound });
  decisionSummaries.push(...round.decisionSummaries);
  // fails-when: a round whose release was cancelled while it ran still dispatches what it admitted
  // breaks-if-wrong: a release still in its claimed state must dispatch the admitted jobs
  const admitted =
    round.resolved.length === 0 || args.admitRoundVerdicts === undefined
      ? round.resolved
      : (await args.admitRoundVerdicts())
        ? round.resolved
        : [];
  const unresolved = new Set(round.unresolvedWorkflowRepos);
  if (admitted !== round.resolved) {
    logger.info('Global eval round verdicts withdrawn before dispatch', {
      deliveryId: args.info.deliveryId,
      workflows: round.resolved.map((r) => r.candidate.lockEntry.name),
    });
    for (const r of round.resolved) unresolved.add(r.candidate.reg.repoIdentifier);
  }
  for (const resolved of admitted) {
    const buildError = generatedJobsBuildError(resolved.jobs);
    if (buildError !== undefined) {
      logger.error('Global workflow dispatch failed after eval round', {
        deliveryId: args.info.deliveryId,
        workflow: resolved.candidate.lockEntry.name,
        workflowRepo: resolved.candidate.reg.repoIdentifier,
        sourceRepo: args.repoIdentifier,
        error: buildError,
      });
      // A matched workflow stays in the trace, or it looks never registered.
      if (resolved.candidate.decision) {
        decisionSummaries.push(
          summarizeGlobalDecision(
            appendChecks(resolved.candidate.decision, [
              createDispatchFailureTraceEntry(`Jobs could not be built: ${buildError}`),
            ]),
            resolved.candidate.reg.repoIdentifier,
          ),
        );
      }
      continue;
    }
    const runId = await dispatchResolvedGlobal(args, resolved);
    if (runId !== undefined) matchedRunIds.push(runId);
    if (resolved.candidate.decision) {
      decisionSummaries.push(
        summarizeGlobalDecision(resolved.candidate.decision, resolved.candidate.reg.repoIdentifier),
      );
    }
  }

  return {
    matchedCount: matchedRunIds.length,
    matchedRunIds,
    decisionSummaries,
    roundFailureWorkflowRepos: round.roundFailureWorkflowRepos,
    decidedWorkflowRepos: [...new Set(considered)].filter((repo) => !unresolved.has(repo)),
  };
}

/**
 * Phase F — No lock file for this repo: try global workflows in the SAME ORG
 * that target this event type. Returns the dispatched count (metrics + event
 * log) and the decision summaries the caller forwards as the delivery's trace.
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
  /** The inbound event's own bundle + credentials, used to post the failed-round check. */
  bundle: ProviderBundle;
  credentials: Record<string, unknown>;
  /** The event's trust resolution, recorded on each global run. */
  trustResolution: TrustResolution | undefined;
  /** The event's trust-policy verdict, applied to each global run. */
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
  } = args;
  if (!deps.registrationIndex) return { matchedCount: 0, decisionSummaries: [] };

  if (deps.registrationStore) {
    const remoteVersion = await deps.registrationStore.getVersion();
    await deps.registrationIndex.refreshIfNeeded(remoteVersion);
  }

  // So a global workflow's `paths` filter decides against the real diff.
  const triggerType = eventTypeToTriggerType(info.event);
  const globalLockEntries = deps.registrationIndex
    .getGlobalByOrgAndTriggerType(resolvedOrgId, triggerType)
    .map((reg) => reg.lockEntry as LockWorkflow);
  const resolved = await resolveEventChangedFiles({
    bundle: dispatchBundle,
    credentials: dispatchCredentials,
    repoIdentifier,
    eventName: info.event,
    payload: info.payload,
    event,
    workflows: globalLockEntries,
  });

  // The matcher and the dispatched job must see the same envelope.
  const globalEvent = withSourceRepo(stampChangedFiles(event, resolved), repoIdentifier);

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
    resolvedOrgId,
    trustResolution: args.trustResolution,
    securityDecision: args.securityDecision,
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
   * This PR changes `.kici/` workflow definitions. Reported, not enforced: the
   * fork switch reads the fork signal and the tier, never this.
   */
  hasWorkflowModifications: boolean;
}

/**
 * Phase G — On PR events evaluated against the base lock file, diff base vs.
 * head and post a neutral informational check for reviewers. It feeds no policy
 * decision: a base-repo PR's author could already push `.kici/`, and a fork PR
 * is governed by the fork switch either way.
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
      // Its OWN check name, so it never overwrites the dispatch gate's
      // security-hold check.
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
 * A trust-policy verdict plus the fork switch it was decided under. The bare
 * `pass` arm is the short-circuit (non-PR event, or no fork model) taken before
 * any policy is read; every other verdict carries its switch, so the drop site
 * reads `forkSwitch` without inventing a source.
 */
export type SecurityPolicyDecision =
  { action: 'pass' } | (TrustPolicyOutcome & { forkSwitch: ForkSwitchContext });

/**
 * Evaluate the org trust policy for a PR event.
 *
 * A provider without `bundle.hasForkModel` passes regardless of policy. That
 * is not a trust claim (its PRs resolve no tier); the policy's one condition
 * cannot be established for it, as universal-git's `isForkPR` reads `false`
 * when payload keys are absent. Gating on a signal that fails toward trust
 * would be worse than not gating.
 *
 * No stored row is the unconfigured default (`FAIL_CLOSED_POLICY`); a read
 * that THREW gets `READ_FAILURE_POLICY` — see there for why.
 */
export async function evaluateSecurityPolicy(args: {
  deps: ProcessingDeps;
  bundle: ProviderBundle;
  isPREvent: boolean;
  resolvedOrgId: string;
  mode: OrchestratorMode;
  trustResolution: TrustResolution | undefined;
  isForkPR: boolean;
}): Promise<SecurityPolicyDecision> {
  const { deps, bundle, isPREvent, resolvedOrgId, mode } = args;
  if (!isPREvent || !bundle.hasForkModel) return { action: 'pass' };

  let stored: StoredTrustPolicy | null = null;
  let readFailed = false;
  try {
    stored = (await deps.trustPolicyStore?.get(resolvedOrgId)) ?? null;
  } catch (err) {
    // Not an unconfigured org: treating it as one would drop a `hold` / `allow`
    // org's fork PRs without trace on a transient DB error. Hold instead —
    // equally fail-closed, and recoverable.
    readFailed = true;
    logger.warn('Trust policy read failed; holding fork PRs for this delivery', {
      orgId: resolvedOrgId,
      error: toErrorMessage(err),
    });
  }

  const effective = readFailed
    ? { policy: READ_FAILURE_POLICY, source: EffectivePolicySource.enum['read-failure'] }
    : resolveEffectivePolicy(stored, mode);
  const policy = effective.policy;
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
  return {
    ...outcome,
    forkSwitch: {
      policy: policy.forkPolicy,
      source: effective.source,
      platformManaged: PLATFORM_CONNECTED_MODES.includes(mode),
    },
  };
}

// ---------------------------------------------------------------------------
// Phase H — Workflow registration on default-branch push
// ---------------------------------------------------------------------------

/**
 * Phase H — On a default-branch push, refresh the workflow registrations that
 * cross-source / global lookups read. Local sources only TRIGGER workflows;
 * re-registering would show duplicates under the generic routing key.
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

  // Non-null: the guard above passed only because the pushed branch equals it.
  // It is the branch a `__schedule_fire` run presents to a context's branch
  // restrictions, since that run executes this branch's lock file.
  const defaultBranch = extractDefaultBranch(payload, bundle.normalizer);

  let registerableWorkflows = extractRegisterableWorkflows(fullLockFile);
  let globalWorkflowNames = new Set(extractGlobalWorkflows(fullLockFile).map((w) => w.name));

  // Registration is about authoring: the workflow-repo allow-list applies, the
  // source-repo deny-list does not.
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

  // Always replace, so removals land even at count 0. The org id on every row
  // keeps the cross-source lookup org-isolated.
  await deps.registrationStore.replaceAll(
    repoIdentifier,
    registerableWorkflows,
    info.routingKey,
    credentials,
    {
      customerId: resolvedOrgId,
      commitSha: ref !== 'HEAD' ? ref : undefined,
      defaultBranch,
      // A global run from a registration restores the same dependency tarball
      // as a per-repository run of this lock.
      depCacheKey: depCacheKeyOf(fullLockFile),
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
  // The run would fail on every agent of this release; say so while the push is fresh.
  warnStaleCompileSchemas(
    logger,
    registerableWorkflows.map((w) => ({
      repoIdentifier,
      workflowName: w.name,
      isGlobal: globalWorkflowNames.has(w.name),
      lockEntry: w,
    })),
  );

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
 * Phase I.1 — Resolve changed files (skipped when no trigger in the lock file or
 * the org's global workflows uses path patterns) and match the lock file's
 * triggers against the event.
 */
async function gatherChangedFilesAndMatchTriggers(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  payload: Record<string, unknown>;
  event: SimulatedEvent;
  fullLockFile: FullLockFile;
  dispatchBundle: ProviderBundle;
  dispatchCredentials: Record<string, unknown>;
  repoIdentifier: string;
}): Promise<{ eventWithFiles: SimulatedEvent; decisions: ReturnType<typeof matchAllWorkflows> }> {
  const {
    info,
    deps,
    resolvedOrgId,
    payload,
    event,
    fullLockFile,
    dispatchBundle,
    dispatchCredentials,
    repoIdentifier,
  } = args;
  // A global `paths` filter must not read `skipped` because the repo's own lock
  // declares none.
  const globalEntries = (
    deps.registrationIndex?.getGlobalByOrgAndTriggerType(
      resolvedOrgId,
      eventTypeToTriggerType(info.event),
    ) ?? []
  ).map((reg) => reg.lockEntry as LockWorkflow);
  // `unavailable` (no fetcher, a truncated result, an API failure) makes a path
  // check match, deferred to the agent when the event has a git range.
  const resolved = await resolveEventChangedFiles({
    bundle: dispatchBundle,
    credentials: dispatchCredentials,
    repoIdentifier,
    eventName: info.event,
    payload,
    event,
    workflows: [...(fullLockFile.workflows as LockWorkflow[]), ...globalEntries],
  });

  // sourceRepo lets same-repo globals (gated by `repos` patterns) evaluate here;
  // the cross-repo global pass skips them.
  const eventWithFiles: SimulatedEvent = {
    ...stampChangedFiles(event, resolved),
    sourceRepo: repoIdentifier,
  };

  const matchStart = process.hrtime.bigint();
  // Only workflows subscribed to this event type are evaluated; the matched set
  // equals matchAllWorkflows', and dispatch looks workflows up by name, never
  // positionally, so a candidates-only array is safe.
  const decisions = matchWorkflowsForEvent(fullLockFile.workflows, eventWithFiles);
  const matchDuration = Number(process.hrtime.bigint() - matchStart) / 1e9;
  triggerMatchDurationSeconds.record(matchDuration);
  return { eventWithFiles, decisions };
}

/**
 * Phase I.2 — Dispatch each matched workflow via `dispatchMatchedWorkflow`
 * under its OWN runId, so execution tracking and Platform forwarding don't
 * collide when several match.
 *
 * Check runs are keyed `(owner, repo, sha, check name)`, not by runId; names
 * are distinct within one lock file, and a cross-repo global's check name is
 * qualified with its defining repo — see `CheckRunReporter.workflowLabel`.
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
      // Matched from the repo's OWN lock file.
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
      // A local `file://` in-place source runs the operator's real tree directly,
      // skipping the source-pack `__build__` job.
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
 * Phase J — Dispatch global workflows authored in OTHER repos that target this
 * event via `repos` patterns. Same-org scope covers same-source and
 * cross-provider globals.
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
  /** The inbound event's own bundle + credentials, used to post the failed-round check. */
  bundle: ProviderBundle;
  credentials: Record<string, unknown>;
  /** The event's trust resolution, recorded on each global run. */
  trustResolution: TrustResolution | undefined;
  /**
   * Applies to each global run as to per-repository ones: a `hold` parks it in
   * the security queue next to the pull request's own runs.
   */
  securityDecision: TrustPolicyOutcome;
  /**
   * The source `dispatchCredentials` belongs to, when a cross-provider lock-file
   * fallback made it differ from `info.routingKey`. Persisted on a failed
   * round's run row so its re-run rebuilds the same dispatch pair instead of
   * handing these credentials to the inbound source's client.
   */
  dispatchRoutingKey?: string;
  /** Only globals authored in this repo; a failed round's re-run re-decides that round alone. */
  onlyWorkflowRepo?: string;
  /**
   * Only candidates that need the round. Set when a failed or held round is
   * re-evaluated: the repo's other candidates reached their outcome on the
   * original delivery.
   */
  onlyRoundCandidates?: boolean;
  /**
   * Set with `onlyRoundCandidates` when a held round's security hold was just
   * approved: that hold also held the repo's result-aware-only candidates, so
   * the release dispatches them. A failed round's re-run leaves it unset (the
   * delivery already dispatched them).
   */
  releasedHold?: boolean;
  /**
   * Asked after the round decides, before anything it admitted dispatches.
   * False withdraws the verdicts: nothing admitted dispatches and its repos are
   * not reported decided. Set by a held round's release, whose run may have
   * been cancelled while the round ran.
   */
  admitRoundVerdicts?: () => Promise<boolean>;
  /**
   * Registrations to evaluate instead of the index's. Set by a held round's
   * release, which evaluates the workflow repo at the commit the hold recorded:
   * the round, its partition and the dispatch all read these.
   */
  registrations?: readonly RegisteredWorkflow[];
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
  } = args;
  if (!deps.registrationIndex)
    return {
      matchedCount: 0,
      matchedRunIds: [],
      decisionSummaries: [],
      roundFailureWorkflowRepos: [],
      decidedWorkflowRepos: [],
    };

  // A no-op here (already stamped), stated so the invariant holds by
  // construction on both global paths.
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
    ...(args.registrations !== undefined && { registrations: args.registrations }),
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
    resolvedOrgId,
    trustResolution: args.trustResolution,
    securityDecision: args.securityDecision,
    dispatchLogMessage: 'Global workflow job dispatched',
    consideredWorkflowRepos: collected.consideredWorkflowRepos,
    ...(args.dispatchRoutingKey !== undefined && {
      dispatchRoutingKey: args.dispatchRoutingKey,
    }),
    ...(args.onlyRoundCandidates === true && { onlyRoundCandidates: true }),
    ...(args.releasedHold === true && { releasedHold: true }),
    ...(args.admitRoundVerdicts !== undefined && { admitRoundVerdicts: args.admitRoundVerdicts }),
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
 * `execution.event`, from both the lock-file path (Phase K) and the
 * no-lock-file path — a repo with no lock file is the canonical target of a
 * global workflow, so its trace answers "why did the org's global not fire here?".
 */
function sendDecisionTraceEvent(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  repoIdentifier: string;
  ref: string;
  matchedCount: number;
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

  // One array over the per-repo and global halves, so the size budget applies
  // to what goes on the wire and `totalWorkflows` agrees with the trace.
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

  // Fire-and-forget, filesystem only; log storage is handled elsewhere.
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
      // Path filters ran against an unavailable diff: not a silent `processed / 0`.
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
 * Phases I–K — With a lock file: match + dispatch same-source and cross-repo
 * global workflows, forward the Platform trace, record the `processed` row.
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
  /** The inbound event's own bundle + credentials, used to post the failed-round check. */
  bundle: ProviderBundle;
  credentials: Record<string, unknown>;
  /** The PR-wide trust-policy verdict; gates same-source and global dispatch. */
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
    deps,
    resolvedOrgId,
    payload,
    event,
    fullLockFile,
    dispatchBundle: lockOutcome.dispatchBundle,
    dispatchCredentials: lockOutcome.dispatchCredentials,
    repoIdentifier,
  });

  // Tier-1 `requires` is pure data: no author code runs here.
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
    trustResolution: trust.trustResolution,
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
 * Process a webhook through the complete pipeline, recording a `failed`
 * event-log row for a delivery it could not finish.
 *
 * That row is the only customer-visible record: `acceptWebhookDelivery` answers
 * 202 and runs this detached, and the dashboard's webhook-activity view counts
 * `event_log.status = 'failed'`.
 *
 * Best-effort and non-masking: the original error is rethrown either way. The
 * delivery reverts to `buffered` for the drain to retry, and a successful
 * redelivery writes its own `processed` row beside this one.
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
        // Resolved again: the throw may precede the pipeline's org lookup, which
        // is safe and idempotent.
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
 * Phase D.1 exit — record a fork pull request the org fork switch dropped. The
 * event-log row is its ONLY trace, so it carries the reason that separates it
 * from the other bare `received` no-dispatch exits.
 */
async function recordIgnoredForkPR(args: {
  info: WebhookInfo;
  deps: ProcessingDeps;
  resolvedOrgId: string;
  repoIdentifier: string;
  senderUsername: string | undefined;
  forkSwitch: ForkSwitchContext;
}): Promise<void> {
  const { info, deps, resolvedOrgId } = args;
  logger.info('Fork PR event ignored by org fork policy', {
    deliveryId: info.deliveryId,
    orgId: resolvedOrgId,
    repo: args.repoIdentifier,
    sender: args.senderUsername,
  });
  forkEventsIgnoredTotal.add(1, { provider: info.provider });
  webhooksProcessedTotal.add(1, { result: 'skipped' });
  await recordSkipEventLog(
    info,
    deps,
    resolvedOrgId,
    EventLogStatus.enum.received,
    forkDropExplanation(args.forkSwitch),
  );
}

/** Runs the phase sequence the file header lists. */
async function processWebhookPipeline(
  info: WebhookInfo,
  inboundDeps: ProcessingDeps,
): Promise<WebhookIngestOutcome> {
  const provider = await dedupAndResolveProvider(info, inboundDeps);
  if (provider.status === 'skip') return skipReasonToOutcome(provider.reason);
  const { resolvedOrgId, bundle } = provider;

  const event = await normalizeWebhookEvent(info, inboundDeps, bundle, resolvedOrgId);
  if (!event) return WebhookIngestOutcome.enum.skipped;

  const crossSource = await routeCrossSource({
    info,
    deps: inboundDeps,
    event,
    resolvedOrgId,
    bundle,
  });
  if (crossSource.done) return WebhookIngestOutcome.enum.processed;
  const { deps } = crossSource;

  const repoCreds = await extractRepoAndCredentials(info, deps, bundle, resolvedOrgId);
  if (!repoCreds) return WebhookIngestOutcome.enum.skipped;
  const { repoIdentifier, credentials } = repoCreds;
  const payload = info.payload as Record<string, unknown>;

  // No `bundle` / `credentials`: each ended hold's check uses its own run's
  // commit, bundle and credentials, not this comment's.
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

  // Phase D.1 — the org fork switch, read ONCE and threaded into every dispatch
  // path. Evaluated before the lock-file fetch so an `ignore` verdict drops the
  // event before any run row, check status or clone token exists.
  const securityDecision = await evaluateSecurityPolicy({
    deps,
    bundle,
    isPREvent,
    resolvedOrgId,
    // Fail-closed default: a deps object without a mode must never open the gate.
    mode: deps.orchestratorMode ?? 'platform',
    trustResolution: trust.trustResolution,
    isForkPR: event.isForkPR ?? false,
  });

  if (securityDecision.action === 'ignore') {
    await recordIgnoredForkPR({
      info,
      deps,
      resolvedOrgId,
      repoIdentifier,
      senderUsername: event.senderUsername,
      forkSwitch: securityDecision.forkSwitch,
    });
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
    // Cross-source repo mode already evaluated what the fallback would re-read.
    allowRegistrationFallback: crossSource.crossSourceRepo !== repoIdentifier,
  });

  if (lockOutcome.corrupt) {
    await recordCorruptLockFile({
      info,
      deps,
      event,
      payload,
      resolvedOrgId,
      repoIdentifier,
      credentials,
      ref,
      corruptError: lockOutcome.corruptError,
    });
    return WebhookIngestOutcome.enum.processed;
  }

  if (!lockOutcome.lockFile) {
    logger.debug('No lock file found for per-repo matching, checking global workflows', {
      deliveryId: info.deliveryId,
      repoIdentifier,
      ref,
      lockFileSource: trust.lockFileSource,
    });
    // The trust-policy verdict belongs to the EVENT: a held fork PR holds its
    // global runs here too.
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
      trustResolution: trust.trustResolution,
      securityDecision,
    });
    const globalMatched = globals.matchedCount;
    // The global pass IS this delivery's evaluation; forwarded as Phase K does.
    sendDecisionTraceEvent({
      info,
      deps,
      repoIdentifier,
      ref,
      matchedCount: globalMatched,
      totalWorkflows: globals.decisionSummaries.length,
      decisions: globals.decisionSummaries,
    });
    // At `info`, like the lock-file path's `Webhook processed`, so a no-run
    // delivery is diagnosable without `debug` logs.
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

  // Called for its informational check; no dispatch decision reads the report.
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
