/**
 * Per-workflow dispatch pipeline.
 *
 * Handles everything that happens AFTER a workflow has been matched against an
 * incoming webhook: payload storage, cache + build coordination, secret
 * resolution, per-job context evaluation, static job dispatch (cluster +
 * single-orch paths), execution-tracker registration, deferred init dispatch
 * for jobs with dynamic fields, and deferred dynamic-job-fn dispatch for
 * `_type:'dynamic'` lock entries.
 *
 * The exported `dispatchMatchedWorkflow` threads typed phase-helper results
 * through the pipeline.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import type { Kysely, Transaction } from 'kysely';
import {
  isLockStaticJob,
  isLockDynamicJobFn,
  DEFAULT_APPROVAL_EXPIRY_SECONDS,
  CheckRunConclusion,
  ExecutionJobStatus,
  InitFailureCategory,
  CacheRefScope,
  HoldScope,
  HoldType,
  TriggerSource,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
  materializeFanout,
  materializeResolvedMatrix,
  materializeResolvedHosts,
  matrixEnvelopeFields,
  fanoutEnvelopeFields,
  FanoutError,
  FanoutCause,
  VariantKind,
  partitionMatchers,
  hostSatisfiesTarget,
  SSH_TRANSPORT_CAPABILITY,
  CONTAINER_BUILD_RUNTIME_LABEL,
  INIT_RUNNER_ROLE_LABEL,
  approvalTimeoutSecondsSchema,
  DEFAULT_HOLD_EXPIRY_SECONDS,
} from '@kici-dev/engine';
import type {
  LabelMatcher,
  LockWorkflow,
  LockJob,
  LockApproval,
  ApprovalRequirement,
  ApproverClause,
  NeedsEntry,
  NeedsGroupEntry,
  HostTargetSelector,
  SimulatedEvent,
  WorkflowDecision,
  TrustTier,
  InitFailure,
  MaterializedJob,
  ResolvedHostAgent,
  UpstreamSnapshot,
  HostFacts,
  Context as EngineContext,
  ResolvedSandboxGrant,
} from '@kici-dev/engine';
import { HostStatus, type MatchedHost, type HostRosterStore } from '../agent/host-roster.js';
import { resolveSandboxGrant } from './resolve-sandbox-grant.js';
import type { SandboxAllowList } from './sandbox-allowlist-reader.js';
import { flattenLockSteps } from './flatten-lock-steps.js';
import { storeWebhookPayload } from './webhook-payload-store.js';
import type { Database, HeldRun } from '../db/types.js';
import { jobsOfWorkflow } from '../reporting/execution-tracker.js';
import type { RerunLineage, TrackedJobRow } from '../reporting/execution-tracker.js';
import { HostIdentitySource, JobKind } from '../db/types.js';
import { NEEDS_PENDING_JOB_ID_PREFIX } from '../db/synthetic-job-ids.js';
import { resolveRunEventContext, type RunEventContext } from './run-event-context.js';
import { isInvokeGate, invokeParamsFromLockJob, type InvokeGateParams } from './invoke-gate.js';
import { parseOutputsCell, gatherInvokeResults } from '../orchestrator-core.js';
import { AgentJobFailedError } from '../cache/agent-job-failed-error.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import {
  cacheRepoIdFor,
  globalJobConfigFor,
  policyRoutingKey,
  policyBranch,
  policyRepo,
  workflowRepoProvenance,
  type GlobalDispatchIdentity,
} from './global-dispatch-identity.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RunContext, JobToRoute } from '../cluster/coordinator.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { TrustPolicyHoldReason, TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { CreateHeldRunData } from '../contexts/held-runs.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { countOccupyingJobs } from '../contexts/release-queued-holds.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../contexts/protection/pipeline.js';
import {
  evaluateMultiContextGates,
  aggregateProtectionParams,
  buildEffectiveContext,
  formatMultiContextRejection,
} from '../contexts/protection/aggregate.js';
import { buildJobContextDisplayNames, resolveJobContextNames } from './job-contexts.js';
import {
  contextDataConfigFields,
  resolveContextJobData,
  withoutContextData,
  type DeferredContextResolution,
} from './held-context-data.js';
import { toContext } from '../contexts/context-store.js';
import { resolveInstallSecrets, type NpmRegistrySpec } from './install-secrets-resolver.js';
import type { InstallGateRecord } from './install-gate.js';
import { storePendingWorkflowContext, toSerializableInputs } from './pending-workflow-context.js';
import { generateRunKeyPair, encryptPrivateKey } from '../secrets/ephemeral-keys.js';
import {
  insertEdgesForRun,
  resolveGroupEdges,
  recomputeNeedsSatisfied,
} from './needs-scheduler.js';
import {
  sourceCacheHitsTotal,
  sourceCacheMissesTotal,
  depCacheHitsTotal,
  depCacheMissesTotal,
  buildDurationSeconds,
} from '../metrics/prometheus.js';
import {
  storePendingJobContext,
  summarizeDecision,
  summarizeApprovalClauses,
  SECURITY_HOLD_ALSO_GATES_NOTE,
  buildSecurityHoldSummary,
  buildSecurityRejectionSummary,
  buildTriggerEvent,
  extractCommitMessage,
  isRootJob,
  trackEvalGate,
  dispatchReadyJob,
  type ProcessingDeps,
} from './processor.js';
import { buildReducedPrivilegeNote } from '../security/reduced-privilege-note.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'pipeline' });

/** Success-only run-on set: the default for a bare-string or unset needs edge. */
const SUCCESS_ONLY_RUN_ON_JSON = JSON.stringify([ExecutionJobStatus.enum.success]);

/** The `execution_job_needs.run_on` JSON for a needs entry; success-only when it has no runOn. */
function needsRunOnJson(entry: { runOn?: ExecutionJobStatus[] }): string {
  return entry.runOn && entry.runOn.length > 0
    ? JSON.stringify(entry.runOn)
    : SUCCESS_ONLY_RUN_ON_JSON;
}

/**
 * Trusted refs (write+ contributor, default-branch) get the org-shared cache
 * write scope; everyone else (fork PR, unknown/known-but-not-trusted) is
 * confined to a per-run isolated write scope. Absent trust resolution =>
 * isolated (fail-closed), so an unresolved trust state can never poison the
 * org-shared cache.
 */
export function deriveCacheRefScope(trust: TrustResolution | undefined): CacheRefScope {
  return trust?.tier === 'trusted' ? CacheRefScope.enum.shared : CacheRefScope.enum.isolated;
}

/**
 * Pre-resolve a clone token for the cluster-reroute path. Workers have no
 * provider credentials, so without it a peer's agent clones unauthenticated
 * and fails on private repos ("could not read Username for
 * 'https://github.com'"). Undefined when no provider, no token, or minting
 * throws — non-fatal, because local dispatch mints its own token at
 * job.dispatch time.
 */
async function mintCloneTokenForReroute(args: {
  bundle?: ProviderBundle;
  repoIdentifier: string;
  credentials: Record<string, unknown>;
  runId: string;
  workflowName: string;
}): Promise<string | undefined> {
  try {
    const minted = await args.bundle?.cloneTokenProvider?.createCloneToken(
      args.repoIdentifier,
      args.credentials,
    );
    return minted ?? undefined;
  } catch (err) {
    logger.warn('Failed to pre-resolve clone token for cluster reroute, agent may fail clone', {
      runId: args.runId,
      workflow: args.workflowName,
      error: toErrorMessage(err),
    });
    return undefined;
  }
}

/**
 * Clone tokens for a job routed to a cluster peer: the source repository's,
 * plus for a global workflow the workflow repository's, minted by its own
 * bundle and credentials. A token that could not be minted is absent.
 */
async function mintRerouteCloneTokens(
  ctx: WorkflowDispatchContext,
): Promise<{ cloneToken?: string; workflowCloneToken?: string }> {
  const { bundle, repoIdentifier, credentials, runId, workflow } = ctx;
  const cloneToken = await mintCloneTokenForReroute({
    bundle,
    repoIdentifier,
    credentials,
    runId,
    workflowName: workflow.name,
  });
  const workflowCloneToken = ctx.global
    ? await mintCloneTokenForReroute({
        bundle: ctx.global.workflowBundle,
        repoIdentifier: ctx.global.workflowRepoIdentifier,
        credentials: ctx.global.workflowCredentials,
        runId,
        workflowName: workflow.name,
      })
    : undefined;
  return {
    ...(cloneToken && { cloneToken }),
    ...(workflowCloneToken && { workflowCloneToken }),
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context for dispatching a single matched workflow, from both the same-source
 * path and the cross-source delegation shell. `crossSource` overrides the
 * dispatch `deliveryId` so fan-out targets land on their composite dedup slot
 * (`${inbound.deliveryId}:${reg.id}`).
 */
export interface WorkflowDispatchContext {
  info: WebhookInfo;
  deps: ProcessingDeps;
  /**
   * Undefined only for local-repo test runs (`kici run` with an inline lock
   * file and no remote provider): no clone-url builder, check poster or
   * clone-token provider, and `repoUrl` is `''`, which the agent treats as a
   * local/`fullRepo` clone. The webhook adapter always passes one.
   */
  bundle?: ProviderBundle;
  payload: unknown;
  repoIdentifier: string;
  /**
   * The repository that defines the workflow; equals `repoIdentifier` unless
   * `global` is set. REQUIRED so a dispatch path that omits it does not
   * compile: a null marker is read as "the repository the run acted on", not
   * "unknown" (`registration/registration-run-match.ts`).
   */
  workflowRepoIdentifier: string;
  /** Set when another repository defines the workflow; `repoIdentifier` is then the event's source. */
  global?: GlobalDispatchIdentity;
  credentials: Record<string, unknown>;
  event: SimulatedEvent;
  eventWithFiles: SimulatedEvent;
  ref: string;
  fullLockFile: {
    workflows: readonly LockWorkflow[];
    lockfileHash?: string;
    /** In-repo workspace sibling closure digest; part of the dep pointer key. */
    siblingsDigest?: string;
    source: { file: string };
  };
  resolvedOrgId: string;
  /**
   * NAMES of the jobs this pass admitted against a context concurrency limit,
   * keyed by {@link concurrencyAdmissionKey}. The DB count cannot see a job
   * just admitted, so without it every fan-out child is admitted against one
   * slot.
   *
   * Names, not a counter, so the two terms stay DISJOINT: the count query
   * excludes exactly these names ({@link countOccupyingJobs}). A counter summed
   * with a count that already sees the row double-counts a sibling on the
   * deferred-init path and spuriously holds a job.
   *
   * Lazy, per-pass, never persisted or shared. Two actors in the same
   * millisecond still race between count and insert — accepted, as this is a
   * throughput control, not an isolation boundary.
   */
  concurrencyAdmissions?: Map<string, Set<string>>;
  workflow: LockWorkflow;
  decision: WorkflowDecision;
  runId: string;
  trustResolution: TrustResolution | undefined;
  lockFileSource: string | undefined;
  /** True when this run executes an uploaded local working tree (CLI remote run). */
  localWorkingTree: boolean;
  /**
   * `execution_runs.triggered_by`. Set by the CLI remote-run path from the
   * actor the Platform relays on `test.relay.trigger`. Undefined on the webhook
   * path, whose provider-account initiator is in `triggerActorUsername` /
   * `triggerActorUserId`.
   */
  triggeredBy?: string | null;
  /** Agent provenance label when the run was initiated through an agent credential. */
  triggeredByAgentLabel?: string | null;
  /**
   * `execution_runs.parent_run_id` / `original_run_id`. Set by the re-run of an
   * organization-wide run; absent for every first run.
   */
  rerunLineage?: RerunLineage;
  /**
   * The trigger event the OIDC subject derives from, when not the run's own.
   * A re-run records `rerun`, which has no pull-request dimension, so it
   * states the original event here to keep a fork pull request's subject.
   */
  subjectTriggerEvent?: string;
  /** True only when invoked from the cross-source dispatch shell. */
  crossSource: boolean;
  /**
   * The run's `triggerEvent`, stated instead of derived from `event.type`. A
   * user `kiciEvent()` has `event.type` = `kici_event` while the run carries
   * the raw event name. Absent ⇒ derived from the event.
   */
  triggerEventOverride?: string;
  /**
   * The exact `jobConfig.event` envelope, instead of spreading the matched
   * `SimulatedEvent`. The envelope omits `targetBranch` and `changedFiles`: an
   * internal run has no changed files, and its branch is provenance for the
   * trigger matcher and context branch gate. The envelope becomes
   * `RuleContext.event` and the `event` half of `buildConcurrencyGroupContext`,
   * so publishing the branch would silently re-key the documented
   * `ctx.event.targetBranch ?? 'default'` group of every internal workflow.
   * Absent ⇒ derived from the event.
   */
  eventEnvelopeOverride?: Record<string, unknown>;
  /**
   * Chain depth to stamp: an invoke-gate summon carries its summoner's depth +
   * 1, which bounds the chain-depth circuit breaker. Absent ⇒ 0.
   *
   * Load-bearing: the breaker fails OPEN if this is lost. Stamped as soon as
   * the run row exists, because `releaseInvokeGate` reads it back inside this
   * same dispatch.
   */
  chainDepth?: number;
  /**
   * Marks a run dispatched by a failure-lifecycle trigger, so its own
   * completion is excluded from batch accumulation and a broken notifier
   * cannot re-trigger itself (`EventRouter.isFailureLifecycleRun`). Persisted
   * as a field merged INTO the `trigger_decision` JSON blob.
   */
  dispatchedByFailureLifecycle?: boolean;
  /**
   * Marks a run the orchestrator triggered itself (schedule fire, workflow/job
   * completion, failure batch, user `kiciEvent()`, invoke-gate summon). Absent
   * ⇒ webhook-triggered.
   *
   * Read only by the context branch gate. Such a run usually has a real
   * `targetBranch` (a schedule's registration default branch, or the emitting
   * run's branch) and is matched normally. The flag lets the gate name the
   * cause when `targetBranch` is EMPTY (failure batch, scaler event, uncaptured
   * default branch, emitting run gone) instead of quoting an empty branch. It
   * does NOT weaken the gate: a run with no branch satisfies no restriction,
   * `*` included.
   */
  internallyTriggered?: boolean;
  /**
   * Org trust-policy gate outcome for this PR event: `pass` dispatches, `hold`
   * parks the run in the security queue, `reject` fails it before any job
   * starts (`holdRunForSecurityPolicy` / `rejectRunForSecurityPolicy`).
   * Computed once per PR event in the webhook pipeline.
   *
   * REQUIRED so a path that omits it does not compile: an optional field read
   * as `if (!decision) return null` passes the gate on omission — fail-open
   * inside a fail-closed control. A `pass` is stated explicitly.
   */
  securityDecision: TrustPolicyOutcome;
  /**
   * Set when this dispatch call took a pending-jobs token covering the window
   * between registering the run and registering its jobs — the source-pack
   * build window, or the plain dispatch window when there is no build. Tokens
   * are fungible, so the `finally` must release only one it actually took — an
   * unpaired release would consume a token held by a deferred init / dynamic
   * task and un-hold the run while its jobs are still being registered.
   */
  dispatchWindowTokenHeld?: boolean;
  /**
   * Set when this dispatch call inserted the `execution_runs` row before
   * handing the first job to an agent. A row that exists with zero jobs can
   * never complete (`isRunComplete` ends `run.jobs.size > 0`) and no sweeper
   * reaps it, so a throw inside that window has to terminalize the run
   * explicitly rather than leave it `pending` forever.
   */
  runRegisteredBeforeDispatch?: boolean;
  /**
   * Called each time this dispatch registers the run with the tracker. An older `kici`'s shared
   * fixture run dispatches several
   * workflows under one run id, and holds the run open from the first
   * registration until every workflow has registered.
   */
  onRunRegistered?: () => void;
  /**
   * Set once `setupDispatchContext` posted the queued `kici/<workflow>` check
   * and one `kici/<workflow>/job/<name>` per static job. They go up BEFORE the
   * start decision, so every exit owes them a conclusion. Named early exits
   * complete their own; a THROW does not, and nothing else can (the stale
   * sweep only touches `in_progress` checks), so they stay `queued` forever —
   * a branch-protection blocker on a pull request.
   */
  pendingChecksPosted?: boolean;
  /** Composite dedup key `${info.deliveryId}:${reg.id}` (cross-source only). */
  crossSourceDeliveryId?: string;
  /**
   * Routing key for dispatched jobs and log / tracker rows: `info.routingKey`
   * same-source; `reg.routingKey` cross-source (the registration's owning
   * source, NOT the inbound generic key).
   */
  effectiveRoutingKey?: string;
  /**
   * Provider for dispatched jobs and tracker rows: `info.provider`
   * same-source; `regBundle.normalizer.provider` cross-source.
   */
  effectiveProvider?: string;
  /**
   * jobConfig fields merged into every dispatched job. Cross-source callers
   * inject provenance (`crossSource: true`, `inboundRoutingKey`,
   * `inboundEventName`, `workflowRepoUrl`, `workflowRef`, `workflowSha`,
   * `workflowRepoIdentifier`) that agents and dashboards need to clone and log.
   */
  extraJobConfig?: Record<string, unknown>;
  /**
   * Set only for `kici run` / test-trigger dispatches: `recordRunStart` stamps
   * `is_test_run = true` and `fixture_id` on the `execution_runs` row.
   */
  testRun?: { fixtureId: string };
  /**
   * `kici run --secret` / `--env` flat secrets, layered onto EVERY job's
   * `jobConfig.secrets` whether or not it declares a `context:`. The CLI value
   * wins on a key collision with per-job context secrets. Undefined for webhook
   * runs.
   */
  runWideFlatSecrets?: Record<string, string>;
  /**
   * `kici run --target` (Ansible `--limit`): narrow-only post-filter, effective
   * hosts = runsOnAll ∩ target. Undefined for webhook runs.
   */
  target?: HostTargetSelector;
  /**
   * Resolved (coerced, defaulted, validated) `kici run --input` values, exposed
   * to every job as `ctx.dispatchInputs`. Undefined for webhook runs.
   */
  dispatchInputs?: Record<string, unknown>;
  /**
   * Set only on an install-gate-held dispatch: the contexts that held (covered
   * by the hold's approval) and the ones admitted. Its release gates every
   * context the approval did not cover.
   */
  installGateRecord?: InstallGateRecord;
}

/**
 * The trigger event every recording site stamps on the run. One helper keeps a
 * new recording path from ignoring `ctx.triggerEventOverride`, which wins when
 * non-blank; otherwise derived from the event.
 *
 * Non-blank, not `??`: a blank trigger event renders as nothing on the
 * dashboard and Platform forward instead of the derived value. This does NOT
 * rescue a blank `event.type` (a bare `__` name de-prefixes to `''`); that is
 * unemittable, since emit refuses the `__` namespace and the orchestrator
 * mints only enumerated names.
 */
function dispatchTriggerEvent(ctx: WorkflowDispatchContext): string {
  const override = ctx.triggerEventOverride;
  if (override !== undefined && override.trim() !== '') return override;
  return buildTriggerEvent(ctx.event.type, ctx.event.action);
}

/**
 * The `trigger_decision` blob. `dispatchedByFailureLifecycle` is MERGED onto
 * the summary, never substituted: the dashboard and registration matcher read
 * the summary's fields. The key is omitted on a plain run.
 */
function dispatchTriggerDecision(
  ctx: WorkflowDispatchContext,
  decision: WorkflowDecision,
): Record<string, unknown> {
  return {
    ...summarizeDecision(decision),
    ...(ctx.dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
  };
}

/**
 * Stamp the inherited chain depth right after each row insert, NOT at the end
 * of dispatch: `releaseInvokeGate` reads `execution_runs.chain_depth` inside
 * this same call, and a later write leaves the breaker reading 0 — failing
 * open on unbounded summon recursion. A chain-starting run writes nothing (the
 * column defaults to 0).
 */
async function stampChainDepth(ctx: WorkflowDispatchContext): Promise<void> {
  if (!ctx.chainDepth || ctx.chainDepth <= 0) return;
  const db = ctx.deps.db;
  if (!db) return;
  await db
    .updateTable('execution_runs')
    .set({ chain_depth: ctx.chainDepth })
    .where('run_id', '=', ctx.runId)
    .execute();
}

/** The event context a run row records: the head context, plus a stated subject event. */
function runEventContextFor(
  ctx: WorkflowDispatchContext,
  event: SimulatedEvent,
): RunEventContext & { subjectTriggerEvent?: string } {
  return {
    ...resolveRunEventContext(event),
    // fails-when: a re-run of a pull-request run records no subject event and presents a push
    // identity
    ...(ctx.subjectTriggerEvent !== undefined && { subjectTriggerEvent: ctx.subjectTriggerEvent }),
  };
}

/** Register the run with the execution tracker, then stamp its chain depth. */
async function startTrackedRun(
  tracker: NonNullable<ProcessingDeps['executionTracker']>,
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
  jobs: TrackedJobRow[],
  opts: { declaredContexts?: readonly string[] } = {},
): Promise<void> {
  const { workflow, repoIdentifier, credentials, event, ref, runId, decision } = ctx;
  await tracker.onExecutionStarted(
    runId,
    workflow.name,
    setup.info.provider,
    repoIdentifier,
    event.targetBranch,
    ref,
    setup.effectiveDeliveryId,
    credentials as Record<string, unknown>,
    dispatchTriggerDecision(ctx, decision),
    jobs,
    setup.info.routingKey,
    opts.declaredContexts?.length ? [...opts.declaredContexts] : undefined,
    dispatchTriggerEvent(ctx),
    extractCommitMessage(setup.info.event, setup.info.payload),
    ctx.rerunLineage?.parentRunId,
    ctx.triggeredBy,
    ctx.rerunLineage?.originalRunId,
    setup.workflowConcurrency,
    setup.workflowTimeoutMs,
    setup.checkMode,
    ctx.localWorkingTree,
    event.senderUsername ?? undefined,
    event.senderUserId ?? undefined,
    ctx.triggeredByAgentLabel,
    event.prNumber ?? null,
    workflowRepoProvenance(ctx),
    // Where the code came from, which `event.targetBranch` deliberately omits.
    runEventContextFor(ctx, event),
  );
  ctx.onRunRegistered?.();
  await stampChainDepth(ctx);
}

/**
 * Internal-trigger fields every PRE-dispatch recording site carries (install-
 * gate hold, trust-policy hold and reject, init-failure skip, build failed
 * before tracking). Each writes its `execution_runs` row and returns, so no
 * later step stamps them.
 *
 * `chainDepth` is load-bearing on the two HOLDS: a released hold fires its own
 * invoke gate, and `releaseInvokeGate` reads `chain_depth` to bound recursion.
 * The `0` default reads as "starts a chain", so the breaker fails OPEN. The
 * terminal sites stamp it for the record: their row is the run's only trace.
 *
 * `dispatchedByFailureLifecycle`: a HELD run resumes and completes on its own
 * row, and a `workflows_failed_batch` accumulator would fold that completion
 * back into the batch that spawned it. Terminal sites record it for
 * consistency; none emits a completion event.
 *
 * A stated `chainDepth` passes verbatim, `0` included; the tracker normalizes
 * `0` away (`inheritedChainDepth`).
 */
function preDispatchRunProvenance(ctx: WorkflowDispatchContext): {
  chainDepth?: number;
  dispatchedByFailureLifecycle?: boolean;
  rerunLineage?: RerunLineage;
} {
  return {
    ...(ctx.chainDepth !== undefined && { chainDepth: ctx.chainDepth }),
    ...(ctx.dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
    ...(ctx.rerunLineage && { rerunLineage: ctx.rerunLineage }),
  };
}

/**
 * The slice the needs catch-up and ready-recompute helpers read, so the
 * global-workflow path (which never builds a full `WorkflowDispatchContext`)
 * can drive the needs scheduler too.
 */
export type NeedsSchedulingContext = Pick<WorkflowDispatchContext, 'deps' | 'runId'>;

/**
 * The dispatch-envelope event, carrying the already-fetched changed files as a
 * fast path. The agent recomputes from the clone when status !== 'fetched', so
 * correctness comes from the agent.
 */
export function envelopeEvent(
  baseEvent: SimulatedEvent,
  eventWithFiles: SimulatedEvent,
): SimulatedEvent {
  return {
    ...baseEvent,
    changedFiles: eventWithFiles.changedFiles,
    changedFilesStatus: eventWithFiles.changedFilesStatus,
  };
}

export interface DispatchMatchedWorkflowResult {
  /** Non-rejected jobs dispatched. */
  dispatchedJobCount: number;
  /** Every dispatched/tracked job id (root, gated, synthetic). */
  dispatchedJobIds: string[];
  /**
   * Jobs deferred to the agent init round, not yet in `dispatchedJobIds`. They
   * still run (`startDeferredPhases`), so a run with deferred work is not
   * "nothing dispatched". Absent/0 on early returns.
   */
  deferredJobCount?: number;
  /** True when the workflow install gate held the run. */
  held?: boolean;
  /**
   * One warning per job whose bound test-run contexts were skipped, surfaced
   * on the trigger response for the CLI to print.
   */
  envWarnings?: string[];
}

/** Options controlling a (re-)dispatch of a matched workflow. */
export interface DispatchMatchedWorkflowOptions {
  /** Resume path: the install protection gate is already satisfied. */
  skipInstallProtectionGate?: boolean;
  /** Run id whose `held` row is flipped to pending instead of inserting a new one. */
  reuseRunId?: string;
}

// ---------------------------------------------------------------------------
// Internal types — threaded between phase helpers
// ---------------------------------------------------------------------------

type DispatchFn = (input: QueuedJobInput) => ReturnType<Dispatcher['dispatch']>;

interface DispatchSetup {
  /** Injects ctx.extraJobConfig into every dispatch. */
  dispatcher: { dispatch: DispatchFn };
  /** Overlaid with the effective routing key and provider. */
  info: WebhookInfo;
  /** Composite delivery id on cross-source, otherwise info.deliveryId. */
  effectiveDeliveryId: string;
  workflowConcurrency: { cancelInProgress?: boolean; max?: number } | undefined;
  workflowTimeoutMs: number | undefined;
  /**
   * Idempotent-step mode (`apply` | `check` | `check-fail-on-drift`) from the
   * `kici run --check` path; persisted so `computeRunStatus` fails a
   * `check-fail-on-drift` run with drift. Undefined for apply-mode webhooks.
   */
  checkMode: string | undefined;
}

interface BuildPrepResult {
  sourceTarUrl: string | undefined;
  /** SHA-256 of the source tarball's own bytes; the agent verifies against it. */
  sourceTarDigest: string | undefined;
  depsUrl: string | undefined;
  depsHash: string | undefined;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  hasDynamicEntries: boolean;
  dynamicEntries: ReadonlyArray<Extract<LockWorkflow['jobs'][number], { _type: 'dynamic' }>>;
  staticJobs: readonly LockJob[];
  /**
   * Static jobs after matrix fan-out (non-matrix 1:1), keyed by
   * `expandedName` in every phase. Dynamic-matrix jobs carry
   * `pendingDynamicMatrix`.
   */
  materializedJobs: readonly MaterializedJob[];
  /** baseName -> expanded child names; drives needs-edge expansion. */
  expansionMap: ReadonlyMap<string, readonly string[]>;
  /** Jobs whose matrix could not be materialized (cap / zero-combination). */
  matrixFailures: readonly RejectedJob[];
  targetPlatform: string;
  targetArch: string;
  buildJobId: string | undefined;
  buildJobName: string | undefined;
  buildJobLabels: string[] | undefined;
  buildJobTrackedEarly: boolean;
  /** The build failed but dynamic entries can still proceed. */
  buildFailed: boolean;
  /**
   * Dispatch short-circuited (build failed with no dynamic entries, or build
   * job rejected). Caller MUST return `dispatchedJobCount: 0`.
   */
  abort: boolean;
}

interface SecretBundle {
  declaredContexts: readonly string[];
  runPublicKeyBase64: string | undefined;
  /** Private npm registries with tokens filled in. */
  npmRegistries: NpmRegistrySpec[] | undefined;
  /** Bare-name secrets projected as install env vars. */
  installEnvSecrets: Record<string, string> | undefined;
}

interface JobEnvData {
  contextName?: string;
  /** Configured env id matched for the first declared context name. */
  contextId?: string;
  /**
   * Ordered bound-context names for the job row; `(dynamic)` marks an element
   * the agent resolves later, which then overwrites the list.
   */
  contextNames?: string[];
  contextVars?: Record<string, string>;
  jobEnv?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
  /**
   * Container registry credentials resolved from the lock's secret NAMES;
   * lifted to a top-level dispatch field (stripped from jobConfig) before the
   * agent sees it.
   */
  containerRegistryAuth?: { username: string; password: string; serveraddress: string };
  held?: boolean;
  /**
   * Set when the bound contexts admitted the job's reject rules: what a later
   * dispatch resolves context data from when the job is stored pending (held,
   * awaiting upstream, outside its wave). Carries no secret value.
   */
  contextResolution?: DeferredContextResolution;
  /**
   * Set when a context policy or lock `approval` needs sign-off; the dispatch
   * loop turns it into a `held_runs` row plus a stored pending job context so
   * `release()` can re-dispatch.
   */
  approvalHold?: PendingApprovalHold;
  /**
   * A non-reviewer hold (security / wait-timer / concurrency-queue) from
   * protection rules. Carried, not written on the spot, so
   * `holdJobForApproval` creates the row and resume path in ONE transaction.
   */
  nonApprovalHold?: CreateHeldRunData;
  rejected?: boolean;
  rejectReason?: string;
  pendingInit?: boolean;
  /** Bound contexts skipped on a test/local run because they disallow local execution. */
  skippedEnvs?: string[];
  /** Warning naming test-run contexts skipped as non-test or unconfigured; shown in CLI and dashboard. */
  envWarning?: string;
}

/** A resolved approval requirement awaiting hold creation in the dispatch loop. */
interface PendingApprovalHold {
  scope: HoldScope;
  triggerSource: TriggerSource;
  requirement: ApprovalRequirement;
  contextId: string | null;
  queueType: 'context' | 'security';
}

interface DeferredInitJob {
  mat: MaterializedJob;
  initJobInput: QueuedJobInput;
}

interface JobEnvEvalResult {
  jobContextData: Map<string, JobEnvData>;
  deferredInitJobs: DeferredInitJob[];
  runContextName: string | undefined;
  runContextId: string | undefined;
}

/**
 * Synthetic job-id prefix every needs-gate site stamps on a held-back job. The
 * release path (`dispatchReadyJob` → `findSyntheticJobId` → `addJobsToRun`)
 * keys on it, so it soundly recovers the gated set without threading a parallel
 * list through both the single-orch and cluster paths. Owned by `db/synthetic-job-ids.ts` so the
 * `contexts/`
 * concurrency sweep need not import this module.
 */
export { NEEDS_PENDING_JOB_ID_PREFIX };

/**
 * Reason for a protection-rule rejection whose evaluator gave none; shared so
 * the setter and run-facing record use the same words.
 */
const DEFAULT_CONTEXT_REJECT_REASON = 'Rejected by protection rules';

interface DispatchedJob {
  jobId: string;
  jobName: string;
  runsOnLabels?: string[];
  matrixValues?: Record<string, unknown>;
  baseJobName?: string;
  variantKind?: string;
  variantLabel?: string;
  /** Held by the rolling-wave gate (a fan-out child beyond maxParallel). */
  waveGated?: boolean;
  /** The base's wave width, stamped on every child of a bounded wave. */
  waveMaxParallel?: number;
  /** The base's failFast policy, stamped on every child of a bounded wave. */
  waveFailFast?: boolean;
  /** Ordered bound-context names (multi-env jobs). */
  contexts?: string[];
  /** Bound contexts skipped on a test run (non-test / unconfigured). */
  skippedContexts?: string[];
  envWarning?: string;
  /** `gate` marks an invoke-gate row (runs the gate executor, never an agent). */
  jobKind?: JobKind;
  /** For a gate job, its wall-clock timeout in ms (orchestrator-swept). */
  timeoutMs?: number;
}

interface RejectedJob {
  jobId: string;
  jobName: string;
  reason: string;
  /** Explicit init-failure category override; inferred from reason when absent. */
  category?: InitFailureCategory;
  /**
   * Default `failed`. A `runsOnAll` deliberately narrowed to no hosts records
   * `skipped` (no init-failure) so downstream `when` sets govern propagation.
   */
  terminalStatus?: ExecutionJobStatus;
}

type BuildJobConfigFn = (mat: MaterializedJob) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// Phase A — setup
// ---------------------------------------------------------------------------

/**
 * Wrap the dispatcher, overlay effective routing/provider, persist the payload,
 * fire source-location callbacks, and post the pending checks.
 */
async function setupDispatchContext(ctx: WorkflowDispatchContext): Promise<DispatchSetup> {
  const { deps, repoIdentifier, credentials, ref, runId, workflow, crossSource } = ctx;
  const baseDispatcher = deps.dispatcher;
  const dispatcher: { dispatch: DispatchFn } = ctx.extraJobConfig
    ? {
        dispatch: (input: QueuedJobInput) =>
          baseDispatcher.dispatch({
            ...input,
            jobConfig: { ...input.jobConfig, ...ctx.extraJobConfig },
          }),
      }
    : baseDispatcher;

  const effectiveDeliveryId: string = crossSource
    ? (ctx.crossSourceDeliveryId ?? ctx.info.deliveryId)
    : ctx.info.deliveryId;
  const effectiveRoutingKey: string = ctx.effectiveRoutingKey ?? ctx.info.routingKey;
  const effectiveProvider: string = ctx.effectiveProvider ?? ctx.info.provider;
  const info: WebhookInfo = {
    ...ctx.info,
    routingKey: effectiveRoutingKey,
    provider: effectiveProvider as WebhookInfo['provider'],
  };

  await storeWebhookPayload({ logStorage: deps.logStorage, runId, payload: info.payload });

  const workflowConcurrency = workflow.concurrency
    ? {
        cancelInProgress: workflow.concurrency.cancelInProgress,
        max: workflow.concurrency.max,
      }
    : undefined;

  const workflowTimeoutMs = workflow.timeout;

  const rawCheckMode = ctx.extraJobConfig?.checkMode;
  const checkMode = typeof rawCheckMode === 'string' ? rawCheckMode : undefined;

  if (deps.onSourceLocationsExtracted) {
    for (const job of workflow.jobs.filter(isLockStaticJob)) {
      const locs = flattenLockSteps(job.steps).map((s) => s.sourceLocation);
      if (locs.some((l) => l !== undefined)) {
        deps.onSourceLocationsExtracted(
          workflow.name,
          job.name,
          locs as Array<{ file: string; line: number; column: number } | undefined>,
        );
      }
    }
  }

  if (deps.checkRunReporter) {
    const [owner, repo] = repoIdentifier.split('/');
    const jobNames = workflow.jobs.filter(isLockStaticJob).map((j) => j.name);
    await deps.checkRunReporter.setPendingAwait({
      provider: info.provider,
      owner,
      repo,
      sha: ref,
      workflowName: workflow.name,
      ...(ctx.global && { workflowRepoIdentifier: ctx.global.workflowRepoIdentifier }),
      jobNames,
      installationId: (credentials as { installationId?: number }).installationId,
      routingKey: info.routingKey,
      // Explicit so details_url survives a later async hop dropping the ALS frame.
      runId,
      requestId: getRequestContext().requestId,
    });
    // Only after the post resolved, so a failed post never makes the catch
    // conclude a check run that was never created.
    ctx.pendingChecksPosted = true;
  }

  return {
    dispatcher,
    info,
    effectiveDeliveryId,
    workflowConcurrency,
    workflowTimeoutMs,
    checkMode,
  };
}

// ---------------------------------------------------------------------------
// Phase B — cache + build
// ---------------------------------------------------------------------------

/**
 * Platform/arch of the first agent matching the first job's runsOn; linux/x64
 * when none.
 */
function chooseTargetPlatform(
  workflow: LockWorkflow,
  agentRegistry: ProcessingDeps['agentRegistry'],
): { targetPlatform: string; targetArch: string } {
  let targetPlatform = 'linux';
  let targetArch = 'x64';
  if (!agentRegistry) return { targetPlatform, targetArch };
  // Only exact labels can be probed; a glob-only first job probes 'default'.
  const firstJob = workflow.jobs.filter(isLockStaticJob)[0];
  const firstExact = partitionMatchers(firstJob?.runsOn ?? []).exact;
  const representativeLabels: string[] =
    workflow.jobs.length > 0 ? (firstExact.length > 0 ? firstExact : ['default']) : ['default'];
  const candidates = agentRegistry.findAvailable(representativeLabels);
  if (candidates.length > 0) {
    targetPlatform = candidates[0].platform;
    targetArch = candidates[0].arch;
  }
  return { targetPlatform, targetArch };
}

/**
 * Whether the workflow source repo can be packed into the cache. Cross-source
 * always clones and installs; a global run needs the registration's commit,
 * else it installs agent-side.
 */
function buildableWorkflowRepo(ctx: WorkflowDispatchContext): boolean {
  // fails-when: a global run with workflowSha null or '' reaches the cache probe or the build
  // breaks-if-wrong: a same-repo run and a global run with a registered commit must still build
  return !ctx.crossSource && (!ctx.global || !!ctx.global.workflowSha);
}

/** Probe source + dep caches and forward stats to Platform; bypassed when not buildable. */
async function probeCaches(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
  contentHash: string | undefined,
  lockfileHash: string | undefined,
  targetPlatform: string,
  targetArch: string,
): Promise<{ sourceHit: boolean; depHit: boolean }> {
  const { deps, workflow } = ctx;
  const buildable = buildableWorkflowRepo(ctx);
  let sourceHit = false;
  let depHit = false;
  // Local-repo runs (working-tree overlay) and `file://` in-place runs are not
  // cacheable builds: a stale cached tarball must never shadow the tree.
  if (!ctx.bundle || ctx.localWorkingTree) {
    return { sourceHit, depHit };
  }
  if (buildable && contentHash && deps.sourceCache) {
    sourceHit = await deps.sourceCache.has(ctx.resolvedOrgId, contentHash);
    if (sourceHit) {
      sourceCacheHitsTotal.add(1);
      logger.info('Source cache hit', { workflow: workflow.name, contentHash });
    } else {
      sourceCacheMissesTotal.add(1);
      logger.info('Source cache miss', { workflow: workflow.name, contentHash });
    }
    deps.platformClient?.send({ type: 'cache.stats', cacheType: 'source', hit: sourceHit });
  }
  if (buildable && lockfileHash && deps.depCache) {
    depHit = await deps.depCache.has(
      lockfileHash,
      targetPlatform,
      targetArch,
      ctx.fullLockFile?.siblingsDigest,
    );
    if (depHit) {
      depCacheHitsTotal.add(1);
      logger.info('Dep cache hit', { workflow: workflow.name, lockfileHash });
    } else {
      depCacheMissesTotal.add(1);
      logger.info('Dep cache miss', { workflow: workflow.name, lockfileHash });
    }
    deps.platformClient?.send({ type: 'cache.stats', cacheType: 'dep', hit: depHit });
  }
  void setup;
  return { sourceHit, depHit };
}

/**
 * Whether a `__build__` job must run first. Either cache missing is a reason:
 * source (keyed on contentHash) and deps (keyed on lockfile hash) miss
 * independently, and a dependency bump leaves source warm and deps cold.
 * Gating on the source miss alone never uploads the dep tarball, so agents
 * with no registry route (cloud one-shot, air-gapped) cannot run at all.
 *
 * A miss counts only with its hash: no hash means no cache key to write.
 */
export function buildIsNeeded(args: {
  /** False when there is nothing to cache into (no bundle, no coordinator, …). */
  cacheInfraAvailable: boolean;
  sourceHit: boolean;
  contentHash: string | undefined;
  depHit: boolean;
  lockfileHash: string | undefined;
}): boolean {
  if (!args.cacheInfraAvailable) return false;
  const sourceMissing = !args.sourceHit && Boolean(args.contentHash);
  const depsMissing = !args.depHit && Boolean(args.lockfileHash);
  return sourceMissing || depsMissing;
}

/** The QueuedJobInput for a __build__ job. */
function buildBuildJobInput(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildJobName: string;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  targetPlatform: string;
  targetArch: string;
  sourceHit: boolean;
  depHit: boolean;
}): QueuedJobInput {
  const { ctx, setup, buildJobName } = args;
  const { workflow, fullLockFile } = ctx;
  return {
    runId: ctx.runId,
    workflowName: workflow.name,
    jobName: buildJobName,
    runsOnLabels: [
      `kici:role:builder`,
      `kici:os:${args.targetPlatform}`,
      `kici:arch:${args.targetArch}`,
    ],
    jobConfig: {
      buildOnly: true,
      targetPlatform: args.targetPlatform,
      targetArch: args.targetArch,
      source: { file: workflow.source?.file ?? fullLockFile.source.file },
      contentHash: args.contentHash || undefined,
      lockfileHash: args.lockfileHash || undefined,
      // Part of the dep POINTER key: a publish keyed unlike the probe writes a
      // pointer nothing reads.
      ...(fullLockFile.siblingsDigest && { siblingsDigest: fullLockFile.siblingsDigest }),
      workflowName: workflow.name,
      buildSourceNeeded: !args.sourceHit && !!args.contentHash,
      buildDepsNeeded: !args.depHit && !!args.lockfileHash,
      // The build job UPLOADS the tarball; the upload handler resolves the
      // storage prefix from this server-side org, never from the wire.
      cacheOrgId: ctx.resolvedOrgId,
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
    },
    ...buildCloneTarget(ctx, setup),
    deliveryId: setup.effectiveDeliveryId,
    requestId: getRequestContext().requestId,
  };
}

/**
 * What a `__build__` job clones: a global run's workflow repository at its
 * registered commit with its own credentials, else the event's repository at
 * the event commit.
 */
function buildCloneTarget(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
): Pick<QueuedJobInput, 'repoUrl' | 'ref' | 'sha' | 'provider' | 'providerContext' | 'routingKey'> {
  const g = ctx.global;
  if (g) {
    // fails-when: a global build is requested with no registered commit (null or '')
    // breaks-if-wrong: a global run with a registered commit must build at that commit
    if (!g.workflowSha) {
      throw new Error(
        `Cannot build the global workflow pack from ${g.workflowRepoIdentifier}: ` +
          `the registration records no commit`,
      );
    }
    return {
      repoUrl: g.workflowBundle?.repoUrlBuilder?.buildCloneUrl(g.workflowRepoIdentifier) ?? '',
      ref: g.workflowBranch ?? '',
      sha: g.workflowSha,
      provider: g.workflowBundle?.normalizer.provider ?? setup.info.provider,
      providerContext: g.workflowCredentials,
      routingKey: g.workflowRoutingKey,
    };
  }
  return {
    repoUrl: ctx.bundle?.repoUrlBuilder?.buildCloneUrl(ctx.repoIdentifier) ?? '',
    ref: ctx.event.sourceBranch ?? ctx.event.targetBranch,
    sha: ctx.ref,
    provider: setup.info.provider,
    providerContext: ctx.credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
  };
}

/**
 * A synthetic `__bringup__` job, one per un-agented `includeUninitialized`
 * child, sent to a `kici:capability:ssh-transport` agent that runs
 * `ensureInitRunner(targetAgentId)` over SSH. The init-runner connects under
 * `targetAgentId` and the child's pinned hold drains onto it. Clones nothing,
 * no sandbox (`bringupOnly`).
 */
export function buildBringupJobInput(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  targetAgentId: string;
}): QueuedJobInput {
  const { ctx, setup, targetAgentId } = args;
  const { workflow } = ctx;
  return {
    runId: ctx.runId,
    workflowName: workflow.name,
    jobName: `__bringup__${workflow.name}__${targetAgentId}`,
    runsOnLabels: [SSH_TRANSPORT_CAPABILITY],
    jobConfig: {
      bringupOnly: true,
      bringupTarget: targetAgentId,
      workflowName: workflow.name,
    },
    repoUrl: '',
    ref: ctx.event.sourceBranch ?? ctx.event.targetBranch,
    sha: ctx.ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: ctx.credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
  };
}

/**
 * Best-effort `__bringup__` dispatch for one un-agented child: with no
 * ssh-transport agent it queues, and the held child times out via the normal
 * queue path. A failure is logged, not thrown.
 */
async function dispatchBringupForChild(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  mat: MaterializedJob;
}): Promise<void> {
  const { ctx, setup, mat } = args;
  const targetAgentId = mat.pinnedAgentId!;
  const bringupInput = buildBringupJobInput({ ctx, setup, targetAgentId });
  try {
    const result = await setup.dispatcher.dispatch(bringupInput);
    logger.info('Dispatched init-runner bring-up for un-agented fan-out child', {
      runId: ctx.runId,
      workflow: ctx.workflow.name,
      targetAgentId,
      bringupStatus: result.status,
    });
  } catch (err) {
    logger.warn('Failed to dispatch init-runner bring-up', {
      runId: ctx.runId,
      targetAgentId,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Run and track the build job. Registers the run with the tracker so later
 * phases attach execution_jobs to a real run.
 */
async function runBuildJob(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  targetPlatform: string;
  targetArch: string;
  sourceHit: boolean;
  depHit: boolean;
  /** Jobs dispatch after the build; takes the token that stops finalizing on build terminal. */
  hasPostBuildJobs: boolean;
}): Promise<{
  buildJobId: string | undefined;
  buildJobName: string;
  buildJobLabels: string[] | undefined;
  buildJobTrackedEarly: boolean;
  rejected: boolean;
  /**
   * Set when `ensureBuild` rejects (typically a timeout). Returned, not thrown,
   * so the caller still sees a `buildJobId` inserted before the timer fired and
   * can fail the orphaned `dispatched` row.
   */
  error: unknown;
}> {
  const { ctx, setup, contentHash, lockfileHash } = args;
  const { deps, workflow, repoIdentifier, credentials, ref, runId } = ctx;
  const buildJobName = `__build__${workflow.name}`;
  let buildJobId: string | undefined;
  let buildJobLabels: string[] | undefined;
  let buildJobTrackedEarly = false;
  let rejected = false;
  let error: unknown;

  const coalescingKey = `${contentHash || 'none'}:${lockfileHash || 'none'}`;
  if (deps.checkRunReporter) {
    const [owner, repo] = repoIdentifier.split('/');
    deps.checkRunReporter.setBuildPending({
      provider: setup.info.provider,
      owner,
      repo,
      sha: ref,
      workflowName: workflow.name,
      installationId: (credentials as { installationId?: number }).installationId,
      routingKey: setup.info.routingKey,
      runId,
      requestId: getRequestContext().requestId,
    });
  }

  try {
    await deps.buildCoordinator!.ensureBuild(coalescingKey, async () => {
      const buildJobInput = buildBuildJobInput({ ...args, buildJobName });
      const result = await setup.dispatcher.dispatch(buildJobInput);
      if (result.status === 'rejected') {
        const reason = `Build job dispatch rejected: ${result.reason}`;
        logger.error(reason, { runId, workflow: workflow.name });
        rejected = true;
        if (deps.executionTracker) {
          const syntheticId = `rejected-${randomUUID()}`;
          await startTrackedRun(deps.executionTracker, ctx, setup, [
            {
              jobId: syntheticId,
              jobName: buildJobName,
              runsOnLabels: buildJobInput.runsOnLabels,
            },
          ]);
          await deps.executionTracker.failRun(runId, reason, {
            scope: 'run',
            category: InitFailureCategory.enum.build_coordination,
            message: reason,
          });
        }
        return;
      }
      buildJobId = result.jobId;
      buildJobLabels = buildJobInput.runsOnLabels;
      if (deps.executionTracker) {
        await startTrackedRun(deps.executionTracker, ctx, setup, [
          { jobId: buildJobId, jobName: buildJobName, runsOnLabels: buildJobLabels },
        ]);
        // `startRunBeforeDispatch` returns early for a build-tracked run, so
        // this site owes the row its trust context across the build window.
        await stampTrustContextBeforeDispatch(ctx);
        buildJobTrackedEarly = true;
        // The run holds the build job ALONE: without a token the build going
        // terminal satisfies isRunComplete and finalizes the run mid-build
        // (check status posted, terminal status forwarded). Taken before the
        // build can report terminal; released by dispatchMatchedWorkflow's
        // finally.
        //
        // The token guards only this process. A sibling coordinator whose
        // agent claims the build rehydrates from the row; the durable
        // registration-window column makes it defer, so the build wait must
        // not start before that has landed.
        if (args.hasPostBuildJobs && deps.executionTracker.holdRunForPendingJobs(runId)) {
          args.ctx.dispatchWindowTokenHeld = true;
          await deps.executionTracker.registrationWindowSettled(runId);
        }
      }
      if (
        deps.pendingBuilds &&
        (result.status === 'dispatched' ||
          result.status === 'queued' ||
          result.status === 'queued-no-backend')
      ) {
        // Settled by whichever channel sees the build finish: the local agent
        // socket, or the shared execution_jobs row when a sibling's agent ran it.
        await deps.pendingBuilds.track(result.jobId);
      }
    });
  } catch (err) {
    // Not re-thrown: the closure may already have set `buildJobId` /
    // `buildJobTrackedEarly`, which `recordBuildFailure` needs.
    error = err;
  }
  return { buildJobId, buildJobName, buildJobLabels, buildJobTrackedEarly, rejected, error };
}

/**
 * Record a build failure: failed check status, failed run row, and a minimal
 * failed run when the build threw before onExecutionStarted.
 */
async function recordBuildFailure(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildJobTrackedEarly: boolean;
  err: unknown;
  /**
   * The build's dispatch_queue id if inserted before `ensureBuild` rejected.
   * Failed directly, because `onBuildFailed`'s cascade fires only when
   * `buildJobTrackedEarly`, yet the row exists regardless.
   */
  buildJobId?: string | undefined;
}): Promise<void> {
  const { ctx, setup, buildJobTrackedEarly, err, buildJobId } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId } = ctx;
  if (deps.checkRunReporter) {
    const [owner, repo] = repoIdentifier.split('/');
    deps.checkRunReporter.setBuildComplete({
      provider: setup.info.provider,
      owner,
      repo,
      sha: ref,
      workflowName: workflow.name,
      status: ExecutionJobStatus.enum.failed,
      installationId: (credentials as { installationId?: number }).installationId,
      routingKey: setup.info.routingKey,
      description: `Build failed: ${toErrorMessage(err)}`,
      runId,
      requestId: getRequestContext().requestId,
    });
  }
  if (deps.executionTracker) {
    try {
      const buildFailureReason = toErrorMessage(err);
      const buildInitFailure: InitFailure = {
        scope: 'run',
        category: InitFailureCategory.enum.build_coordination,
        message: buildFailureReason,
      };
      if (buildJobTrackedEarly) {
        await deps.executionTracker.onBuildFailed(runId, buildInitFailure);
      } else {
        await deps.executionTracker.onBuildFailedBeforeTracking(
          runId,
          workflow.name,
          setup.info.provider,
          repoIdentifier,
          event.targetBranch,
          ref,
          setup.effectiveDeliveryId,
          credentials as Record<string, unknown>,
          setup.info.routingKey,
          dispatchTriggerEvent(ctx),
          extractCommitMessage(setup.info.event, setup.info.payload),
          buildFailureReason,
          buildInitFailure,
          preDispatchRunProvenance(ctx),
        );
      }
    } catch (cleanupErr) {
      logger.warn('Failed to mark run as failed after build error', {
        runId,
        error: toErrorMessage(cleanupErr),
      });
    }
  }
  // Fail the dispatch_queue row even when the run-level cascade cannot reach
  // it (timeout before `onExecutionStarted` returned); otherwise it stays
  // `Dispatched` until `job.complete` and pollers never see a terminal state.
  if (buildJobId) {
    try {
      await deps.dispatcher.cancelQueuedJob(buildJobId, `Build failed: ${toErrorMessage(err)}`);
    } catch (cleanupErr) {
      logger.warn('Failed to mark build job dispatch_queue row as failed', {
        runId,
        buildJobId,
        error: toErrorMessage(cleanupErr),
      });
    }
  }
}

/**
 * Cache-artifact fields every dispatch payload carries: tarball URLs and the
 * digests an agent verifies. One builder so a new field reaches every
 * dispatch path, not just some.
 */
function cacheArtifactFields(buildPrep: BuildPrepResult): {
  sourceTarUrl: string | undefined;
  sourceTarDigest: string | undefined;
  depsUrl: string | undefined;
  depsHash: string | undefined;
} {
  return {
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarDigest: buildPrep.sourceTarDigest,
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
  };
}

/** Post the build success check and read the final cache URLs. */
async function readPostBuildCacheUrls(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  targetPlatform: string;
  targetArch: string;
}): Promise<{
  sourceTarUrl: string | undefined;
  sourceTarDigest: string | undefined;
  depsUrl: string | undefined;
  depsHash: string | undefined;
}> {
  const { ctx, setup, contentHash, lockfileHash, targetPlatform, targetArch } = args;
  const { deps, workflow, repoIdentifier, credentials, ref, runId } = ctx;
  if (deps.checkRunReporter) {
    const [owner, repo] = repoIdentifier.split('/');
    deps.checkRunReporter.setBuildComplete({
      provider: setup.info.provider,
      owner,
      repo,
      sha: ref,
      workflowName: workflow.name,
      status: ExecutionJobStatus.enum.success,
      installationId: (credentials as { installationId?: number }).installationId,
      routingKey: setup.info.routingKey,
      runId,
      requestId: getRequestContext().requestId,
    });
  }
  let sourceTarUrl: string | undefined;
  let sourceTarDigest: string | undefined;
  let depsUrl: string | undefined;
  let depsHash: string | undefined;
  if (contentHash && deps.sourceCache) {
    const hit = await deps.sourceCache.getUrlAndDigest(ctx.resolvedOrgId, contentHash);
    sourceTarUrl = hit?.url;
    sourceTarDigest = hit?.digest;
  }
  if (lockfileHash && deps.depCache) {
    const depResult = await deps.depCache.getUrlAndHash(
      lockfileHash,
      targetPlatform,
      targetArch,
      ctx.fullLockFile?.siblingsDigest,
    );
    if (depResult) {
      depsUrl = depResult.url;
      depsHash = depResult.hash;
    }
  }
  return { sourceTarUrl, sourceTarDigest, depsUrl, depsHash };
}

/**
 * Resolve a `runsOnAll` job against the host roster and apply `onUnreachable`:
 * `ready` hosts run; unreachable `static` hosts hold / fail / skip; stale
 * ephemeral hosts are skipped. Throws {@link FanoutError} when the run cannot
 * proceed (fail policy with an absent host, or zero targets).
 */
export async function resolveHostFanoutTargets(
  lockJob: LockJob,
  deps: ProcessingDeps,
  target?: HostTargetSelector,
): Promise<ResolvedHostAgent[]> {
  if (!deps.hostRosterStore) {
    throw new FanoutError(lockJob.name, `runsOnAll for job '${lockJob.name}': roster unavailable`);
  }
  const predicate = lockJob.runsOnAll!;
  const onUnreachable = lockJob.onUnreachable ?? 'hold';
  // `includeUninitialized`: each unreachable static host becomes a bring-up
  // target (child held until an init-runner connects under its agentId)
  // instead of following `onUnreachable`.
  const includeUninitialized = lockJob.includeUninitialized === true;
  // `findFanoutTargets`, not `findMatching`: a scaler-spawned agent is never a
  // target, since pinning to one runs the child at the pool's fixed shape.
  const matched = await deps.hostRosterStore.findFanoutTargets(
    predicate.include,
    predicate.exclude,
    deps.rosterGraceMs ?? 300_000,
  );

  // `--target` only narrows; `matched` stays intact for the zero-host heuristic.
  const candidates = target
    ? matched.filter((h) => hostSatisfiesTarget(new Set(h.labels), target))
    : matched;
  const targetNarrowedToZero = !!target && matched.length > 0 && candidates.length === 0;

  const targets: MatchedHost[] = [];
  const bringupTargets: MatchedHost[] = [];
  const unreachableDurable: MatchedHost[] = [];
  for (const h of candidates) {
    if (h.status === HostStatus.ready) {
      targets.push(h);
    } else if (h.lifecycleClass === 'ephemeral') {
      continue; // stale ephemeral (scaled down) → skip, never policy-controlled
    } else if (includeUninitialized) {
      bringupTargets.push(h); // static + not live + opted into bring-up
    } else {
      unreachableDurable.push(h); // static + not currently live
    }
  }

  let skippedUnreachable = false;
  if (unreachableDurable.length > 0) {
    if (onUnreachable === 'fail') {
      throw new FanoutError(
        lockJob.name,
        `runsOnAll '${lockJob.name}': ${unreachableDurable.length} expected host(s) unreachable`,
        FanoutCause.error,
      );
    }
    if (onUnreachable === 'hold') {
      targets.push(...unreachableDurable); // pin queues + waits for each
    } else {
      skippedUnreachable = true; // 'skip' → omit them
    }
  }
  targets.push(...bringupTargets); // bring-up targets always run (init-or-not)

  if (targets.length === 0) {
    if (targetNarrowedToZero) {
      // `--target` removed every matched host; `allowEmpty` picks skipped
      // (downstream `when` governs) over failed.
      throw new FanoutError(
        lockJob.name,
        `--target left job '${lockJob.name}' with zero hosts`,
        target!.allowEmpty ? FanoutCause.narrowedEmpty : FanoutCause.error,
      );
    }
    // A narrow-to-empty caused by the skip policy (or stale-ephemeral-only
    // matches) is an intentional skip; a genuinely empty roster is a failure.
    const cause =
      skippedUnreachable || matched.length > 0 ? FanoutCause.narrowedEmpty : FanoutCause.error;
    throw new FanoutError(
      lockJob.name,
      `runsOnAll '${lockJob.name}' matched zero usable hosts`,
      cause,
    );
  }

  const bringupIds = new Set(bringupTargets.map((h) => h.agentId));
  return targets.map((h) => ({
    agentId: h.agentId,
    host: h.host,
    labels: h.labels,
    platform: h.platform ?? undefined,
    arch: h.arch ?? undefined,
    connectedInstanceId: h.connectedInstanceId,
    needsBringup: bringupIds.has(h.agentId),
  }));
}

/** Exact labels + regex patterns partitioned from a lock job's selectors. */
interface JobRoutingSelectors {
  runsOnLabels: string[];
  runsOnPatterns: LabelMatcher[];
  excludeLabels: string[];
  excludePatterns: LabelMatcher[];
  /**
   * `runsOn` exact values as spelled, before `partitionMatchers` folds them.
   * For {@link resolveRosterAgentPin} only: `host_roster.agent_id` is
   * case-sensitive, so the folded form misses ids with a capital.
   */
  runsOnExactRaw: string[];
}

/**
 * Partition runsOn / excludeLabels into exact labels (SQL `@>` prefilter +
 * registry index) and regex patterns (JS post-filter). A `runsOnAll` job has
 * no `runsOn`; its children route by pin.
 */
export function runsOnSelectorsForLockJob(lockJob: {
  runsOn?: readonly LabelMatcher[];
  excludeLabels?: readonly LabelMatcher[];
}): JobRoutingSelectors {
  const include = partitionMatchers(lockJob.runsOn ?? []);
  const exclude = partitionMatchers(lockJob.excludeLabels ?? []);
  return {
    runsOnLabels: include.exact,
    runsOnPatterns: include.regex,
    excludeLabels: exclude.exact,
    excludePatterns: exclude.regex,
    // `partitionMatchers` already validated (and thrown on) this array.
    runsOnExactRaw: (lockJob.runsOn ?? [])
      .filter((m) => m.kind === 'exact')
      .map((m) => (m as { kind: 'exact'; value: string }).value),
  };
}

/**
 * Runtime labels a job's shape demands of its host. Only a
 * `container.dockerfile` job gets one: building needs a `docker` / `podman`
 * CLI, which the agent self-reports as `kici:runtime:container-build`.
 *
 * A finalized `image` job deliberately gets NOTHING: an implicit requirement
 * on working jobs strands them. An agent too old to report the label cannot
 * build anyway.
 *
 * Applied to REGISTERED agents only, NOT the scaler: backends match by exact
 * label-set containment, so a label absent from the pool's set strands the job
 * `queued-no-backend`. What an agent can do is known once it registers.
 */
export function requiredRuntimeLabelsFor(container: unknown): string[] {
  if (!container || typeof container !== 'object') return [];
  const dockerfile = (container as { dockerfile?: unknown }).dockerfile;
  return typeof dockerfile === 'string' && dockerfile.length > 0
    ? [CONTAINER_BUILD_RUNTIME_LABEL]
    : [];
}

/**
 * Resolve the documented inventory pattern `runsOn: [h.agentId]` into a host
 * pin. A bare agentId is no advertised label, so label routing leaves it
 * `queued-no-backend`. When the single exact label names a roster host, pin it
 * (plus its coordinator for reroute), as `runsOnAll` children pin. Any other
 * shape returns null and keeps label routing.
 *
 * `runsOnExact` takes the lock's spelling, NOT folded labels: agent ids are
 * case-sensitive.
 */
export async function resolveRosterAgentPin(args: {
  runsOnExact: string[];
  runsOnPatterns: LabelMatcher[];
  hostRosterStore: HostRosterStore | undefined;
}): Promise<{ pinnedAgentId: string; connectedInstanceId: string | null } | null> {
  const { runsOnExact, runsOnPatterns, hostRosterStore } = args;
  if (!hostRosterStore) return null;
  if (runsOnExact.length !== 1 || runsOnPatterns.length > 0) return null;
  const candidate = runsOnExact[0];
  const row = await hostRosterStore.get(candidate);
  // An unconfirmed dashboard-declared row is not an inventory host.
  if (!row || row.identity_source === HostIdentitySource.platform) return null;
  return { pinnedAgentId: candidate, connectedInstanceId: row.connected_instance_id ?? null };
}

/**
 * Fan-out tracking columns for a child (label = matrix combination suffix or
 * hostname), so the dashboard groups on columns, not parsed names.
 */
function variantTrackingFields(mat: MaterializedJob): {
  baseJobName?: string;
  variantKind?: string;
  variantLabel?: string;
} {
  if (!mat.variantKind) return {};
  const variantLabel =
    mat.variantKind === VariantKind.host
      ? mat.host
      : mat.variantValues
        ? mat.expandedName.slice(mat.baseName.length + 2, -1) // text inside "(...)"
        : undefined;
  return {
    baseJobName: mat.baseName,
    variantKind: mat.variantKind,
    ...(variantLabel && { variantLabel }),
  };
}

/**
 * The persisted `gitCredentials` declaration: server truth the credential
 * relay authorizes a wire `ref` against on every git network operation.
 *
 * Copied verbatim; the relay compares byte for byte. `<name>Secret` is a
 * qualified `<context>:<key>` NAME; `<name>Value` is literal material for a
 * credential with no store entry. Never filter or normalize: a differing
 * value matches no request.
 */
function gitCredentialFields(lockJob: LockJob): {
  gitCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
} {
  return lockJob.gitCredentials ? { gitCredentials: lockJob.gitCredentials } : {};
}

/** Per-child rolling-wave plan: which children are held + the base's wave policy. */
export interface WavePlan {
  /** `expandedName`s held behind the wave gate (beyond the maxParallel window). */
  held: Set<string>;
  /** `expandedName` → the base's `{maxParallel, failFast}`, stamped on every child of a bounded wave. */
  policy: Map<string, { maxParallel: number; failFast: boolean }>;
}

/**
 * Rolling-wave plan. For a `maxParallel` base with more than one child,
 * children sort by `fanoutIndex` (else `expandedName`) and index `>=
 * maxParallel` is held (`wave_gated=true`); held children release
 * one-per-terminal via the wave-scheduler. Every child of a bounded base gets
 * a `policy` entry for the scheduler to read at terminal time.
 */
export function computeWavePlan(materializedJobs: readonly MaterializedJob[]): WavePlan {
  const byBase = new Map<string, MaterializedJob[]>();
  for (const mat of materializedJobs) {
    const list = byBase.get(mat.baseName);
    if (list) list.push(mat);
    else byBase.set(mat.baseName, [mat]);
  }
  const held = new Set<string>();
  const policy = new Map<string, { maxParallel: number; failFast: boolean }>();
  for (const children of byBase.values()) {
    const maxParallel = children[0]?.lockJob.maxParallel;
    if (maxParallel === undefined || children.length <= 1) continue;
    const failFast = children[0]?.lockJob.failFast ?? false;
    const ordered = [...children].sort((a, b) =>
      a.fanoutIndex !== undefined && b.fanoutIndex !== undefined
        ? a.fanoutIndex - b.fanoutIndex
        : a.expandedName.localeCompare(b.expandedName),
    );
    ordered.forEach((mat, i) => {
      policy.set(mat.expandedName, { maxParallel, failFast });
      if (i >= maxParallel) held.add(mat.expandedName);
    });
  }
  return { held, policy };
}

/**
 * Materialize each static job's fan-out. An invalid fan-out (zero combinations,
 * over the cap) is recorded as a failure so the run's other jobs proceed.
 * Dynamic-matrix jobs pass through marked `pendingDynamicMatrix`.
 */
export async function materializeStaticJobsSafe(
  staticJobs: readonly LockJob[],
  deps: ProcessingDeps,
  target?: HostTargetSelector,
): Promise<{
  materializedJobs: MaterializedJob[];
  expansionMap: Map<string, readonly string[]>;
  matrixFailures: RejectedJob[];
}> {
  const materializedJobs: MaterializedJob[] = [];
  const expansionMap = new Map<string, readonly string[]>();
  const matrixFailures: RejectedJob[] = [];
  for (const lockJob of staticJobs) {
    try {
      const maxFanoutHosts =
        (await deps.clusterSettings?.getNumber('max_fanout_hosts', deps.maxFanoutHosts ?? 1024)) ??
        deps.maxFanoutHosts ??
        1024;
      const result = lockJob.runsOnAll
        ? materializeResolvedHosts(
            lockJob,
            await resolveHostFanoutTargets(lockJob, deps, target),
            maxFanoutHosts,
          )
        : materializeFanout([lockJob]);
      materializedJobs.push(...result.jobs);
      for (const [k, v] of result.expansionMap) expansionMap.set(k, v);
    } catch (err) {
      if (err instanceof FanoutError) {
        const narrowed = err.cause === FanoutCause.narrowedEmpty;
        matrixFailures.push({
          jobId: `matrix-${narrowed ? 'skipped' : 'failed'}-${randomUUID()}`,
          jobName: lockJob.name,
          reason: err.message,
          ...(narrowed && { terminalStatus: ExecutionJobStatus.enum.skipped }),
        });
        // Map the zeroed base to its synthetic terminal job so downstreams get a
        // real edge; its skipped/failed status governs `when` propagation.
        expansionMap.set(lockJob.name, [lockJob.name]);
        continue;
      }
      throw err;
    }
  }
  return { materializedJobs, expansionMap, matrixFailures };
}

/** Phase B orchestrator: probe caches, run the build job when needed, report what later phases need. */
async function prepareCacheAndBuild(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
): Promise<BuildPrepResult> {
  const { deps, workflow, fullLockFile, localWorkingTree } = ctx;
  const contentHash = workflow.contentHash;
  const lockfileHash = fullLockFile.lockfileHash;
  const hasDynamicEntries = workflow.jobs.some(isLockDynamicJobFn);
  const staticJobs = workflow.jobs.filter(isLockStaticJob);
  const dynamicEntries = workflow.jobs.filter(isLockDynamicJobFn);

  const { targetPlatform, targetArch } = chooseTargetPlatform(workflow, deps.agentRegistry);

  const { sourceHit, depHit } = await probeCaches(
    ctx,
    setup,
    contentHash,
    lockfileHash,
    targetPlatform,
    targetArch,
  );

  let sourceTarUrl: string | undefined;
  let sourceTarDigest: string | undefined;
  let depsUrl: string | undefined;
  let depsHash: string | undefined;
  let buildJobId: string | undefined;
  let buildJobName: string | undefined;
  let buildJobLabels: string[] | undefined;
  let buildJobTrackedEarly = false;
  let buildFailed = false;

  // No build for a local-repo run (no bundle; working-tree overlay, nothing
  // remote to build) or a `file://` IN-PLACE run: the agent runs the real tree
  // under KICI_IN_PLACE (no clone, no source-restore), and a packed tarball
  // would carry a dist-less clone.
  const cacheInfraAvailable =
    buildableWorkflowRepo(ctx) &&
    !localWorkingTree &&
    !!ctx.bundle &&
    deps.buildCoordinator &&
    (deps.sourceCache || deps.depCache);
  // Either cache missing builds; see `buildIsNeeded`.
  const buildNeeded = buildIsNeeded({
    cacheInfraAvailable: Boolean(cacheInfraAvailable),
    sourceHit,
    contentHash,
    depHit,
    lockfileHash,
  });

  if (buildNeeded) {
    const buildStart = process.hrtime.bigint();
    const result = await runBuildJob({
      ctx,
      setup,
      contentHash,
      lockfileHash,
      targetPlatform,
      targetArch,
      sourceHit,
      depHit,
      hasPostBuildJobs: staticJobs.length > 0 || hasDynamicEntries,
    });
    buildJobId = result.buildJobId;
    buildJobName = result.buildJobName;
    buildJobLabels = result.buildJobLabels;
    buildJobTrackedEarly = result.buildJobTrackedEarly;
    if (result.rejected) {
      return {
        sourceTarUrl,
        sourceTarDigest,
        depsUrl,
        depsHash,
        contentHash,
        lockfileHash,
        hasDynamicEntries,
        dynamicEntries,
        staticJobs,
        materializedJobs: [],
        expansionMap: new Map(),
        matrixFailures: [],
        targetPlatform,
        targetArch,
        buildJobId,
        buildJobName,
        buildJobLabels,
        buildJobTrackedEarly,
        buildFailed: true,
        abort: true,
      };
    }
    if (result.error !== undefined) {
      const buildDuration = Number(process.hrtime.bigint() - buildStart) / 1e9;
      buildDurationSeconds.record(buildDuration);
      logger.warn('Build failed, skipping execution for workflow', {
        workflow: workflow.name,
        coalescingKey: `${contentHash || 'none'}:${lockfileHash || 'none'}`,
        error: toErrorMessage(result.error),
      });
      await recordBuildFailure({
        ctx,
        setup,
        buildJobTrackedEarly,
        err: result.error,
        buildJobId,
      });
      if (hasDynamicEntries) {
        buildFailed = true;
        logger.info(
          'Build failed but workflow has dynamic entries, continuing with dynamic dispatch',
          {
            workflow: workflow.name,
            dynamicEntryCount: dynamicEntries.length,
          },
        );
      } else {
        return {
          sourceTarUrl,
          sourceTarDigest,
          depsUrl,
          depsHash,
          contentHash,
          lockfileHash,
          hasDynamicEntries,
          dynamicEntries,
          staticJobs,
          materializedJobs: [],
          expansionMap: new Map(),
          matrixFailures: [],
          targetPlatform,
          targetArch,
          buildJobId,
          buildJobName,
          buildJobLabels,
          buildJobTrackedEarly,
          buildFailed: true,
          abort: true,
        };
      }
    } else {
      const buildDuration = Number(process.hrtime.bigint() - buildStart) / 1e9;
      buildDurationSeconds.record(buildDuration);
      ({ sourceTarUrl, sourceTarDigest, depsUrl, depsHash } = await readPostBuildCacheUrls({
        ctx,
        setup,
        contentHash,
        lockfileHash,
        targetPlatform,
        targetArch,
      }));
    }
  } else if (sourceHit && contentHash && deps.sourceCache) {
    const hit = await deps.sourceCache.getUrlAndDigest(ctx.resolvedOrgId, contentHash);
    sourceTarUrl = hit?.url;
    sourceTarDigest = hit?.digest;
  }

  if (depHit && lockfileHash && deps.depCache) {
    const depResult = await deps.depCache.getUrlAndHash(
      lockfileHash,
      targetPlatform,
      targetArch,
      ctx.fullLockFile?.siblingsDigest,
    );
    if (depResult) {
      depsUrl = depResult.url;
      depsHash = depResult.hash;
    }
  }

  if (!contentHash && deps.sourceCache) {
    logger.debug('Workflow missing contentHash, agents will compile from source', {
      workflow: workflow.name,
    });
  }

  const { materializedJobs, expansionMap, matrixFailures } = await materializeStaticJobsSafe(
    staticJobs,
    deps,
    ctx.target,
  );

  return {
    sourceTarUrl,
    sourceTarDigest,
    depsUrl,
    depsHash,
    contentHash,
    lockfileHash,
    hasDynamicEntries,
    dynamicEntries,
    staticJobs,
    materializedJobs,
    expansionMap,
    matrixFailures,
    targetPlatform,
    targetArch,
    buildJobId,
    buildJobName,
    buildJobLabels,
    buildJobTrackedEarly,
    buildFailed,
    abort: false,
  };
}

// ---------------------------------------------------------------------------
// Phase C — workflow secrets + ephemeral key
// ---------------------------------------------------------------------------

async function resolveWorkflowSecretsAndKey(
  ctx: WorkflowDispatchContext,
): Promise<SecretBundle | { skipDispatch: true; reason: string }> {
  const { deps, workflow, runId } = ctx;
  // Workflow-level contexts bind ahead of each job's own and resolve per job,
  // after its gates admit it (effectiveContextRefs); here only a missing
  // secrets subsystem fails fast.
  const declaredContexts = workflow.contexts ?? [];
  // fails-when: a workflow names contexts and KICI_SECRET_KEY is unset — dispatch is refused
  // breaks-if-wrong: a workflow with no workflow-level contexts must dispatch without a resolver
  if (declaredContexts.length > 0 && !deps.secretResolver) {
    const reason =
      'Workflow declares secret contexts but secrets subsystem is not configured (KICI_SECRET_KEY missing)';
    logger.error(reason, {
      workflow: workflow.name,
      contexts: declaredContexts,
    });
    return { skipDispatch: true, reason };
  }

  let runPublicKeyBase64: string | undefined;
  if (deps.db && deps.secretKey) {
    try {
      const { publicKey, privateKey } = generateRunKeyPair();
      const encryptedPrivKey = encryptPrivateKey(privateKey, deps.secretKey);
      runPublicKeyBase64 = publicKey.toString('base64');
      await deps.db
        .insertInto('run_ephemeral_keys')
        .values({
          run_id: runId,
          encrypted_private_key: encryptedPrivKey,
          public_key: runPublicKeyBase64,
        })
        .execute();
    } catch (err) {
      logger.warn('Failed to generate ephemeral key pair for run, secret outputs disabled', {
        runId,
        error: toErrorMessage(err),
      });
      runPublicKeyBase64 = undefined;
    }
  }

  return {
    declaredContexts,
    runPublicKeyBase64,
    npmRegistries: undefined,
    installEnvSecrets: undefined,
  };
}

// ---------------------------------------------------------------------------
// Phase C2 — workflow-level install auth (private npm registries + installEnv)
// ---------------------------------------------------------------------------

/** A workflow install gate that paused dispatch — surfaced to the caller. */
interface InstallGateHold {
  action: 'hold' | 'wait' | 'queue';
  envName: string;
  contextId: string;
  holdType: string;
  queueType: 'context' | 'security';
  requirement: ApprovalRequirement;
  /** Which contexts held and which were admitted; stored for the release. */
  record: InstallGateRecord;
}

/**
 * Resolve `registries:` and `installEnv:`: fire per-context protection rules,
 * look up each `<env>:<secret>`, validate registry URL schemes, apply the
 * contributor-trust strip. Rejects (malformed ref, missing env or secret, gate
 * non-pass, bad scheme) return `skipDispatch`; on accept, mutates
 * `secrets.npmRegistries` / `secrets.installEnvSecrets`.
 */
async function resolveWorkflowInstallSecrets(
  ctx: WorkflowDispatchContext,
  secrets: SecretBundle,
  skipProtectionGate: boolean,
): Promise<
  | { skipDispatch: true; reason: string }
  | { skipDispatch: false }
  | { held: true; hold: InstallGateHold }
> {
  const { deps, workflow, runId, resolvedOrgId, event, trustResolution } = ctx;
  const hasRegistries = workflow.registries && workflow.registries.length > 0;
  const hasInstallEnv = workflow.installEnv && workflow.installEnv.length > 0;
  if (!hasRegistries && !hasInstallEnv) return { skipDispatch: false };

  let allowHttp = false;
  if (deps.db) {
    try {
      const row = await deps.db
        .selectFrom('org_settings')
        .select('allow_http_npm_registries')
        .where('customer_id', '=', resolvedOrgId)
        .executeTakeFirst();
      allowHttp = row?.allow_http_npm_registries ?? false;
    } catch (err) {
      logger.warn('Failed to read org_settings.allow_http_npm_registries — defaulting to false', {
        runId,
        workflow: workflow.name,
        error: toErrorMessage(err),
      });
    }
  }

  const protectionContext: JobDispatchContext = {
    branch: policyBranch(ctx),
    triggerType: event.type,
    repository: policyRepo(ctx),
    runId,
    // Deterministic synthetic id so audit logs show the workflow scope.
    jobId: installGateJobId(workflow.name),
    internallyTriggered: ctx.internallyTriggered === true,
  };

  if (skipProtectionGate && !ctx.installGateRecord) {
    logger.warn(
      'Released install hold recorded no contexts; every install context is gated again',
      {
        runId,
        workflow: workflow.name,
      },
    );
  }
  const result = await resolveInstallSecrets({
    registries: workflow.registries,
    installEnv: workflow.installEnv,
    allowHttpNpmRegistries: allowHttp,
    resolvedOrgId,
    trustResolution,
    contextStore: deps.contextStore,
    secretResolver: deps.secretResolver,
    protectionContext,
    skipProtectionGate,
    ...(skipProtectionGate && { releasedHold: ctx.installGateRecord }),
  });

  if (result.decision === 'hold') {
    logger.info('Workflow install gate held dispatch', {
      runId,
      workflow: workflow.name,
      action: result.action,
      env: result.envName,
      holdType: result.holdType,
      heldContexts: result.record.held.map((c) => c.name),
      admittedContexts: result.record.admitted.map((c) => c.name),
    });
    return {
      held: true,
      hold: {
        action: result.action,
        envName: result.envName,
        contextId: result.contextId,
        holdType: result.holdType,
        queueType: result.queueType,
        requirement: result.requirement,
        record: result.record,
      },
    };
  }

  if (result.decision === 'reject') {
    logger.error('Workflow install-secrets resolution rejected dispatch', {
      runId,
      workflow: workflow.name,
      reason: result.reason,
    });
    return {
      skipDispatch: true,
      reason: `Workflow install-secrets resolution rejected dispatch: ${result.reason}`,
    };
  }

  if (result.contributorStripped) {
    logger.warn(
      'Skipping registries:/installEnv: resolution for untrusted contributor — install will fail naturally if private deps are required',
      {
        runId,
        workflow: workflow.name,
        contributor: trustResolution?.contributorUsername,
        tier: trustResolution?.tier,
      },
    );
  } else {
    logger.info('Resolved workflow install secrets', {
      runId,
      workflow: workflow.name,
      registryCount: result.npmRegistries?.length ?? 0,
      installEnvCount: result.installEnvSecrets ? Object.keys(result.installEnvSecrets).length : 0,
    });
  }

  secrets.npmRegistries = result.npmRegistries;
  secrets.installEnvSecrets = result.installEnvSecrets;
  return { skipDispatch: false };
}

// ---------------------------------------------------------------------------
// Phase D — per-job context evaluation
// ---------------------------------------------------------------------------

/** The `paths` lists this workflow's matching left to the agent, or undefined. */
export function deferredPathsOf(
  ctx: Pick<WorkflowDispatchContext, 'decision'>,
): string[][] | undefined {
  const deferred = ctx.decision.deferredPaths;
  return deferred && deferred.length > 0 ? deferred : undefined;
}

/**
 * Build the deferred init job for a job with dynamic fields, or for a workflow
 * whose filter or deferred paths need the agent's verdict.
 */
function buildDeferredInitJob(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  mat: MaterializedJob;
}): DeferredInitJob {
  const { ctx, setup, buildPrep, mat } = args;
  const lockJob = mat.lockJob;
  const { workflow, fullLockFile, bundle, repoIdentifier, credentials, event, ref, runId } = ctx;
  const initJobName = `__init__${workflow.name}__${mat.expandedName}`;
  const jobConfig: Record<string, unknown> = {
    initOnly: true,
    // Dynamic fields resolve against the BASE job (what findJobByName needs).
    targetJobName: mat.baseName,
    // A non-global `filter` is evaluated here before the dynamic fields; a
    // `false` verdict suppresses dispatch. Omitted (never `false`) when absent,
    // as the lock file records it.
    ...(workflow.hasFilter === true && { hasFilter: true }),
    // Paths matched only conservatively; the init job decides them from its
    // clone, and a no-match suppresses dispatch. Omitted when none, so an
    // older agent sees no change.
    ...(deferredPathsOf(ctx) && { deferredPaths: deferredPathsOf(ctx) }),
    workflowName: workflow.name,
    source: workflow.source?.file ?? fullLockFile.source.file,
    dynamicContext: (lockJob.contexts ?? []).some((e) => e.dynamic),
    dynamicEnv: lockJob.dynamicEnv ?? false,
    dynamicConcurrencyGroup: lockJob.dynamicConcurrencyGroup ?? false,
    dynamicMatrix: mat.pendingDynamicMatrix === true,
    event,
    timeoutMs: 60_000,
    ...(workflow.contentHash && !ctx.testRun && { contentHash: workflow.contentHash }),
    ...(workflow.resolvedHashFiles?.length && {
      resolvedHashFiles: workflow.resolvedHashFiles,
    }),
    // A global init job checks out both repositories, like its other jobs.
    ...globalJobConfigFor(ctx),
  };
  const initJobInput: QueuedJobInput = {
    runId,
    workflowName: workflow.name,
    jobName: initJobName,
    runsOnLabels: [
      INIT_RUNNER_ROLE_LABEL,
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig,
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarDigest: buildPrep.sourceTarDigest,
    // A global job restores the tarball into the workflow repository's checkout,
    // with or without a source pack.
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
  };
  return { mat, initJobInput };
}

/** The org's approval-hold expiry in seconds; 24h when unset. */
async function resolveApprovalExpiry(ctx: WorkflowDispatchContext): Promise<number> {
  const { deps, resolvedOrgId } = ctx;
  const fallback = 86400;
  if (!deps.db) return fallback;
  try {
    const row = await deps.db
      .selectFrom('org_settings')
      .select('approval_expiry_seconds')
      .where('customer_id', '=', resolvedOrgId)
      .executeTakeFirst();
    return row?.approval_expiry_seconds ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Deduped AND list of context reviewer, lock, and workflow approval clauses.
 * `workflowApproval` is passed only for a root job (the only kind held under a
 * workflow-scoped requirement); required so no call site silently drops it.
 */
function unionApprovalClauses(
  lockApproval: LockApproval | undefined,
  envClauses: ApproverClause[] | undefined,
  workflowApproval: LockApproval | undefined,
): ApproverClause[] {
  const all = [
    ...(envClauses ?? []),
    ...(lockApproval?.clauses ?? []),
    ...(workflowApproval?.clauses ?? []),
  ];
  const seen = new Set<string>();
  const deduped: ApproverClause[] = [];
  for (const clause of all) {
    const key = 'team' in clause ? `team:${clause.team}` : `user:${clause.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(clause);
  }
  return deduped;
}

/** Build a job-scoped explicit (SDK requireApproval) hold requirement. */
function buildExplicitJobHold(
  approval: LockApproval,
  orgExpirySeconds: number,
): PendingApprovalHold {
  const expirySeconds = approval.timeoutSeconds ?? orgExpirySeconds;
  return {
    scope: HoldScope.enum.job,
    triggerSource: TriggerSource.enum.explicit,
    contextId: null,
    queueType: 'context',
    requirement: {
      clauses: approval.clauses,
      expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      reason: approval.reason ?? 'Held for approval',
    },
  };
}

/**
 * Workflow-scoped hold from the lock `approval` block, carried by every root
 * job (no `needs`); downstream jobs wait on their `needs` edges. Each held root
 * re-dispatches on approval.
 */
function buildExplicitWorkflowHold(
  approval: LockApproval,
  orgExpirySeconds: number,
): PendingApprovalHold {
  const expirySeconds = approval.timeoutSeconds ?? orgExpirySeconds;
  return {
    scope: HoldScope.enum.workflow,
    triggerSource: TriggerSource.enum.explicit,
    contextId: null,
    queueType: 'context',
    requirement: {
      clauses: approval.clauses,
      expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      reason: approval.reason ?? 'Held for workflow approval',
    },
  };
}

/**
 * First workflow- or job-level approval with an invalid `timeoutSeconds`, or
 * null. Step-scope approvals are validated by the `step.approval-request`
 * wire schema instead.
 */
export function findInvalidApprovalTimeout(
  workflow: LockWorkflow,
): { scope: 'workflow' | 'job'; jobName?: string; value: number } | null {
  const invalid = (t: number | undefined): t is number =>
    t !== undefined && !approvalTimeoutSecondsSchema.safeParse(t).success;
  if (workflow.approval && invalid(workflow.approval.timeoutSeconds)) {
    return { scope: 'workflow', value: workflow.approval.timeoutSeconds };
  }
  for (const job of workflow.jobs.filter(isLockStaticJob)) {
    if (job.approval && invalid(job.approval.timeoutSeconds)) {
      return { scope: 'job', jobName: job.name, value: job.approval.timeoutSeconds };
    }
  }
  return null;
}

/**
 * Per-host secret-resolution facts for a host child (`mat.agent` preferred,
 * else `pinnedAgentId`/`host`). Undefined for a non-host child, whose
 * resolution stays fleet-wide (`'**'`-only).
 */
export function hostCtxFromMat(mat: MaterializedJob): HostFacts | undefined {
  if (mat.agent) {
    return { agentId: mat.agent.agentId, host: mat.agent.host, labels: mat.agent.labels };
  }
  if (mat.pinnedAgentId) {
    return { agentId: mat.pinnedAgentId, host: mat.host ?? mat.pinnedAgentId, labels: [] };
  }
  return undefined;
}

/**
 * Warning naming bound contexts unavailable to a test run (non-test or
 * unconfigured) and the contexts the job runs with instead.
 */
function formatTestRunUnavailableEnvWarning(unavailable: string[], remaining: string[]): string {
  const names = unavailable.map((n) => `'${n}'`).join(', ');
  const tail = remaining.length
    ? `running with ${remaining.map((n) => `'${n}'`).join(', ')}`
    : 'running with no context variables';
  return `bound context(s) ${names} are unavailable for this test run and were skipped; ${tail}`;
}

/**
 * Mint the approval holds the LOCK FILE alone decides: the job's
 * `requireApproval`, and the workflow's on a root job.
 *
 * Separate from {@link applyContextRulesAndSecrets} because they are knowable
 * at dispatch for every job, including one whose dynamic fields defer to an
 * init round; inside the per-job block (below the deferral) a job pairing
 * `requireApproval` with any dynamic field dispatched ungated.
 *
 * Both guard on `!jobEnvData.approvalHold`, so an earlier context hold wins: it
 * unions the job's and (on a root) the workflow's clauses, so it is strictly
 * stronger. Call this AFTER the context rules, never before.
 */
async function applyStaticApprovalHolds(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, lockJob, jobEnvData } = args;
  const { deps } = ctx;
  // An approval this orchestrator cannot enforce (no heldRunStore) must be
  // loud: the job dispatches ungated, logged as an error like the dynamicJob path.
  if (lockJob.approval && !jobEnvData.approvalHold && !jobEnvData.rejected && !deps.heldRunStore) {
    logger.error('Job requires approval but no held-run store is configured — running it UNGATED', {
      runId: ctx.runId,
      workflow: ctx.workflow.name,
      job: lockJob.name,
    });
  }
  if (lockJob.approval && !jobEnvData.approvalHold && !jobEnvData.rejected && deps.heldRunStore) {
    jobEnvData.held = true;
    jobEnvData.approvalHold = buildExplicitJobHold(
      lockJob.approval,
      await resolveApprovalExpiry(ctx),
    );
  }
  // Holding every root (no `needs`) holds the whole run via `needs` edges.
  const isRootJob = !lockJob.needs || lockJob.needs.length === 0;
  if (
    ctx.workflow.approval &&
    isRootJob &&
    !jobEnvData.approvalHold &&
    !jobEnvData.rejected &&
    deps.heldRunStore
  ) {
    jobEnvData.held = true;
    jobEnvData.approvalHold = buildExplicitWorkflowHold(
      ctx.workflow.approval,
      await resolveApprovalExpiry(ctx),
    );
  }
}

/**
 * The bound contexts that participate in this dispatch; records the run's
 * context identity on `jobEnvData`. Null when none does (all unconfigured or
 * test-skipped): the job dispatches with its own env, since a bound `context:`
 * never rejects on absence. `env` stays optional for
 * `evaluateMultiContextGates`; the caller narrows after the reject gates.
 */
async function resolveParticipatingContexts(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  contextNames: readonly string[];
  jobEnvData: JobEnvData;
}): Promise<Array<{ name: string; env: EngineContext | undefined }> | null> {
  const { ctx, lockJob, contextNames, jobEnvData } = args;
  const { deps, runId, workflow, resolvedOrgId } = ctx;
  if (!deps.contextStore) return null;

  let matched: Array<{ name: string; env: EngineContext | undefined }> = [];
  for (const name of contextNames) {
    const cfg = await deps.contextStore.matchContext(resolvedOrgId, name);
    matched.push({ name, env: cfg ? toContext(cfg) : undefined });
  }

  // The context column and concurrency grouping use the first declared name,
  // configured or not.
  jobEnvData.contextName = contextNames[0];
  // Captured before the missing/test-skip filtering, which governs only
  // protection rules and secrets, not history identity.
  jobEnvData.contextId = matched[0]?.env?.id;

  // Lenient: an unconfigured bound name contributes no rules or vars.
  const missing = matched.filter((m) => !m.env).map((m) => m.name);
  if (missing.length > 0) {
    logger.warn('bound context(s) not configured; skipping', {
      runId,
      workflow: workflow.name,
      job: lockJob.name,
      missing,
    });
    matched = matched.filter((m) => m.env);
  }

  // A test/local run never rejects on a bound context: non-test
  // (`allowLocalExecution === false`) or unconfigured ones are dropped (vars,
  // secrets and gates) and named in one warning. The fixture `secrets:` gate
  // stays fail-closed.
  if (ctx.testRun) {
    const skipped = matched.filter((m) => m.env && m.env.allowLocalExecution === false);
    if (skipped.length > 0) {
      jobEnvData.skippedEnvs = skipped.map((m) => m.name);
      matched = matched.filter((m) => !(m.env && m.env.allowLocalExecution === false));
    }
    const unavailable = [...missing, ...skipped.map((m) => m.name)];
    if (unavailable.length > 0) {
      jobEnvData.envWarning = formatTestRunUnavailableEnvWarning(
        unavailable,
        matched.map((m) => m.name),
      );
      logger.warn('test-run: bound context(s) unavailable for this test run; skipped', {
        runId,
        workflow: workflow.name,
        job: lockJob.name,
        unavailable,
      });
    }
    if (matched.length === 0) return null; // dispatch with no env vars — never reject
  }

  if (matched.length === 0) return null;

  return matched;
}

/**
 * In-pass admission tally key. The org id mirrors the count query's
 * `customer_id` scoping so a shared context name never leaks concurrency
 * across tenants — a standing invariant, since one pass has one org.
 * `JSON.stringify`, not concatenation, so no separator makes pairs collide.
 */
export function concurrencyAdmissionKey(orgId: string, concurrencyGroup: string): string {
  return JSON.stringify([orgId, concurrencyGroup]);
}

/** Names admitted under one tally key, created on first use. */
function admittedJobNames(ctx: WorkflowDispatchContext, admissionKey: string): Set<string> {
  ctx.concurrencyAdmissions ??= new Map();
  let names = ctx.concurrencyAdmissions.get(admissionKey);
  if (!names) {
    names = new Set();
    ctx.concurrencyAdmissions.set(admissionKey, names);
  }
  return names;
}

/**
 * Give back a slot an admitted job will never use: a dynamic-matrix
 * placeholder, gated before its children replace it, or N children take N+1
 * slots. Keyed by NAME so it never releases a sibling's reservation.
 */
function releaseAdmission(
  ctx: WorkflowDispatchContext,
  admissionKey: string,
  jobName: string,
): void {
  admittedJobNames(ctx, admissionKey).delete(jobName);
}

/** The gate-time facts a matrix fan-out replays once per child. */
interface ContextGateInputs {
  /** Aggregated effective context of every bound context. */
  env: EngineContext;
  dispatchCtx: JobDispatchContext;
  effectiveConcurrencyGroup: string;
  trustTier: TrustTier | undefined;
  /**
   * Expanded name = the row's `execution_jobs.job_name`, so the identity the
   * tally reserves and the count query excludes. Per child in a fan-out.
   */
  jobName: string;
}

/** {@link ContextGateInputs} plus what this job's own evaluation consumed. */
interface ContextGateHandle extends ContextGateInputs {
  /** Tally key this job's admission was counted under. */
  admissionKey: string;
  /** True when the gate PASSED, so this job holds an in-pass slot. */
  admitted: boolean;
}

/**
 * Evaluate one job against its contexts' protection rules; record the verdict
 * on `jobEnvData`. Separate so a dynamic-matrix fan-out re-gates per child
 * without re-resolving scoped secrets and emitting N audit lines.
 *
 * The concurrency count is the DB count PLUS siblings admitted this pass, the
 * latter only when `dispatchesThisPass`. The terms are disjoint BY
 * CONSTRUCTION, not timing: the query excludes the tally's names, so each
 * contributes only its tally entry, this job contributes to neither, and
 * others only their rows — whatever order the pass reaches its jobs.
 */
async function applyContextProtectionGates(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  gate: ContextGateInputs;
  jobEnvData: JobEnvData;
  /**
   * Whether this job reaches an agent THIS pass, so joins the tally. Default
   * `true`.
   *
   * A needs-gated job (stored under a `needs-pending-` id for the needs
   * scheduler) does not. If it reserved a slot and got queued, the hold path —
   * evaluated BEFORE the needs branch — would bypass the needs scheduler, and
   * the queued-hold release would dispatch it with no upstream check, beside a
   * pending or after a FAILED upstream.
   */
  dispatchesThisPass?: boolean;
}): Promise<ContextGateHandle> {
  const { ctx, lockJob, gate, jobEnvData } = args;
  const dispatchesThisPass = args.dispatchesThisPass ?? true;
  const { deps, runId, workflow, resolvedOrgId } = ctx;
  const { env, dispatchCtx, effectiveConcurrencyGroup, trustTier, jobName } = gate;

  // RESERVE synchronously, before any await: two dynamic-matrix flow-backs
  // resuming inside the awaits would otherwise both be admitted against one
  // slot. A non-pass verdict releases it.
  const admissionKey = concurrencyAdmissionKey(resolvedOrgId, effectiveConcurrencyGroup);
  const admitted = admittedJobNames(ctx, admissionKey);
  if (dispatchesThisPass) admitted.add(jobName);

  // One tally snapshot plus this job drives BOTH terms. This job is excluded
  // from both (the gate counts OTHERS' slots), so a job whose row exists (init
  // round, retry) does not gate itself out.
  const excludeJobNames = new Set(admitted);
  excludeJobNames.add(jobName);
  // The SHARED occupied-slot definition (also the ready re-gate and release
  // sweep): occupied from dispatch, not `running`, or a burst inside the
  // agent-provisioning window is admitted against one slot.
  const occupiedElsewhere = deps.db
    ? await countOccupyingJobs(deps.db, resolvedOrgId, effectiveConcurrencyGroup, {
        runId,
        jobNames: [...excludeJobNames],
      })
    : 0;
  // Sized from the SAME set the query excluded, not a fresh tally read: a
  // sibling reserving mid-query is outside the exclusion and would count twice
  // once its row lands. A job not dispatching this pass uses the count alone.
  const occupiedBySiblings = dispatchesThisPass ? excludeJobNames.size - 1 : 0;

  const gateResult = await evaluateProtectionRules(
    env,
    dispatchCtx,
    occupiedElsewhere + occupiedBySiblings,
    effectiveConcurrencyGroup,
    trustTier,
  );
  if (dispatchesThisPass && gateResult.action !== 'pass') {
    // Holds no slot; deleting its own name never touches a sibling's.
    admitted.delete(jobName);
  }
  const handle: ContextGateHandle = {
    ...gate,
    admissionKey,
    // Outside the tally means no slot for `releaseAdmission` to give back.
    admitted: dispatchesThisPass && gateResult.action === 'pass',
  };

  if (gateResult.action === 'reject') {
    jobEnvData.rejected = true;
    jobEnvData.rejectReason = gateResult.reason ?? DEFAULT_CONTEXT_REJECT_REASON;
    logger.info('Job rejected by protection rules', {
      runId,
      workflow: workflow.name,
      job: lockJob.name,
      reason: gateResult.reason,
    });
  } else if (
    gateResult.action === 'hold' ||
    gateResult.action === 'wait' ||
    gateResult.action === 'queue'
  ) {
    const holdExpiryMs = (env.holdExpirySeconds ?? DEFAULT_HOLD_EXPIRY_SECONDS) * 1000;
    const expiresAt = (
      gateResult.holdUntil ? new Date(gateResult.holdUntil) : new Date(Date.now() + holdExpiryMs)
    ).toISOString();
    const isApprovalHold =
      gateResult.action === 'hold' &&
      (gateResult.holdType ?? HoldType.enum.reviewer) === HoldType.enum.reviewer;
    // A reviewer hold is created by the dispatch loop, which also stores the
    // resume context.
    if (deps.heldRunStore && isApprovalHold) {
      // REPLACES what `applyStaticApprovalHolds` would mint, so it carries
      // every source; the workflow clause applies to root jobs only.
      const isRoot = !lockJob.needs || lockJob.needs.length === 0;
      const explicit = unionApprovalClauses(
        lockJob.approval,
        gateResult.clauses,
        isRoot ? workflow.approval : undefined,
      );
      jobEnvData.approvalHold = {
        scope: HoldScope.enum.job,
        triggerSource: TriggerSource.enum.context,
        contextId: env.id,
        queueType: 'context',
        requirement: {
          clauses: explicit,
          expiresAt,
          reason: gateResult.reason ?? 'Held for approval',
        },
      };
    } else if (deps.heldRunStore) {
      // Carried: `holdJobForApproval` writes it with the pending context, so no
      // hold exists without a resume path.
      jobEnvData.nonApprovalHold = {
        runId,
        jobId: dispatchCtx.jobId,
        contextId: env.id,
        holdType: gateResult.holdType ?? HoldType.enum.reviewer,
        queueType: gateResult.holdType === HoldType.enum.security ? 'security' : 'context',
        reason: gateResult.reason ?? `Held by ${gateResult.action} gate`,
        expiresAt: new Date(expiresAt),
      };
    }
    jobEnvData.held = true;
    logger.info('Job held by protection rules', {
      runId,
      workflow: workflow.name,
      job: lockJob.name,
      action: gateResult.action,
      holdType: gateResult.holdType,
      reason: gateResult.reason,
    });
    // A security hold's pending `KiCI Security` check is NOT posted here: every
    // route that settles it goes through a `held_runs` row, so a post without
    // the row (no store, rolled back) strands it. `holdJobForApproval` posts it
    // after the row and resume context commit.
  }
  return handle;
}

/**
 * Resolve bound contexts, run their gates, and on admission resolve their
 * variables and scoped secrets onto `jobEnvData`. Returns the handle a
 * dynamic-matrix fan-out re-gates children with; undefined when no gate ran.
 */
async function applyContextRulesAndSecrets(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  /**
   * `held_runs.job_id` for a hold created here; NOT `lockJob.name`, which
   * matrix siblings share.
   */
  expandedName: string;
  contextNames: readonly string[];
  concurrencyGroup: string | undefined;
  jobEnvData: JobEnvData;
  hostCtx?: HostFacts;
  /** See {@link applyContextProtectionGates}. Default `true`. */
  dispatchesThisPass?: boolean;
  /** Default `true`; a generated job (no container) passes `false`. */
  resolveRegistryAuth?: boolean;
}): Promise<ContextGateHandle | undefined> {
  const { ctx, lockJob, expandedName, contextNames, concurrencyGroup, jobEnvData, hostCtx } = args;
  const resolveRegistryAuth = args.resolveRegistryAuth ?? true;
  const { deps, event, runId, workflow, resolvedOrgId } = ctx;
  const { trustResolution } = ctx;
  if (!deps.contextStore) return undefined;

  const participating = await resolveParticipatingContexts({
    ctx,
    lockJob,
    contextNames,
    jobEnvData,
  });
  if (!participating) return undefined;
  const matched = participating;

  // Readers of `held_runs.job_id` (dashboard queue, `kici approve --job`, MCP
  // approve/reject) resolve it as the job name.
  const jobId = expandedName;
  const dispatchCtx: JobDispatchContext = {
    branch: policyBranch(ctx),
    triggerType: event.type,
    repository: policyRepo(ctx),
    runId,
    jobId,
    internallyTriggered: ctx.internallyTriggered === true,
  };

  // All-must-pass reject gates (enabled/branch/trigger/repo); the reason names
  // the offending context and rule.
  const rejections = evaluateMultiContextGates(matched, dispatchCtx);
  if (rejections.length > 0) {
    jobEnvData.rejected = true;
    jobEnvData.rejectReason = formatMultiContextRejection(rejections);
    logger.warn('multi-env gate rejection', {
      runId,
      workflow: workflow.name,
      job: lockJob.name,
      rejections,
    });
    return undefined;
  }

  const present = matched.map((m) => ({ name: m.name, env: m.env as EngineContext }));
  // The configured primary context drives merged-data resolution.
  jobEnvData.contextName = present[0].name;
  const eff = aggregateProtectionParams(present.map((p) => p.env));
  const env = buildEffectiveContext(present[0].env, eff);

  const effectiveConcurrencyGroup = concurrencyGroup ?? present[0].name;
  const gateHandle = await applyContextProtectionGates({
    ctx,
    lockJob,
    gate: {
      env,
      dispatchCtx,
      effectiveConcurrencyGroup,
      trustTier: trustResolution?.tier as TrustTier | undefined,
      jobName: expandedName,
    },
    jobEnvData,
    ...(args.dispatchesThisPass !== undefined && {
      dispatchesThisPass: args.dispatchesThisPass,
    }),
  });

  const registryAuth =
    resolveRegistryAuth && lockJob.container && typeof lockJob.container === 'object'
      ? {
          container: lockJob.container,
          dispatchCtx,
          ...(trustResolution?.tier && { trustTier: trustResolution.tier as TrustTier }),
        }
      : undefined;

  if (jobEnvData.rejected) return gateHandle;
  // Recorded for every admitted job: one the static approval gate holds next,
  // or one awaiting upstream, is stored without context data and resolves it
  // from this record at dispatch.
  jobEnvData.contextResolution = {
    contexts: present.map((p) => ({ name: p.name, id: p.env.id })),
    orgId: resolvedOrgId,
    routingKey: policyRoutingKey(ctx),
    resolvesSecrets: deps.secretResolver != null,
    ...(hostCtx && { hostCtx: { ...hostCtx, labels: [...hostCtx.labels] } }),
    ...(registryAuth && { registryAuth }),
  };
  if (!jobEnvData.held) {
    try {
      await resolveContextJobData({
        deps,
        orgId: resolvedOrgId,
        entries: present,
        hostCtx,
        routingKey: policyRoutingKey(ctx),
        registryAuth,
        log: { runId, workflow: workflow.name, job: lockJob.name },
        into: jobEnvData,
      });
    } catch (err) {
      logger.error('Per-job secret resolution failed', {
        runId,
        workflow: workflow.name,
        job: lockJob.name,
        context: present.map((p) => p.name).join(','),
        error: toErrorMessage(err),
      });
    }
  }
  // A held job's release path resolves the data from the record above.
  return gateHandle;
}

/**
 * Phase D — evaluate static jobs' context data, queue deferred-init jobs for
 * dynamic fields, and pick the run's `runContextName`.
 */
export async function evaluateJobContexts(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
}): Promise<JobEnvEvalResult> {
  const { ctx, setup, buildPrep } = args;
  const { deps, workflow } = ctx;
  const jobContextData = new Map<string, JobEnvData>();
  const deferredInitJobs: DeferredInitJob[] = [];
  let runContextName: string | undefined;
  let runContextId: string | undefined;

  for (const mat of buildPrep.materializedJobs) {
    const lockJob = mat.lockJob;
    const jobEnvData: JobEnvData = {};
    const { names: contextNames, needsInit: envNeedsInit } = resolveJobContextNames(
      workflow,
      lockJob,
    );
    const displayEnvNames = buildJobContextDisplayNames(workflow, lockJob);
    if (displayEnvNames.length > 0) jobEnvData.contextNames = displayEnvNames;
    // A dynamic field is known only once the agent runs the workflow module, so
    // the init result drives the per-job block instead.
    const needsInit =
      envNeedsInit ||
      lockJob.dynamicEnv === true ||
      lockJob.dynamicConcurrencyGroup === true ||
      // The agent runs the matrix fn; the init-result path re-materializes N children.
      mat.pendingDynamicMatrix === true;

    if (needsInit && deps.pendingInits) {
      // Approval is minted in the FLOW-BACK, not here: `held` set now would make
      // `applyContextRulesAndSecrets` skip its `!held` block, so context vars,
      // secrets and registry auth never resolve into the stored release input.
      // Context rules first, static holds after, holds on this path too.
      //
      // Nothing before the flow-back reads `held`: the dispatch loop and peer
      // filter exclude a `pendingInit` job first.
      jobEnvData.pendingInit = true;
      deferredInitJobs.push(buildDeferredInitJob({ ctx, setup, buildPrep, mat }));
      jobContextData.set(mat.expandedName, jobEnvData);
      continue;
    }

    const jobEnv: Record<string, string> | undefined = lockJob.dynamicEnv ? undefined : lockJob.env;
    const concurrencyGroup: string | undefined =
      lockJob.dynamicConcurrencyGroup || typeof lockJob.concurrencyGroup !== 'string'
        ? undefined
        : lockJob.concurrencyGroup;

    if (jobEnv) jobEnvData.jobEnv = jobEnv;
    if (contextNames.length > 0) {
      // Populates jobEnvData.contextId; the first env-bearing job names the run.
      await applyContextRulesAndSecrets({
        ctx,
        lockJob,
        expandedName: mat.expandedName,
        contextNames,
        concurrencyGroup,
        jobEnvData,
        hostCtx: hostCtxFromMat(mat),
        // A needs-gated job dispatches later via the needs scheduler: no slot.
        dispatchesThisPass: isRootJob(lockJob),
      });
      if (!runContextName) {
        runContextName = contextNames[0];
        runContextId = jobEnvData.contextId;
      }
    }
    await applyStaticApprovalHolds({ ctx, lockJob, jobEnvData });
    // A workflow `filter` defers only the DISPATCH, never the evaluation above
    // (contexts, vars, secrets, reject rules, approval hold); the dynamic-field
    // `continue` would silently drop all of that.
    //
    // A rejected or held job gets no init job: the flow-back would dispatch it
    // past its hold. A held job's filter is never evaluated; approval gates it.
    //
    // Deferred paths are the init job's second verdict: a match made without
    // changed files learns from the clone whether its `paths` match.
    if (
      (workflow.hasFilter === true || deferredPathsOf(ctx) !== undefined) &&
      deps.pendingInits &&
      !jobEnvData.rejected &&
      !jobEnvData.held
    ) {
      jobEnvData.pendingInit = true;
      deferredInitJobs.push(buildDeferredInitJob({ ctx, setup, buildPrep, mat }));
    }
    jobContextData.set(mat.expandedName, jobEnvData);
  }
  return { jobContextData, deferredInitJobs, runContextName, runContextId };
}

// ---------------------------------------------------------------------------
// Sandbox escape-hatch resolution (single enforcement point)
// ---------------------------------------------------------------------------

/**
 * Resolve every `sandbox:` request against the org allow-list. Deny is loud and
 * total: the first disallowed request returns `{ denied }` and the run fails —
 * never silently stripped. A non-escalating request adds no grant. The agent
 * applies only these grants and never reads the allow-list.
 */
function resolveWorkflowSandboxGrants(
  workflow: LockWorkflow,
  allowList: SandboxAllowList,
): { grants: Map<string, ResolvedSandboxGrant> } | { denied: { reason: string } } {
  const grants = new Map<string, ResolvedSandboxGrant>();
  for (const job of workflow.jobs) {
    if (job._type !== 'static' || !job.sandbox) continue;
    const res = resolveSandboxGrant(job.sandbox, allowList);
    if ('denied' in res) {
      return { denied: { reason: `job '${job.name}': ${res.denied.reason}` } };
    }
    if (res.grant) grants.set(job.name, res.grant);
  }
  return { grants };
}

/** The org's Dockerfile-build opt-in; DENY on a read failure, so it never widens. */
async function readAllowUntrustedDockerfileBuilds(ctx: WorkflowDispatchContext): Promise<boolean> {
  if (!ctx.deps.db) return false;
  try {
    const row = await ctx.deps.db
      .selectFrom('org_settings')
      .select('allow_untrusted_dockerfile_builds')
      .where('customer_id', '=', ctx.resolvedOrgId)
      .executeTakeFirst();
    return row?.allow_untrusted_dockerfile_builds ?? false;
  } catch (err) {
    logger.warn(
      'Failed to read org_settings.allow_untrusted_dockerfile_builds — defaulting to deny',
      { runId: ctx.runId, workflow: ctx.workflow.name, error: toErrorMessage(err) },
    );
    return false;
  }
}

/**
 * Refuse a Dockerfile build on an untrusted ref unless the org opted in. The
 * build runs arbitrary `RUN` commands on the host daemon, OUTSIDE the hardened
 * posture (`docker build` cannot be capability-restricted). Untrusted = fork
 * PR, unresolved contributor, or internal run without a trusted emitter (the
 * user-cache write-scope classification) — including a `kiciEvent()`
 * subscriber that inherited an `unknown` tier or nothing at all.
 *
 * Enforced only here, at dispatch; the agent applies what dispatch authorized,
 * as for sandbox grants. Deny is loud and total.
 */
export function resolveWorkflowDockerfileBuilds(
  workflow: LockWorkflow,
  opts: { scope: CacheRefScope; allowUntrusted: boolean },
): { allowed: true } | { denied: { reason: string } } {
  // A trusted ref needs no permission, and an org that opted in has given it.
  if (opts.scope === CacheRefScope.enum.shared || opts.allowUntrusted) return { allowed: true };

  for (const job of workflow.jobs) {
    if (job._type !== 'static') continue;
    const { container } = job;
    if (!container || typeof container === 'string' || !container.dockerfile) continue;

    return {
      denied: {
        reason:
          `job '${job.name}' builds its container image from ${container.dockerfile}, which is ` +
          `not allowed for an untrusted ref (a fork PR, a contributor whose trust could not be ` +
          `resolved, or an internally-triggered run without a trusted emitter). The build runs ` +
          `on the agent host, outside the job sandbox. Enable it ` +
          `for this organization with \`kici-admin org-settings ` +
          `allow-untrusted-dockerfile-builds true\`.`,
      },
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Build job config factory
// ---------------------------------------------------------------------------

function makeBuildJobConfig(args: {
  workflow: LockWorkflow;
  fullLockFile: WorkflowDispatchContext['fullLockFile'];
  jobContextData: Map<string, JobEnvData>;
  runPublicKeyBase64: string | undefined;
  npmRegistries: NpmRegistrySpec[] | undefined;
  installEnvSecrets: Record<string, string> | undefined;
  event: SimulatedEvent;
  /** See `WorkflowDispatchContext.eventEnvelopeOverride`. */
  eventEnvelopeOverride: Record<string, unknown> | undefined;
  /** Namespaces the user-facing cache. */
  cacheOrgId: string;
  /** Second user-cache namespacing level ("owner/repo"). */
  cacheRepoId: string;
  /** Trusted => shared, else isolated. */
  cacheRefScope: CacheRefScope;
  /**
   * True for `kici run`, whose overlay may differ from the committed lock; no
   * `contentHash` makes the agent skip the lock-vs-source check.
   */
  omitContentHash: boolean;
  /** See `WorkflowDispatchContext.runWideFlatSecrets`; the run-wide value wins. */
  runWideFlatSecrets: Record<string, string> | undefined;
  /** See `WorkflowDispatchContext.dispatchInputs`. */
  dispatchInputs: Record<string, unknown> | undefined;
  /**
   * Allow-listed sandbox grants by lock-job name (a denied request already
   * failed the run). Absent ⇒ default hardened posture.
   */
  resolvedSandboxGrants: ReadonlyMap<string, ResolvedSandboxGrant>;
}): BuildJobConfigFn {
  const {
    workflow,
    fullLockFile,
    jobContextData,
    runPublicKeyBase64,
    npmRegistries,
    installEnvSecrets,
    event,
    eventEnvelopeOverride,
    cacheOrgId,
    cacheRepoId,
    cacheRefScope,
    omitContentHash,
    runWideFlatSecrets,
    dispatchInputs,
    resolvedSandboxGrants,
  } = args;
  return (mat: MaterializedJob): Record<string, unknown> => {
    const lockJob = mat.lockJob;
    const envData = jobContextData.get(mat.expandedName);
    return {
      source: workflow.source ?? fullLockFile.source,
      workflowName: workflow.name,
      // Expanded name for reporting and log labels; the agent exposes the BASE
      // name as ctx.job.name and the combination only via ctx.matrix.
      name: mat.expandedName,
      baseJobName: mat.baseName,
      ...(mat.variantValues && { matrixValues: mat.variantValues }),
      ...(dispatchInputs && { dispatchInputs }),
      // Exposed as ctx.host / ctx.agent.
      ...(mat.host && { host: mat.host }),
      ...(mat.agent && {
        agent: {
          host: mat.agent.host,
          labels: [...mat.agent.labels],
          ...(mat.agent.platform && { platform: mat.agent.platform }),
          ...(mat.agent.arch && { arch: mat.agent.arch }),
        },
      }),
      // Deterministic ordinal, exposed as ctx.fanout.
      ...fanoutEnvelopeFields(mat),
      // Read by the dispatcher at selection; the agent ignores it. Default
      // deterministic.
      ...(lockJob.runsOnPick && { runsOnPick: lockJob.runsOnPick }),
      steps: lockJob.steps,
      needs: lockJob.needs,
      rules: lockJob.rules,
      // Selects the agent's container backend (top priority in
      // determineExecutionMode); dropped, the job silently runs bare-metal.
      ...(lockJob.container && { container: lockJob.container }),
      // Secret NAMES; the agent names one by key and the credential relay checks
      // it against `execution_jobs.git_credentials`. Without it `credential: 'x'`
      // throws and `default` silently falls back to the source credential.
      ...(lockJob.gitCredentials && { gitCredentials: lockJob.gitCredentials }),
      // Absent ⇒ default hardened posture.
      ...(resolvedSandboxGrants.get(lockJob.name) && {
        sandboxGrant: resolvedSandboxGrants.get(lockJob.name),
      }),
      ...(workflow.contentHash && !omitContentHash && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
      ...(runPublicKeyBase64 && { runPublicKey: runPublicKeyBase64 }),
      ...(npmRegistries && npmRegistries.length > 0 && { npmRegistries }),
      ...(installEnvSecrets && Object.keys(installEnvSecrets).length > 0 && { installEnvSecrets }),
      ...(envData?.contextName && { context: envData.contextName }),
      // Run-wide CLI secrets win a collision and reach context-less jobs too.
      ...contextDataConfigFields(envData, runWideFlatSecrets),
      ...(envData?.jobEnv && { jobEnv: envData.jobEnv }),
      ...(lockJob.resources && { resources: lockJob.resources }),
      // Wall-clock ms; the agent arms the deadline via request.jobTimeoutMs.
      ...(lockJob.timeout !== undefined && { timeout: lockJob.timeout }),
      // The agent-WS handler resolves a cache request's org/repo/scope from the
      // tracked dispatch, never from the agent's wire message.
      ...(cacheOrgId && { cacheOrgId }),
      ...(cacheRepoId && { cacheRepoId }),
      cacheRefScope,
      event: eventEnvelopeOverride ?? event,
      ...(event.provider && { provider: event.provider }),
    };
  };
}

// ---------------------------------------------------------------------------
// Phase E+F+G — static job dispatch
// ---------------------------------------------------------------------------

/** The QueuedJobInput for an execution job (cluster and single-orch paths). */
function buildExecutionJobInput(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  selectors: JobRoutingSelectors;
}): QueuedJobInput {
  const { ctx, setup, buildPrep, buildJobConfig, mat, selectors } = args;
  const lockJob = mat.lockJob;
  const { workflow, bundle, repoIdentifier, credentials, event, ref, runId } = ctx;
  return {
    runId,
    workflowName: workflow.name,
    jobName: mat.expandedName,
    runsOnLabels: selectors.runsOnLabels,
    runsOnPatterns: selectors.runsOnPatterns,
    excludeLabels: selectors.excludeLabels,
    excludePatterns: selectors.excludePatterns,
    // Baked in because gated children re-dispatch through the base dispatcher,
    // which skips the wrapper's extraJobConfig merge; else a test run's
    // overlay/`fullRepo` provenance is lost and the agent clones an empty repoUrl.
    jobConfig: { ...buildJobConfig(mat), ...globalJobConfigFor(ctx), ...ctx.extraJobConfig },
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    ...cacheArtifactFields(buildPrep),
    requestId: getRequestContext().requestId,
    ...(lockJob.resources && { resources: lockJob.resources }),
    // Host fan-out pin (plus the cross-cluster reroute hint).
    ...(mat.pinnedAgentId && { pinnedAgentId: mat.pinnedAgentId }),
    ...(mat.connectedInstanceId !== undefined && {
      connectedInstanceId: mat.connectedInstanceId,
    }),
  };
}

/**
 * How many times {@link postPendingHoldCheck} tries to record an accepted post
 * on the hold rows before giving up and leaving the check unclosable.
 */
export const PENDING_CHECK_MARK_ATTEMPTS = 3;
/** Backoff between mark attempts, multiplied by the attempt number. */
const PENDING_CHECK_MARK_RETRY_BASE_MS = 25;

/**
 * Post the pending `KiCI Security` status, then record on every hold gating
 * this commit's check that the commit carries it.
 *
 * A settle reads the record, not the row's shape, to decide whether there is a
 * check to terminalize: `postCheckStatus` CREATES a missing run, so a shape
 * saying "posted" after a refused post put a completed check on a commit that
 * never had one.
 *
 * `heldRunIds` is plural because the commit carries ONE check run: with two
 * requirements gating a job, marking one lets the first to end resolve a check
 * the other still gates. Marked in one statement, never per id — a partial
 * mark lets the contention query miss a hold and fabricate a PASSING check
 * (`markPendingCheckPosted`).
 *
 * Awaited so the record lands before a settle can race it; a failed post is
 * swallowed so the dispatch loop never blocks, at one serial round-trip per
 * held job.
 *
 * A failed record after a successful post leaves a pending check no settle
 * closes; retried {@link PENDING_CHECK_MARK_ATTEMPTS} times to cover a lost
 * connection, statement timeout or deadlock. A process death mid-retry stays
 * open: a sweeper would need a read on `CheckStatusPoster`, a compat-protected
 * engine interface, to recover milliseconds that a new commit already
 * recovers — and guessing FABRICATES checks, worse than a stuck one.
 */
export async function postPendingHoldCheck(args: {
  poster: NonNullable<NonNullable<WorkflowDispatchContext['bundle']>['checkStatusPoster']>;
  store: NonNullable<ProcessingDeps['heldRunStore']>;
  orgId: string;
  /** Every hold that gates the one check run this post writes. */
  heldRunIds: readonly string[];
  repoIdentifier: string;
  sha: string;
  summary: string;
  credentials: unknown;
  /** Log fields naming the hold, and the message a failed POST is reported under. */
  logContext: Record<string, unknown>;
  postFailureMessage: string;
}): Promise<void> {
  try {
    await args.poster.postCheckStatus(
      args.repoIdentifier,
      args.sha,
      'pending',
      'Held for approval',
      args.summary,
      args.credentials,
    );
  } catch (err) {
    logger.warn(args.postFailureMessage, { ...args.logContext, error: toErrorMessage(err) });
    return;
  }
  for (let attempt = 1; attempt <= PENDING_CHECK_MARK_ATTEMPTS; attempt++) {
    try {
      await args.store.markPendingCheckPosted(args.orgId, args.heldRunIds);
      return;
    } catch (err) {
      const lastAttempt = attempt === PENDING_CHECK_MARK_ATTEMPTS;
      logger.warn('Posted a pending security check but could not record it on the hold', {
        ...args.logContext,
        holdIds: args.heldRunIds,
        attempt,
        attempts: PENDING_CHECK_MARK_ATTEMPTS,
        // A give-up leaves a pending check only a new commit recovers.
        outcome: lastAttempt ? 'giving up — the pending check will not be closed' : 'retrying',
        error: toErrorMessage(err),
      });
      if (lastAttempt) return;
      await new Promise((resolve) =>
        setTimeout(resolve, PENDING_CHECK_MARK_RETRY_BASE_MS * attempt),
      );
    }
  }
}

/**
 * Hold a job: create the `held_runs` row and persist its dispatch context so
 * `release()` re-dispatches it through `dispatchReadyJob`.
 */
async function holdJobForApproval(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  envData: JobEnvData;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, envData, dispatchedJobs } = args;
  const selectors = runsOnSelectorsForLockJob(mat.lockJob);
  await persistJobHold({
    ctx,
    jobName: mat.expandedName,
    envData,
    runsOnLabels: selectors.runsOnLabels,
    buildJobInput: () =>
      buildExecutionJobInput({ ctx, setup, buildPrep, buildJobConfig, mat, selectors }),
    placeholder: {
      jobName: mat.expandedName,
      ...(mat.variantValues && { matrixValues: mat.variantValues }),
      // The rolling-wave scheduler keys on `base_job_name`; null, a held
      // child's wave never fires.
      ...variantTrackingFields(mat),
      ...gitCredentialFields(mat.lockJob),
      runsOnLabels: selectors.runsOnLabels,
    },
    dispatchedJobs,
  });
}

/**
 * Store a job as a pending dispatch context for `dispatchReadyJob`. A bound job
 * is stored WITHOUT context data, WITH the record to resolve it from, so no
 * context secret rests while it waits. Without a record the input is stored as
 * built (run-wide secrets only).
 */
async function storeDeferredJobContext(args: {
  ctx: WorkflowDispatchContext;
  /** The dispatch's own db, or a transaction. */
  db: Parameters<typeof storePendingJobContext>[0];
  jobName: string;
  jobInput: QueuedJobInput;
  runsOnLabels: string[];
  invoke?: InvokeGateParams;
  resolution: DeferredContextResolution | undefined;
}): Promise<void> {
  const { ctx, db, jobName, jobInput, runsOnLabels, invoke, resolution } = args;
  await storePendingJobContext(db, ctx.runId, jobName, {
    // fails-when: a bound job is stored with the input dispatch built, context secrets included
    // breaks-if-wrong: the run-wide secrets of a job with no bound context must stay on its input
    jobInput: resolution ? withoutContextData(jobInput, ctx.runWideFlatSecrets) : jobInput,
    runsOnLabels,
    ...(invoke && { invoke }),
    ...(resolution && { contextResolution: resolution }),
  });
}

/**
 * Write a held job's `held_runs` row(s) and pending context in one transaction,
 * audit each row, register its `needs-pending-` placeholder, and post the
 * pending check. Shared by {@link holdJobForApproval} and
 * {@link holdGeneratedJobs}; both resume through `dispatchReadyJob`.
 */
async function persistJobHold(args: {
  ctx: WorkflowDispatchContext;
  /** Expanded name: `held_runs.job_id` and the pending-context key. */
  jobName: string;
  envData: JobEnvData;
  runsOnLabels: string[];
  /** Built only once the hold is known to persist. */
  buildJobInput: () => QueuedJobInput;
  /** Registered while the job waits; its id is minted here. */
  placeholder: Omit<DispatchedJob, 'jobId'>;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, jobName, envData, runsOnLabels, placeholder, dispatchedJobs } = args;
  const { deps, workflow, runId } = ctx;
  const hold = envData.approvalHold;
  const nonApproval = envData.nonApprovalHold;
  // Every hold kind persists a resume path; `approvalHold` only picks the store
  // method. A hold registered nowhere lets `isRunComplete` pass without the job,
  // or fails a single-job run with a misleading "no jobs were dispatched".
  if ((!hold && !nonApproval) || !deps.heldRunStore || !deps.db) {
    logger.info('Job held by protection rules (not persisted — no hold data or no store)', {
      runId,
      workflow: workflow.name,
      job: jobName,
    });
    return;
  }

  const jobInput = args.buildJobInput();

  // Keyed (run_id, job_id = expanded name); release() consumes the pending
  // context by the same name.
  //
  // Rows and context are written TOGETHER: row-first can leave a hold nothing
  // resumes, context-first a job nothing releases. A rollback leaves the job
  // as if never held.
  //
  // BOTH rows when both exist: `dispatchReadyJob`'s `hasPendingHold` refuses
  // while ANY pending row names this job. With only the reviewer row, the trust
  // gate is unenforced — `contexts:write` plus clause eligibility would release
  // a job that needs `ci_trust:write`.
  const heldRows = await deps.db.transaction().execute(async (trx) => {
    const rows: { row: HeldRun; scope: string; triggerSource: string; holdType?: string }[] = [];
    if (hold) {
      rows.push({
        row: await deps.heldRunStore!.createHold(
          ctx.resolvedOrgId,
          {
            runId,
            jobId: jobName,
            scope: hold.scope,
            triggerSource: hold.triggerSource,
            requirement: hold.requirement,
            contextId: hold.contextId,
            queueType: hold.queueType,
          },
          // Explicit: the store's own connection is not enrolled in the
          // transaction, so it would commit regardless of the context write.
          trx,
        ),
        scope: hold.scope,
        triggerSource: hold.triggerSource,
      });
    }
    if (nonApproval) {
      rows.push({
        row: await deps.heldRunStore!.create(ctx.resolvedOrgId, nonApproval, trx),
        // `create` names neither, so both land on their column defaults.
        scope: HoldScope.enum.job,
        triggerSource: TriggerSource.enum.context,
        holdType: nonApproval.holdType,
      });
    }
    await storeDeferredJobContext({
      ctx,
      db: trx,
      jobName,
      jobInput,
      runsOnLabels,
      resolution: envData.contextResolution,
    });
    return rows;
  });
  // One audit entry per row, actor the dispatcher system component (no user
  // context on a webhook): every approvable hold needs a trail of being raised.
  for (const written of heldRows) {
    runDetached(
      logger,
      'Access log write',
      () =>
        deps.accessLogWriter?.record({
          orgId: ctx.resolvedOrgId,
          routingKey: ctx.effectiveRoutingKey ?? ctx.info.routingKey ?? null,
          actor: { type: 'system', component: 'dispatcher' },
          action: 'held_run.request',
          target: { type: 'held_run', id: written.row.id },
          requestId: null,
          source: 'platform_proxy',
          outcome: 'allowed',
          meta: {
            runId,
            jobId: jobName,
            holdScope: written.scope,
            triggerSource: written.triggerSource,
            holdType: written.holdType,
          },
        }),
      { runId, heldRunId: written.row.id },
    );
  }
  // Placeholder keeps the run incomplete; the `needs-pending-` prefix lets
  // dispatchReadyJob swap it for the real job id on release.
  const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${jobName}-${randomUUID()}`;
  dispatchedJobs.push({ jobId: syntheticId, ...placeholder });

  logger.info(hold ? 'Job held for approval' : 'Job held by a context protection gate', {
    runId,
    workflow: workflow.name,
    job: jobName,
    scope: hold?.scope ?? HoldScope.enum.job,
    triggerSource: hold?.triggerSource ?? TriggerSource.enum.context,
    ...(hold
      ? { clauses: hold.requirement.clauses.length }
      : { holdType: nonApproval?.holdType, reason: nonApproval?.reason }),
  });

  // EVERY row owns the one `KiCI Security` check: marking only the rendered
  // row lets the first hold to end turn it `success` while the other still
  // gates the job — branch protection green over held work.
  const heldRunIds = heldRows.map((written) => written.row.id);

  // Reviewer holds only, at job granularity (step holds run in the agent): the
  // description names the clauses to satisfy, and other holds have none, so
  // "awaiting approval" would point at an approval that releases nothing.
  if (hold && ctx.bundle?.checkStatusPoster) {
    // Approval re-dispatches under this run's own trust resolution; the note
    // names what that resumed job will not have.
    const postureNote = buildReducedPrivilegeNote(ctx.trustResolution?.tier, ctx.lockFileSource);
    // Name the second gate too: the one check run must say what else is
    // outstanding and who clears it, or approving changes nothing visible.
    const alsoSecurity =
      nonApproval?.holdType === HoldType.enum.security
        ? `\n\n${SECURITY_HOLD_ALSO_GATES_NOTE}`
        : '';
    const description =
      summarizeApprovalClauses(hold.requirement.clauses) +
      alsoSecurity +
      (postureNote ? `\n\n${postureNote}` : '');
    await postPendingHoldCheck({
      poster: ctx.bundle.checkStatusPoster,
      store: deps.heldRunStore!,
      orgId: ctx.resolvedOrgId,
      heldRunIds,
      repoIdentifier: ctx.repoIdentifier,
      sha: ctx.ref,
      summary: description,
      credentials: ctx.credentials,
      logContext: { runId, job: jobName },
      postFailureMessage: 'Failed to post approval hold check',
    });
  }

  // The context gate's security hold posts here, after the transaction, for the
  // same reason: a pending post with no `held_runs` row is a check nothing
  // settles — a permanent branch-protection blocker.
  //
  // `else if`: a job pairing `requireApproval` with a security context gate
  // carries BOTH holds, but there is ONE check run, so two posts raced for the
  // summary. The reviewer copy wins (actionable clauses); both rows own the
  // check via `heldRunIds`.
  else if (nonApproval?.holdType === HoldType.enum.security && ctx.bundle?.checkStatusPoster) {
    // `/kici approve` re-dispatches under the same unresolved-or-untrusted
    // tier, so the run really has the reductions the note names.
    const postureNote = buildReducedPrivilegeNote(ctx.trustResolution?.tier, ctx.lockFileSource);
    const holdSummary =
      buildSecurityHoldSummary(
        'context_trust',
        ctx.trustResolution?.tier,
        ctx.trustResolution?.contributorUsername,
      ) + (postureNote ? `\n\n${postureNote}` : '');
    await postPendingHoldCheck({
      poster: ctx.bundle.checkStatusPoster,
      store: deps.heldRunStore!,
      orgId: ctx.resolvedOrgId,
      heldRunIds,
      repoIdentifier: ctx.repoIdentifier,
      sha: ctx.ref,
      summary: holdSummary,
      credentials: ctx.credentials,
      logContext: { runId, job: jobName },
      postFailureMessage: 'Failed to post security hold check',
    });
  }
}

/** Log dispatch failure for a `kici:role:*` rejection with the standard hint. */
function logRoleAwareFailure(
  failure: { jobName: string; reason: string },
  flatLabels: string[],
  runId: string,
  workflowName: string,
): void {
  const roleLabel = flatLabels.find((l) => l.startsWith('kici:role:'));
  if (roleLabel) {
    const roleName = roleLabel.replace('kici:role:', '');
    const platformLabels = flatLabels
      .filter((l) => l.startsWith('kici:os:') || l.startsWith('kici:arch:'))
      .map((l) => l.split(':').pop()!);
    const platformDesc = platformLabels.length > 0 ? platformLabels.join(', ') : 'any platform';
    logger.error(
      `No ${roleName} available for [${platformDesc}]. Add 'roles: [${roleName}]' to a scaler with matching labels, or use default 'roles: [all]'.`,
      { runId, workflow: workflowName, job: failure.jobName },
    );
  } else {
    logger.warn('Job routing failed', {
      runId,
      workflow: workflowName,
      job: failure.jobName,
      reason: failure.reason,
    });
  }
}

/** Pre-register non-root jobs as needs-pending and store dispatch contexts. */
async function preRegisterNonRootJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  needsGatedJobs: readonly MaterializedJob[];
  jobContextData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, needsGatedJobs, jobContextData, dispatchedJobs } =
    args;
  const { deps, workflow, runId } = ctx;
  for (const gated of needsGatedJobs) {
    const gatedJob = gated.lockJob;
    const selectors = runsOnSelectorsForLockJob(gatedJob);
    const runsOnLabels = selectors.runsOnLabels;
    const jobInput = buildExecutionJobInput({
      ctx,
      setup,
      buildPrep,
      buildJobConfig,
      mat: gated,
      selectors,
    });
    await storeDeferredJobContext({
      ctx,
      db: deps.db,
      jobName: gated.expandedName,
      jobInput,
      runsOnLabels,
      resolution: jobContextData.get(gated.expandedName)?.contextResolution,
    });
    const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${gated.expandedName}-${randomUUID()}`;
    dispatchedJobs.push({
      jobId: syntheticId,
      jobName: gated.expandedName,
      ...(gated.variantValues && { matrixValues: gated.variantValues }),
      runsOnLabels,
    });
    logger.info('Job gated by needs scheduler (cluster path)', {
      runId,
      workflow: workflow.name,
      job: gated.expandedName,
    });
  }
}

/** Coordinator-route the root jobs and append results to dispatchedJobs/rejectedJobs. */
async function clusterRouteRootJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  rootDispatchableJobs: readonly MaterializedJob[];
  needsGatedCount: number;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const {
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    rootDispatchableJobs,
    needsGatedCount,
    dispatchedJobs,
    rejectedJobs,
  } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;

  // Route results are keyed only by jobName; re-attach matrixValues by it.
  const matrixByName = new Map<string, Record<string, unknown>>();
  for (const mj of rootDispatchableJobs) {
    if (mj.variantValues) matrixByName.set(mj.expandedName, mj.variantValues);
  }
  // Likewise git credentials: without them the relay refuses every
  // workflow-supplied ref as undeclared.
  const gitCredsByName = new Map<
    string,
    Readonly<Record<string, Readonly<Record<string, string>>>>
  >();
  for (const mj of rootDispatchableJobs) {
    if (mj.lockJob.gitCredentials) gitCredsByName.set(mj.expandedName, mj.lockJob.gitCredentials);
  }
  const gitCredsFor = (
    jobName: string,
  ): { gitCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>> } => {
    const declared = gitCredsByName.get(jobName);
    return declared ? { gitCredentials: declared } : {};
  };

  if (rootDispatchableJobs.length === 0) {
    logger.info('All dispatchable jobs deferred or needs-gated, skipping coordinator routing', {
      runId,
      workflow: workflow.name,
      needsGated: needsGatedCount,
    });
    return;
  }

  const cloneTokens = await mintRerouteCloneTokens(ctx);
  const runCtx: RunContext = {
    runId,
    deliveryId: setup.effectiveDeliveryId,
    routingKey: setup.info.routingKey,
    event: setup.info.event,
    action: setup.info.action,
    provider: setup.info.provider,
    payload: setup.info.payload,
    repoIdentifier,
    sha: ref,
    ref: event.sourceBranch ?? event.targetBranch,
    workflowName: workflow.name,
    installationId: (credentials as { installationId?: number }).installationId,
    requestId: getRequestContext().requestId,
    ...cloneTokens,
  };
  const jobsToRoute: JobToRoute[] = rootDispatchableJobs.map((mj) => {
    const j = mj.lockJob;
    const sel = runsOnSelectorsForLockJob(j);
    return {
      jobName: mj.expandedName,
      runsOnLabels: [sel.runsOnLabels],
      runsOnPatterns: sel.runsOnPatterns,
      excludePatterns: sel.excludePatterns,
      // The coordinator uses the BASE dispatcher (here or on a peer), skipping
      // the wrapper's extraJobConfig merge; baked in (as the needs-gated path
      // does), or a relayed test run lacks fullRepo / tarballUrl / isTestRun and
      // clones an empty repoUrl.
      jobConfig: { ...buildJobConfig(mj), ...globalJobConfigFor(ctx), ...ctx.extraJobConfig },
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      ...cacheArtifactFields(buildPrep),
      excludeLabels: sel.excludeLabels,
      ...(j.resources ? { resources: j.resources } : {}),
    };
  });

  let routeTimeout: ReturnType<typeof setTimeout> | undefined;
  const routeResult = await Promise.race([
    deps.coordinator!.routeJobs(runCtx, jobsToRoute),
    new Promise<never>((_, reject) => {
      routeTimeout = setTimeout(() => reject(new Error('routeJobs timed out after 30s')), 30_000);
    }),
  ]).catch((err) => {
    logger.warn('Coordinator routing timed out, dispatching locally', {
      runId,
      workflow: workflow.name,
      error: toErrorMessage(err),
    });
    return null;
  });
  clearTimeout(routeTimeout);

  if (!routeResult) {
    for (const jtr of jobsToRoute) {
      const flatLabels = jtr.runsOnLabels.length > 0 ? jtr.runsOnLabels[0] : [];
      const jobInput: QueuedJobInput = {
        runId,
        workflowName: workflow.name,
        jobName: jtr.jobName,
        runsOnLabels: flatLabels,
        runsOnPatterns: jtr.runsOnPatterns,
        excludePatterns: jtr.excludePatterns,
        excludeLabels: jtr.excludeLabels,
        jobConfig: jtr.jobConfig,
        repoUrl: jtr.repoUrl,
        ref: jtr.ref,
        sha: jtr.sha,
        deliveryId: setup.effectiveDeliveryId,
        provider: setup.info.provider,
        providerContext: credentials as Record<string, unknown>,
        routingKey: setup.info.routingKey,
        sourceTarUrl: jtr.sourceTarUrl,
        sourceTarDigest: jtr.sourceTarDigest,
        depsUrl: jtr.depsUrl,
        depsHash: jtr.depsHash,
        requestId: getRequestContext().requestId,
      };
      const matrixValues = matrixByName.get(jtr.jobName);
      const result = await setup.dispatcher.dispatch(jobInput);
      if (result.status === 'rejected') {
        const syntheticId = `rejected-${randomUUID()}`;
        dispatchedJobs.push({
          jobId: syntheticId,
          jobName: jtr.jobName,
          ...(matrixValues && { matrixValues }),
          ...gitCredsFor(jtr.jobName),
          runsOnLabels: flatLabels,
        });
        rejectedJobs.push({ jobId: syntheticId, jobName: jtr.jobName, reason: result.reason });
      } else {
        // Tracked like `queued`: untracked, `isRunComplete` finishes the run
        // green without it.
        if (result.status === 'queued-no-backend') {
          logger.warn('Job has no matching backend (cluster fallback, tracked)', {
            runId,
            workflow: workflow.name,
            job: jtr.jobName,
            labels: flatLabels,
            excludeLabels: jtr.excludeLabels,
          });
        }
        dispatchedJobs.push({
          jobId: result.jobId,
          jobName: jtr.jobName,
          ...(matrixValues && { matrixValues }),
          ...gitCredsFor(jtr.jobName),
          runsOnLabels: flatLabels,
        });
      }
    }
    return;
  }

  for (const local of routeResult.localJobs) {
    const jtr = jobsToRoute.find((j) => j.jobName === local.jobName);
    const flatLabels = jtr?.runsOnLabels?.[0] ?? [];
    const matrixValues = matrixByName.get(local.jobName);
    dispatchedJobs.push({
      jobId: local.jobId,
      jobName: local.jobName,
      ...(matrixValues && { matrixValues }),
      ...gitCredsFor(local.jobName),
      runsOnLabels: flatLabels,
    });
  }
  // Rerouted jobs MUST feed dispatchedJobs so onExecutionStarted writes their
  // rows; otherwise recoverRunFromDb returns null for every peer progress
  // update and the run stays `running` forever.
  for (const rerouted of routeResult.reroutedJobs) {
    const jtr = jobsToRoute.find((j) => j.jobName === rerouted.jobName);
    const flatLabels = jtr?.runsOnLabels?.[0] ?? [];
    const matrixValues = matrixByName.get(rerouted.jobName);
    dispatchedJobs.push({
      jobId: rerouted.jobId,
      jobName: rerouted.jobName,
      ...(matrixValues && { matrixValues }),
      ...gitCredsFor(rerouted.jobName),
      runsOnLabels: flatLabels,
    });
    logger.info('Job rerouted to peer', {
      runId,
      workflow: workflow.name,
      job: rerouted.jobName,
      jobId: rerouted.jobId,
      peerId: rerouted.peerId,
    });
  }
  for (const failed of routeResult.failedJobs) {
    const jtr = jobsToRoute.find((j) => j.jobName === failed.jobName);
    const flatLabels = jtr?.runsOnLabels?.[0] ?? [];
    logRoleAwareFailure(failed, flatLabels, runId, workflow.name);
  }
  void buildPrep;
}

/**
 * Register an invoke gate as a pending job: its invoke parameters go on the
 * pending context and a synthetic needs-pending row is tagged
 * `job_kind='gate'`. It never reaches an agent; `dispatchReadyJob`'s gate
 * branch runs the summon. Root gates are nudged by `invokeRootGates`,
 * needs-gated ones by the scheduler.
 */
async function registerPendingInvokeGate(args: {
  ctx: WorkflowDispatchContext;
  mat: MaterializedJob;
  jobInput: QueuedJobInput;
  invokeParams: InvokeGateParams;
  resolution: DeferredContextResolution | undefined;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, mat, jobInput, invokeParams, dispatchedJobs } = args;
  const { deps, runId, workflow } = ctx;
  await storeDeferredJobContext({
    ctx,
    db: deps.db,
    jobName: mat.expandedName,
    jobInput,
    runsOnLabels: [],
    invoke: invokeParams,
    resolution: args.resolution,
  });
  const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
  dispatchedJobs.push({
    jobId: syntheticId,
    jobName: mat.expandedName,
    ...variantTrackingFields(mat),
    jobKind: JobKind.Gate,
    ...(invokeParams.timeoutMs !== undefined && { timeoutMs: invokeParams.timeoutMs }),
    runsOnLabels: [],
  });
  logger.info('Invoke gate registered (pending summon)', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
    event: invokeParams.event,
    optional: invokeParams.optional,
  });
}

/**
 * Release every root invoke gate once the run, jobs and needs edges are
 * registered: with no upstream to fire the scheduler, it is nudged through
 * `dispatchReadyJob` directly.
 */
async function invokeRootGates(args: {
  ctx: WorkflowDispatchContext;
  buildPrep: BuildPrepResult;
}): Promise<void> {
  const { ctx, buildPrep } = args;
  const { deps, runId, workflow } = ctx;
  if (!deps.executionTracker || !deps.db) return;
  const seen = new Set<string>();
  for (const mat of buildPrep.materializedJobs) {
    if (!isInvokeGate(mat.lockJob) || !isRootJob(mat.lockJob)) continue;
    if (seen.has(mat.expandedName)) continue;
    seen.add(mat.expandedName);
    if (!deps.invokeGateDeps) {
      logger.error('Root invoke gate cannot summon: invoke-gate deps unavailable', {
        runId,
        workflow: workflow.name,
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

/**
 * Register a generated invoke gate on an already-registered run: a synthetic
 * needs-pending `gate` row plus its pending context. `release` (a root gate)
 * releases it now; otherwise it waits for the scheduler (the caller inserts
 * its needs edges).
 */
async function registerGeneratedInvokeGate(args: {
  ctx: WorkflowDispatchContext;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  jobInput: QueuedJobInput;
  invokeParams: InvokeGateParams;
  resolution: DeferredContextResolution | undefined;
  release: boolean;
}): Promise<void> {
  const { ctx, jobName, matrixValues, jobInput, invokeParams, release } = args;
  const { deps, runId, workflow } = ctx;
  await storeDeferredJobContext({
    ctx,
    db: deps.db,
    jobName,
    jobInput,
    runsOnLabels: [],
    invoke: invokeParams,
    resolution: args.resolution,
  });
  const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${jobName}-${randomUUID()}`;
  if (deps.executionTracker) {
    await deps.executionTracker.addJobsToRun(
      runId,
      jobsOfWorkflow(ctx.workflow.name, [
        {
          jobId: syntheticId,
          jobName,
          jobKind: JobKind.Gate,
          runsOnLabels: [],
          ...(matrixValues && { matrixValues }),
          ...(invokeParams.timeoutMs !== undefined && { timeoutMs: invokeParams.timeoutMs }),
        },
      ]),
    );
  }
  logger.info('Generated invoke gate registered (pending summon)', {
    runId,
    workflow: workflow.name,
    job: jobName,
    event: invokeParams.event,
    release,
  });
  if (release && deps.executionTracker && deps.db) {
    await dispatchReadyJob(
      runId,
      jobName,
      deps.dispatcher,
      deps.executionTracker,
      deps.coordinator,
      deps.db,
      deps.invokeGateDeps,
    );
  }
}

/**
 * Record each context-rule rejection as a synthetic `rejected-*` job carrying
 * the rule's reason, as a dispatcher rejection is recorded. A skipped job
 * leaves no row: an all-gated run then fails as a misleading `no_agent`, and a
 * partial rejection leaves downstream `needs` edges on a job that never
 * terminalizes. Recorded, the dashboard and `kici runs show` name the context
 * and rule, and downstream `when` sets get a terminal upstream.
 *
 * Called once for both dispatch paths, so exactly once. A `pendingInit` job is
 * skipped: its verdict is final only after the init round, and
 * {@link recordContextRuleRejectionAfterInit} records it — never both.
 */
function recordContextRuleRejections(args: {
  ctx: WorkflowDispatchContext;
  buildPrep: BuildPrepResult;
  jobContextData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): void {
  const { ctx, buildPrep, jobContextData, dispatchedJobs, rejectedJobs } = args;
  const { runId, workflow } = ctx;
  for (const mat of buildPrep.materializedJobs) {
    const envData = jobContextData.get(mat.expandedName);
    if (!envData?.rejected || envData.pendingInit) continue;
    const reason = envData.rejectReason ?? DEFAULT_CONTEXT_REJECT_REASON;
    const syntheticId = `rejected-${randomUUID()}`;
    dispatchedJobs.push({
      jobId: syntheticId,
      jobName: mat.expandedName,
      ...(mat.variantValues && { matrixValues: mat.variantValues }),
      ...variantTrackingFields(mat),
      runsOnLabels: runsOnSelectorsForLockJob(mat.lockJob).runsOnLabels,
    });
    rejectedJobs.push({
      jobId: syntheticId,
      jobName: mat.expandedName,
      reason,
      category: InitFailureCategory.enum.context_rules,
    });
    logger.info('Job rejected by protection rules (recorded on the run)', {
      runId,
      workflow: workflow.name,
      job: mat.expandedName,
      reason,
    });
  }
}

/**
 * Deferred-init sibling of {@link recordContextRuleRejections}. A dynamic
 * `context: (e) => …` is named only after the agent runs the module, so its
 * gates run in the flow-back, after the run row exists; the reason goes
 * straight to the tracker, like the `init-failed-*` row in the catch block.
 *
 * Without it the run finishes GREEN: `__init__` is a tracked job reported
 * `success`, so `isRunComplete` holds and `releasePendingJobsHold` finalizes
 * it. The no-jobs guard (`deferredInitJobs.length === 0`) never fires here.
 *
 * Must complete BEFORE the LAST pending-jobs token drops (callers `await`
 * inside the task's `try`; release is in `.finally()`), or a non-terminal job
 * attaches to a completed run.
 */
async function recordContextRuleRejectionAfterInit(args: {
  ctx: WorkflowDispatchContext;
  mat: MaterializedJob;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, mat, jobEnvData } = args;
  const { deps, workflow, runId } = ctx;
  const reason = jobEnvData.rejectReason ?? DEFAULT_CONTEXT_REJECT_REASON;
  logger.warn('Job rejected by a rule on its resolved context (recorded on the run)', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
    reason,
  });
  const tracker = deps.executionTracker;
  if (!tracker) return;
  const jobId = `rejected-${randomUUID()}`;
  const onError = (err: unknown): void => {
    logger.error('Failed to record a context-rule rejection on the run', {
      runId,
      job: mat.expandedName,
      error: toErrorMessage(err),
    });
  };
  await tracker
    .addJobsToRun(
      runId,
      jobsOfWorkflow(ctx.workflow.name, [
        {
          jobId,
          jobName: mat.expandedName,
          ...(mat.variantValues && { matrixValues: mat.variantValues }),
          ...variantTrackingFields(mat),
          runsOnLabels: runsOnSelectorsForLockJob(mat.lockJob).runsOnLabels,
          ...(jobEnvData.contextNames?.length && { contexts: jobEnvData.contextNames }),
        },
      ]),
    )
    .catch(onError);
  await tracker
    .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
      error: reason,
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.context_rules,
        message: reason,
        jobName: mat.expandedName,
      },
    })
    .catch(onError);
}

/** Single-orchestrator path: needs-aware direct dispatch. */
async function dispatchSingleOrchPath(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  jobContextData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, jobContextData, dispatchedJobs, rejectedJobs } =
    args;
  const { deps, workflow, runId } = ctx;
  const wavePlan = computeWavePlan(buildPrep.materializedJobs);
  const wavePolicyFields = (name: string): { waveMaxParallel?: number; waveFailFast?: boolean } => {
    const p = wavePlan.policy.get(name);
    return p ? { waveMaxParallel: p.maxParallel, waveFailFast: p.failFast } : {};
  };
  for (const mat of buildPrep.materializedJobs) {
    const lockJob = mat.lockJob;
    const matrixValues = mat.variantValues;
    const envData = jobContextData.get(mat.expandedName);
    // Rejections are already recorded (`recordContextRuleRejections` or the
    // flow-back); only skip the dispatch.
    if (envData?.rejected) continue;
    // `pendingInit` BEFORE `held`, load-bearing: a job can be both, and holding
    // it here would store input built from unresolved dynamic values. The
    // flow-back owns its hold (`holdExecutionAfterInit`).
    if (envData?.pendingInit) continue;
    if (envData?.held) {
      await holdJobForApproval({
        ctx,
        setup,
        buildPrep,
        buildJobConfig,
        mat,
        envData,
        dispatchedJobs,
      });
      continue;
    }

    const selectors = runsOnSelectorsForLockJob(lockJob);
    const runsOnLabels = selectors.runsOnLabels;
    const excludeLabels = selectors.excludeLabels;
    const jobInput = buildExecutionJobInput({
      ctx,
      setup,
      buildPrep,
      buildJobConfig,
      mat,
      selectors,
    });

    // An invoke gate, root or not, registers as a pending gate.
    const invokeParams = invokeParamsFromLockJob(lockJob);
    if (invokeParams) {
      await registerPendingInvokeGate({
        ctx,
        mat,
        jobInput,
        invokeParams,
        resolution: jobContextData.get(mat.expandedName)?.contextResolution,
        dispatchedJobs,
      });
      continue;
    }

    if (!isRootJob(lockJob)) {
      await storeDeferredJobContext({
        ctx,
        db: deps.db,
        jobName: mat.expandedName,
        jobInput,
        runsOnLabels,
        resolution: envData?.contextResolution,
      });
      const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        ...gitCredentialFields(lockJob),
        runsOnLabels,
      });
      logger.info('Job gated by needs scheduler (not dispatched yet)', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
      });
      continue;
    }

    // Rolling wave: a child beyond the maxParallel window is held (not
    // enqueued) until a sibling terminal releases it. wave_gated=true keeps the
    // dispatch loop off it and is cleared on release.
    if (wavePlan.held.has(mat.expandedName)) {
      await storeDeferredJobContext({
        ctx,
        db: deps.db,
        jobName: mat.expandedName,
        jobInput,
        runsOnLabels,
        resolution: envData?.contextResolution,
      });
      // SAME prefix as the needs gate: release only cleans up that prefix, and a
      // leftover duplicate row is miscounted as in-flight.
      const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        ...wavePolicyFields(mat.expandedName),
        ...gitCredentialFields(lockJob),
        runsOnLabels,
        waveGated: true,
      });
      logger.info('Fan-out child held by rolling wave (maxParallel)', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
        maxParallel: lockJob.maxParallel,
      });
      continue;
    }

    // Bring-up FIRST: the init-runner enrolls under `mat.pinnedAgentId`, and the
    // pinned child below drains onto it via `onAgentAvailable`.
    if (mat.needsBringup && mat.pinnedAgentId) {
      await dispatchBringupForChild({ ctx, setup, mat });
    }

    const result = await setup.dispatcher.dispatch(jobInput);
    if (result.status === 'rejected') {
      const syntheticId = `rejected-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        ...wavePolicyFields(mat.expandedName),
        ...gitCredentialFields(lockJob),
        runsOnLabels,
      });
      rejectedJobs.push({ jobId: syntheticId, jobName: mat.expandedName, reason: result.reason });
    } else {
      // `queued-no-backend` is tracked like `queued`: it IS queued, and
      // `isRunComplete` sees only REGISTERED jobs. Tracked, it holds the run
      // open until an agent appears (scale-from-zero) or the queue window
      // terminalizes it `unroutable`.
      if (result.status === 'queued-no-backend') {
        logger.warn('Job has no matching backend (tracked, awaiting capacity)', {
          runId,
          workflow: workflow.name,
          job: mat.expandedName,
          labels: runsOnLabels,
          excludeLabels,
        });
      }
      dispatchedJobs.push({
        jobId: result.jobId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        ...wavePolicyFields(mat.expandedName),
        ...gitCredentialFields(lockJob),
        runsOnLabels,
      });
    }
    logger.info('Job dispatched', {
      runId,
      workflow: workflow.name,
      job: mat.expandedName,
      status: result.status,
      sourceTarUrl: buildPrep.sourceTarUrl ? 'yes' : 'no',
      depsUrl: buildPrep.depsUrl ? 'yes' : 'no',
      context: envData?.contextName,
    });
  }
}

/**
 * Phase E+F+G — pick the cluster or single-orch path, filling the dispatched
 * and rejected lists (the build job is appended upstream).
 */
async function dispatchStaticJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  jobContextData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, jobContextData, dispatchedJobs, rejectedJobs } =
    args;
  const { deps, workflow, runId } = ctx;
  if (buildPrep.buildFailed) {
    logger.info('Skipping static job dispatch due to build failure', {
      runId,
      workflow: workflow.name,
      staticJobCount: buildPrep.staticJobs.length,
    });
    return;
  }
  recordContextRuleRejections({ ctx, buildPrep, jobContextData, dispatchedJobs, rejectedJobs });
  if (deps.coordinator && deps.coordinator.hasConnectedPeers()) {
    const dispatchableJobs = buildPrep.materializedJobs.filter((mj) => {
      const envData = jobContextData.get(mj.expandedName);
      return !envData?.rejected && !envData?.held && !envData?.pendingInit;
    });
    // Held jobs are excluded from routing, so hold them here (as the single-orch
    // loop does), or they vanish and the run can succeed without them.
    for (const mat of buildPrep.materializedJobs) {
      const envData = jobContextData.get(mat.expandedName);
      if (!envData?.held || envData.rejected || envData.pendingInit) continue;
      await holdJobForApproval({
        ctx,
        setup,
        buildPrep,
        buildJobConfig,
        mat,
        envData,
        dispatchedJobs,
      });
    }
    // Invoke gates never route to a peer: the ingesting orchestrator summons and
    // tracks proxies.
    for (const mat of dispatchableJobs.filter((mj) => isInvokeGate(mj.lockJob))) {
      const invokeParams = invokeParamsFromLockJob(mat.lockJob);
      if (!invokeParams) continue;
      const selectors = runsOnSelectorsForLockJob(mat.lockJob);
      const jobInput = buildExecutionJobInput({
        ctx,
        setup,
        buildPrep,
        buildJobConfig,
        mat,
        selectors,
      });
      await registerPendingInvokeGate({
        ctx,
        mat,
        jobInput,
        invokeParams,
        resolution: jobContextData.get(mat.expandedName)?.contextResolution,
        dispatchedJobs,
      });
    }
    const nonGateJobs = dispatchableJobs.filter((mj) => !isInvokeGate(mj.lockJob));
    const rootDispatchableJobs = nonGateJobs.filter((mj) => isRootJob(mj.lockJob));
    const needsGatedJobs = nonGateJobs.filter((mj) => !isRootJob(mj.lockJob));
    await preRegisterNonRootJobs({
      ctx,
      setup,
      buildPrep,
      buildJobConfig,
      needsGatedJobs,
      jobContextData,
      dispatchedJobs,
    });
    await clusterRouteRootJobs({
      ctx,
      setup,
      buildPrep,
      buildJobConfig,
      rootDispatchableJobs,
      needsGatedCount: needsGatedJobs.length,
      dispatchedJobs,
      rejectedJobs,
    });
    return;
  }
  await dispatchSingleOrchPath({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobContextData,
    dispatchedJobs,
    rejectedJobs,
  });
}

// ---------------------------------------------------------------------------
// Phase H — execution-tracker registration + edge insertion + rejected mark
// ---------------------------------------------------------------------------

/**
 * Register the run BEFORE the first job reaches an agent, and hold it open for
 * the dispatch window.
 *
 * **The race.** If `recordRunStart` wrote the row after the loop, a job
 * terminal on arrival (rejected dispatch, init failure, capability mismatch)
 * finds no row in `recoverRunFromDb`; the update is **discarded** (`Run not
 * found in DB, skipping job status update`), no downstream releases, and the
 * run hangs silently. The `execution_jobs` FK violation is the same race.
 * The source-pack build path already starts early; this generalizes it.
 *
 * **The token is not optional:** without it the first terminal job satisfies
 * `isRunComplete` mid-dispatch and the run is finalized (status, check,
 * Platform forward). Released by `dispatchMatchedWorkflow`'s `finally` once
 * `recordRunStart` registered every job.
 *
 * True when this call registered the run, sending `recordRunStart` down its
 * `addJobsToRun` branch.
 */
async function startRunBeforeDispatch(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
}): Promise<boolean> {
  const { ctx, setup, buildPrep, declaredContexts } = args;
  const { deps, workflow, runId } = ctx;
  const tracker = deps.executionTracker;
  if (!tracker) return false;
  // The build path already registered the run and took its own token.
  if (buildPrep.buildJobTrackedEarly) return false;
  // Nothing reaches an agent, and a zero-job row never completes
  // (`run.jobs.size > 0`) and no sweeper reaps it (stale-run detector scans
  // jobs/queue, orphan recovery needs `running`, archival needs terminal) — it
  // sits `pending` while the deadline detector re-fires. All-deferred workflows
  // use `ensureExecutionRunForDeferred`.
  if (buildPrep.buildFailed || buildPrep.materializedJobs.length === 0) return false;

  await startTrackedRun(tracker, ctx, setup, [], { declaredContexts });
  await stampTrustContextBeforeDispatch(ctx);
  ctx.runRegisteredBeforeDispatch = true;
  if (tracker.holdRunForPendingJobs(runId)) {
    ctx.dispatchWindowTokenHeld = true;
  } else {
    logger.warn('Run registered before dispatch without a pending-jobs token', {
      runId,
      workflow: workflow.name,
    });
  }
  return true;
}

/**
 * The `execution_runs` trust-context columns, one definition for both writers
 * so they cannot drift. `lock_file_source` is omitted explicitly when no
 * lock-file branch was selected (internal event, CLI test run), independent of
 * the driver's `undefined` handling.
 */
function trustContextColumns(
  trustResolution: NonNullable<WorkflowDispatchContext['trustResolution']>,
  lockFileSource: string | undefined,
) {
  return {
    trust_tier: trustResolution.tier,
    ...(lockFileSource !== undefined && { lock_file_source: lockFileSource }),
    contributor_username: trustResolution.contributorUsername,
  };
}

/**
 * Record the trust context BEFORE any job reaches an agent. `recordRunStart`
 * writes it only after the loop, fire-and-forget, so the row would carry none
 * for that window — permanently if the write fails.
 *
 * The git credential relay reads a NULL `trust_tier` LENIENTLY
 * (`security/trust-tier.ts`), serving a fork pull request its declared
 * credentials. A NULL `lock_file_source` reads as "no reduced-privilege
 * posture" (`buildReducedPrivilegeNote`, dashboard security panel, stale-run
 * detector), so an untrusted tier with no lock source — a state a fork pull
 * request must never show — appears if the tier lands alone.
 *
 * So all columns go in ONE statement, with the in-memory mirror, and awaited
 * so they are durable before an agent asks. `recordRunStart`'s rewrite is a
 * no-op.
 */
async function stampTrustContextBeforeDispatch(ctx: WorkflowDispatchContext): Promise<void> {
  const { deps, runId, trustResolution, lockFileSource } = ctx;
  if (!trustResolution) return;
  // Guarded alone: a tracker lacking the method loses only the note, not the row.
  try {
    deps.executionTracker?.setRunTrustContext(runId, trustResolution.tier, lockFileSource);
  } catch (err) {
    logger.warn('Failed to stamp the trust context on the tracked run', {
      runId,
      error: toErrorMessage(err),
    });
  }
  if (!deps.db) return;
  try {
    await deps.db
      .updateTable('execution_runs')
      .set(trustContextColumns(trustResolution, lockFileSource))
      .where('run_id', '=', runId)
      .execute();
  } catch (err) {
    // Do NOT abort: readers stay lenient as for unresolved trust, and
    // `recordRunStart` retries the write.
    logger.error('Failed to stamp the trust context before dispatch', {
      runId,
      error: toErrorMessage(err),
    });
  }
}

async function recordRunStart(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
  runContextName: string | undefined;
  runContextId: string | undefined;
  dispatchedJobs: DispatchedJob[];
  /**
   * The row was inserted before the loop (early start or build path): only add
   * jobs, never a second `onExecutionStarted`, which resets the job map.
   */
  runTrackedEarly: boolean;
}): Promise<void> {
  const {
    ctx,
    setup,
    buildPrep,
    declaredContexts,
    runContextName,
    runContextId,
    dispatchedJobs,
    runTrackedEarly,
  } = args;
  const { deps, runId } = ctx;
  if (!deps.executionTracker) return;
  // No row and nothing dispatched: the all-rejected / deferred paths record it.
  if (!runTrackedEarly && dispatchedJobs.length === 0) return;
  if (runTrackedEarly) {
    // The build path already registered the build job; skip it.
    const executionJobs =
      buildPrep.buildJobTrackedEarly && buildPrep.buildJobId
        ? dispatchedJobs.filter((j) => j.jobId !== buildPrep.buildJobId)
        : dispatchedJobs;
    if (executionJobs.length > 0) {
      await deps.executionTracker.addJobsToRun(
        runId,
        jobsOfWorkflow(ctx.workflow.name, executionJobs),
        declaredContexts.length > 0 ? [...declaredContexts] : undefined,
      );
    }
  } else {
    await startTrackedRun(deps.executionTracker, ctx, setup, dispatchedJobs, { declaredContexts });
  }
  stampRunStartColumns(ctx, runContextName, runContextId);
}

/**
 * Best-effort per-run column writes after registration (context, trust,
 * test-run, local working tree); none aborts dispatch. Shared with the
 * deferred bootstrap, which alone registers a run with no static job.
 */
function stampRunStartColumns(
  ctx: WorkflowDispatchContext,
  runContextName: string | undefined,
  runContextId: string | undefined,
): void {
  const { deps, runId, trustResolution, lockFileSource, localWorkingTree, testRun } = ctx;
  if (runContextName && deps.db) {
    deps.db
      .updateTable('execution_runs')
      .set({ context: runContextName, context_id: runContextId ?? null })
      .where('run_id', '=', runId)
      .execute()
      .catch((err) => {
        logger.error('Failed to set context on execution run', {
          runId,
          context: runContextName,
          error: toErrorMessage(err),
        });
      });
  }
  if (trustResolution) {
    // In-memory mirror so a completion check can name the reduced-privilege
    // posture; trust resolves on its own path, hence not via
    // `onExecutionStarted`. Idempotent after `stampTrustContextBeforeDispatch`,
    // and covers runs registered by neither early site.
    //
    // Guarded so a throw cannot skip the remaining best-effort writes.
    try {
      deps.executionTracker?.setRunTrustContext(runId, trustResolution.tier, lockFileSource);
    } catch (err) {
      logger.warn('Failed to stamp the trust context on the tracked run', {
        runId,
        error: toErrorMessage(err),
      });
    }
  }
  if (trustResolution && deps.db) {
    deps.db
      .updateTable('execution_runs')
      .set(trustContextColumns(trustResolution, lockFileSource))
      .where('run_id', '=', runId)
      .execute()
      .catch((err) => {
        logger.error('Failed to set trust context on execution run', {
          runId,
          error: toErrorMessage(err),
        });
      });
  }
  if (testRun && deps.db) {
    deps.db
      .updateTable('execution_runs')
      .set({ is_test_run: true, fixture_id: testRun.fixtureId })
      .where('run_id', '=', runId)
      .execute()
      .catch((err) => {
        logger.error('Failed to set test-run context on execution run', {
          runId,
          error: toErrorMessage(err),
        });
      });
  }
  if (localWorkingTree && deps.db) {
    deps.db
      .updateTable('execution_runs')
      .set({ local_working_tree: true })
      .where('run_id', '=', runId)
      .execute()
      .catch((err) => {
        logger.error('Failed to mark execution run as local working tree', {
          runId,
          error: toErrorMessage(err),
        });
      });
  }
}

function categorizeRejectReason(reason: string): InitFailureCategory {
  const lower = reason.toLowerCase();
  if (/no\s+agent|no\s+matching\s+backend/.test(lower)) return InitFailureCategory.enum.no_agent;
  return InitFailureCategory.enum.context_rules;
}

/**
 * Open the needs gate for jobs whose upstreams went terminal before the edges
 * existed. Edges are written after the loop; a root job terminal on arrival
 * drives `evaluateDownstreams` against zero edges, and the event-driven
 * scheduler never re-fires, so the downstream stays `pending` forever.
 *
 * The same guard the deferred result-aware eval registration applies for its own
 * edges. Safe unconditionally: `recomputeNeedsSatisfied` claims with a conditional
 * UPDATE, so an already-claimed job is not dispatched twice. Wave-held jobs
 * share the prefix but are excluded, or the `maxParallel` window is bypassed.
 */
export async function catchUpNeedsGatedJobs(args: {
  ctx: NeedsSchedulingContext;
  dispatchedJobs: readonly { jobId: string; jobName: string; waveGated?: boolean }[];
}): Promise<void> {
  const { ctx } = args;
  const db = ctx.deps.db;
  if (!db) return;
  const gatedNames = args.dispatchedJobs
    .filter((j) => j.jobId.startsWith(NEEDS_PENDING_JOB_ID_PREFIX) && !j.waveGated)
    .map((j) => j.jobName);
  if (gatedNames.length === 0) return;

  // Only jobs with edges: a dynamic-group job gets its edges later
  // (`resolveGroupEdges`), and `checkAllUpstreamsSatisfied` reads "no edges" as
  // "dispatch now", releasing it before its group ran.
  const edged = await db
    .selectFrom('execution_job_needs')
    .select('job_name')
    .where('run_id', '=', ctx.runId)
    .where('job_name', 'in', gatedNames)
    .execute();
  const recomputable = [...new Set(edged.map((e) => e.job_name))];
  if (recomputable.length === 0) return;

  await recomputeAndApplyReady(ctx, recomputable);
}

async function insertEdgesAndMarkRejected(args: {
  ctx: WorkflowDispatchContext;
  buildPrep: BuildPrepResult;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const { ctx, buildPrep, dispatchedJobs, rejectedJobs } = args;
  const { deps, runId } = ctx;
  if (deps.db && dispatchedJobs.length > 0) {
    try {
      await insertEdgesForRun(deps.db, runId, buildPrep.materializedJobs, buildPrep.expansionMap);
      await catchUpNeedsGatedJobs({ ctx, dispatchedJobs });
    } catch (err) {
      logger.error('Failed to insert needs edges for run', {
        runId,
        error: toErrorMessage(err),
      });
    }
  }
  if (deps.executionTracker && rejectedJobs.length > 0) {
    const now = Date.now();
    for (const { jobId, jobName, reason, category, terminalStatus } of rejectedJobs) {
      const status = terminalStatus ?? ExecutionJobStatus.enum.failed;
      // A skipped (narrowed-to-empty) job carries no init-failure.
      const extra =
        status === ExecutionJobStatus.enum.skipped
          ? { error: reason }
          : {
              error: reason,
              initFailure: {
                scope: 'job' as const,
                category: category ?? categorizeRejectReason(reason),
                message: reason,
                jobName,
              },
            };
      deps.executionTracker
        .onJobStatus(runId, jobId, status, now, undefined, extra)
        .catch((err) => {
          logger.error('Failed to mark rejected job', {
            runId,
            jobId,
            status,
            error: toErrorMessage(err),
          });
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase I — deferred init dispatch
// ---------------------------------------------------------------------------

/**
 * After init, apply the resolved contexts, vars and secrets to jobEnvData.
 * Returns the gate handle for re-gating dynamic-matrix children.
 */
async function applyInitResultContext(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  /** `held_runs.job_id` for any hold. */
  expandedName: string;
  initResult:
    | { contextNames?: string[]; env?: Record<string, string>; concurrencyGroup?: string }
    | undefined;
  jobEnvData: JobEnvData;
  hostCtx?: HostFacts;
  concurrencyGroup?: string;
}): Promise<ContextGateHandle | undefined> {
  const { ctx, lockJob, expandedName, initResult, jobEnvData, hostCtx, concurrencyGroup } = args;
  const { deps } = ctx;
  let gate: ContextGateHandle | undefined;
  const anyDynamic = (lockJob.contexts ?? []).some((e) => e.dynamic);
  // A DYNAMIC binding: the agent reports the ordered list. All STATIC: the
  // agent reports nothing (`init-runner` fills `contextNames` only under
  // `flags.dynamicContext`), so use the lock's names — else a static context
  // is ignored, with all its gates, vars and secrets, just because another
  // field is dynamic. Workflow-level names go first, as on the static path.
  const resolvedNames = anyDynamic
    ? resolveJobContextNames(ctx.workflow, {
        contexts: (initResult?.contextNames ?? []).map((value) => ({ value, dynamic: false })),
      }).names
    : resolveJobContextNames(ctx.workflow, lockJob).names;
  if (resolvedNames.length > 0 && deps.contextStore) {
    // Replaces the placeholder list; `dispatchExecutionAfterInit` persists it.
    jobEnvData.contextNames = [...resolvedNames];
    // The SAME function as the synchronous path, so every gate (`enabled`,
    // branch, minimum trust, concurrency, reviewers, wait timer) applies once
    // the name is known — never a re-implemented subset.
    gate = await applyContextRulesAndSecrets({
      ctx,
      lockJob,
      expandedName,
      contextNames: resolvedNames,
      // The agent-resolved `dynamicConcurrencyGroup`; without it the job gates
      // under the CONTEXT name, sharing a limit with everything bound to it.
      concurrencyGroup: initResult?.concurrencyGroup ?? concurrencyGroup,
      jobEnvData,
      hostCtx,
    });
  }
  if (lockJob.dynamicEnv && initResult?.env !== undefined) {
    jobEnvData.jobEnv = initResult.env;
  }
  return gate;
}

/** Why an init result must not lead to a dispatch. */
export enum InitDispatchSuppression {
  /** The agent's clone diff matched none of the deferred `paths`. */
  Paths = 'paths',
  /** The workflow's own `filter` decided the workflow does not apply. */
  Filter = 'filter',
  /** The job is already rejected by a context rule, or held for approval. */
  Gated = 'gated',
}

/**
 * Whether an arrived init result may dispatch its job.
 *
 * `Paths` first: unmatched deferred `paths` never triggered, whatever the
 * filter says. Only an explicit `false` suppresses; an older agent's missing
 * verdict dispatches.
 *
 * `Filter` needs both a declared filter and a reported `false`: a rogue agent
 * cannot suppress a filter-less workflow, and an older agent's missing verdict
 * must not stop every dispatch.
 *
 * `Gated`: **rejected** is load-bearing — the flow-back's
 * `suppression === Gated && jobEnvData.rejected` branch stops it. **held** is
 * NOT consumed here: a held job gets its init round (only it resolves dynamic
 * values) and the flow-back routes it to `holdExecutionAfterInit`. The no-
 * dispatch guarantee for a held job lives at the call site's `held` branch,
 * `dispatchReadyJob`'s pending-hold check, and the cluster path's
 * `holdJobForApproval`.
 *
 * Exported so the security check is testable.
 */
export function initDispatchSuppression(
  workflow: Pick<LockWorkflow, 'hasFilter'>,
  initResult: { filterPassed?: boolean; pathsPassed?: boolean },
  jobEnvData: Pick<JobEnvData, 'rejected' | 'held'>,
): InitDispatchSuppression | null {
  if (initResult.pathsPassed === false) return InitDispatchSuppression.Paths;
  if (workflow.hasFilter === true && initResult.filterPassed === false) {
    return InitDispatchSuppression.Filter;
  }
  if (jobEnvData.rejected || jobEnvData.held) return InitDispatchSuppression.Gated;
  return null;
}

/**
 * After init, HOLD the job instead of dispatching it: sibling of
 * {@link dispatchExecutionAfterInit} for a lock-file approval on a job with
 * dynamic fields (the dispatch loop skips it, see its `pendingInit` guard).
 *
 *   1. `holdJobForApproval` writes the row, audits it, and stores the context
 *      built from the NOW-RESOLVED `jobEnvData`.
 *   2. The placeholder is registered here, because the loop's single
 *      `addJobsToRun` has long since run.
 */
async function holdExecutionAfterInit(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, jobEnvData } = args;
  const { deps, runId, workflow } = ctx;
  const heldJobs: DispatchedJob[] = [];
  await holdJobForApproval({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    mat,
    envData: jobEnvData,
    dispatchedJobs: heldJobs,
  });
  if (heldJobs.length > 0 && deps.executionTracker) {
    // NOT swallowed: the placeholder alone keeps the run open, so the error
    // propagates to the flow-back's catch, which records a visible init-failure.
    try {
      await deps.executionTracker.addJobsToRun(runId, jobsOfWorkflow(ctx.workflow.name, heldJobs));
    } catch (err) {
      logger.error('Failed to register a held job placeholder after init', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
        error: toErrorMessage(err),
      });
      throw err;
    }
  }
  logger.info('Job held for approval after its init round resolved', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
  });
}

/** After init, dispatch the execution job: via the coordinator with peers, else direct. */
async function dispatchExecutionAfterInit(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  /** Agent-resolved ordered bound-context names. */
  contexts?: string[];
  envWarning?: string;
  skippedContexts?: string[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, contexts, envWarning, skippedContexts } =
    args;
  const lockJob = mat.lockJob;
  // Fields every `addJobsToRun` below persists. `gitCredentials` is here so no
  // route drops it: the relay fails closed on an empty column.
  const trackedFields = {
    ...(contexts?.length ? { contexts } : {}),
    ...(envWarning ? { envWarning } : {}),
    ...(skippedContexts?.length ? { skippedContexts } : {}),
    ...gitCredentialFields(mat.lockJob),
  };
  const matrixValues = mat.variantValues;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  const selectors = runsOnSelectorsForLockJob(lockJob);
  const runsOnLabels = selectors.runsOnLabels;
  const excludeLabels = selectors.excludeLabels;
  const jobInput = buildExecutionJobInput({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    mat,
    selectors,
  });

  let dispatchStatus: string;
  if (deps.coordinator && deps.coordinator.hasConnectedPeers()) {
    const jobToRoute: JobToRoute = {
      jobName: mat.expandedName,
      runsOnLabels: [runsOnLabels],
      runsOnPatterns: selectors.runsOnPatterns,
      excludePatterns: selectors.excludePatterns,
      // Routed through the base dispatcher — see the multi-job route above.
      jobConfig: { ...buildJobConfig(mat), ...globalJobConfigFor(ctx), ...ctx.extraJobConfig },
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      ...cacheArtifactFields(buildPrep),
      excludeLabels,
      ...(lockJob.resources && { resources: lockJob.resources }),
    };
    const cloneTokens = await mintRerouteCloneTokens(ctx);
    const runCtx: RunContext = {
      runId,
      deliveryId: setup.effectiveDeliveryId,
      routingKey: setup.info.routingKey,
      event: setup.info.event,
      action: setup.info.action,
      provider: setup.info.provider,
      payload: setup.info.payload,
      repoIdentifier,
      installationId: credentials?.installationId as number | undefined,
      workflowName: workflow.name,
      requestId: getRequestContext().requestId,
      sha: ref,
      ref: event.sourceBranch ?? event.targetBranch,
      ...cloneTokens,
    };
    const routeResult = await deps.coordinator.routeJobs(runCtx, [jobToRoute]);
    if (routeResult.localJobs.length > 0 || routeResult.reroutedJobs.length > 0) {
      dispatchStatus = routeResult.reroutedJobs.length > 0 ? 'rerouted' : 'dispatched';
    } else {
      dispatchStatus = 'rejected';
    }
    for (const failed of routeResult.failedJobs) {
      const flatLabels = jobToRoute.runsOnLabels?.[0] ?? [];
      logRoleAwareFailure(failed, flatLabels, runId, workflow.name);
    }
    if (routeResult.localJobs.length > 0 && deps.executionTracker) {
      for (const local of routeResult.localJobs) {
        deps.executionTracker
          .addJobsToRun(
            runId,
            jobsOfWorkflow(ctx.workflow.name, [
              {
                jobId: local.jobId,
                jobName: local.jobName,
                runsOnLabels: jobInput.runsOnLabels,
                ...trackedFields,
              },
            ]),
          )
          .catch((err) => {
            logger.error('Failed to add deferred init job to execution tracker', {
              runId,
              error: toErrorMessage(err),
            });
          });
      }
    }
  } else {
    const result = await setup.dispatcher.dispatch(jobInput);
    dispatchStatus = result.status;
    if (result.status === 'rejected' && deps.executionTracker) {
      const syntheticId = `rejected-${randomUUID()}`;
      await deps.executionTracker.addJobsToRun(
        runId,
        jobsOfWorkflow(ctx.workflow.name, [
          {
            jobId: syntheticId,
            jobName: mat.expandedName,
            ...(matrixValues && { matrixValues }),
            runsOnLabels: jobInput.runsOnLabels,
            ...trackedFields,
          },
        ]),
      );
      await deps.executionTracker.onJobStatus(
        runId,
        syntheticId,
        ExecutionJobStatus.enum.failed,
        Date.now(),
        undefined,
        { error: result.reason },
      );
    } else if (result.status !== 'rejected' && deps.executionTracker) {
      deps.executionTracker
        .addJobsToRun(
          runId,
          jobsOfWorkflow(ctx.workflow.name, [
            {
              jobId: result.jobId,
              jobName: mat.expandedName,
              ...(matrixValues && { matrixValues }),
              runsOnLabels: jobInput.runsOnLabels,
              ...trackedFields,
            },
          ]),
        )
        .catch((err) => {
          logger.error('Failed to add deferred init job to execution tracker', {
            runId,
            error: toErrorMessage(err),
          });
        });
    }
  }
  logger.info('Deferred init job resolved, execution job dispatched', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
    status: dispatchStatus,
  });
}

/**
 * Materialize an agent-resolved dynamic matrix and dispatch one job per
 * combination, then insert the children's needs edges.
 */
async function dispatchResolvedDynamicMatrix(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  combos: Array<Record<string, string | undefined>>;
  jobContextData: Map<string, JobEnvData>;
  /** The base job's gate handle; undefined when it binds no context. */
  gate: ContextGateHandle | undefined;
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, combos, jobContextData, gate } = args;
  const { deps, workflow, runId } = ctx;

  let result: ReturnType<typeof materializeResolvedMatrix>;
  try {
    result = materializeResolvedMatrix(mat.lockJob, combos);
  } catch (err) {
    // The placeholder never dispatches, on any exit: release its slot here too,
    // or later jobs in the group are under-admitted.
    if (gate?.admitted) releaseAdmission(ctx, gate.admissionKey, gate.jobName);
    if (err instanceof FanoutError && deps.executionTracker) {
      const jobId = `matrix-failed-${randomUUID()}`;
      await deps.executionTracker
        .addJobsToRun(
          runId,
          jobsOfWorkflow(ctx.workflow.name, [{ jobId, jobName: mat.baseName, runsOnLabels: [] }]),
        )
        .catch(() => {});
      await deps.executionTracker
        .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
          error: err.message,
          initFailure: {
            scope: 'job',
            category: InitFailureCategory.enum.matrix_expansion,
            message: err.message,
            jobName: mat.baseName,
          },
        })
        .catch(() => {});
      return;
    }
    throw err;
  }

  // Children inherit the base's resolved env data, keyed by expanded name for
  // makeBuildJobConfig.
  const baseEnvData = jobContextData.get(mat.expandedName) ?? {};
  // Children replace the placeholder: release its slot, or N children take N+1.
  if (gate?.admitted) releaseAdmission(ctx, gate.admissionKey, gate.jobName);
  for (const child of result.jobs) {
    const childEnvData: JobEnvData = { ...baseEnvData };
    jobContextData.set(child.expandedName, childEnvData);
    // Gate each child, as a STATIC matrix does; gating only the placeholder
    // admits all N against one slot. A base reject/hold fans out unchanged, so
    // no slot is spent re-gating.
    if (gate && !childEnvData.rejected && !childEnvData.held) {
      await applyContextProtectionGates({
        ctx,
        lockJob: mat.lockJob,
        gate: {
          ...gate,
          jobName: child.expandedName,
          dispatchCtx: { ...gate.dispatchCtx, jobId: child.expandedName },
        },
        jobEnvData: childEnvData,
      });
    }
    // Defensive: the base's gate rejects before fan-out and the reject gates
    // are deterministic. Recorded so the run never waits on a silent child.
    if (childEnvData.rejected) {
      await recordContextRuleRejectionAfterInit({ ctx, mat: child, jobEnvData: childEnvData });
      continue;
    }
    // A held base holds each child (keyed on expanded name), as a STATIC matrix
    // does; holding the placeholder would resume one un-expanded job.
    if (childEnvData.held) {
      await holdExecutionAfterInit({
        ctx,
        setup,
        buildPrep,
        buildJobConfig,
        mat: child,
        jobEnvData: childEnvData,
      });
      continue;
    }
    await dispatchExecutionAfterInit({
      ctx,
      setup,
      buildPrep,
      buildJobConfig,
      mat: child,
      contexts: baseEnvData.contextNames,
    });
  }

  // Downstreams needing the base name wait for every child.
  if (deps.db) {
    try {
      await insertEdgesForRun(deps.db, runId, result.jobs, result.expansionMap);
    } catch (err) {
      logger.error('Failed to insert needs edges for resolved dynamic matrix', {
        runId,
        workflow: workflow.name,
        job: mat.baseName,
        error: toErrorMessage(err),
      });
    }
  }
}

function startDeferredInitDispatch(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  jobContextData: Map<string, JobEnvData>;
  deferredInitJobs: DeferredInitJob[];
}): void {
  const { ctx, setup, buildPrep, buildJobConfig, jobContextData, deferredInitJobs } = args;
  const { deps, workflow, runId } = ctx;
  if (deferredInitJobs.length === 0 || !deps.pendingInits) return;
  logger.info('Starting deferred init dispatch', { runId, count: deferredInitJobs.length });
  const pendingInits = deps.pendingInits;
  const { executionTracker } = deps;
  for (const { mat, initJobInput } of deferredInitJobs) {
    const lockJob = mat.lockJob;
    // The task outlives this call, so it holds its own token, taken
    // synchronously before the finally drops the window token — never un-held.
    const held = executionTracker?.holdRunForPendingJobs(runId) ?? false;
    const spawned = (async () => {
      try {
        logger.info('Dispatching deferred init job', {
          runId,
          workflow: workflow.name,
          job: mat.expandedName,
          initJob: initJobInput.jobName,
        });
        const dispatchResult = await setup.dispatcher.dispatch(initJobInput);
        if (dispatchResult.status === 'rejected' || dispatchResult.status === 'duplicate') {
          throw new Error(`Init job dispatch rejected: ${dispatchResult.status}`);
        }
        // Tracked like `queued`: the init job IS queued and runs once an agent
        // appears, so failing the run here would orphan it.
        if (dispatchResult.status === 'queued-no-backend') {
          logger.warn('Init job has no matching backend (tracked, awaiting capacity)', {
            runId,
            workflow: workflow.name,
            job: mat.expandedName,
            initJob: initJobInput.jobName,
          });
        }
        const initResult = await pendingInits.track(dispatchResult.jobId);
        const jobEnvData = jobContextData.get(mat.expandedName) ?? {};
        jobEnvData.pendingInit = false;
        const suppression = initDispatchSuppression(workflow, initResult, jobEnvData);
        if (suppression === InitDispatchSuppression.Paths) {
          logger.info('Workflow paths suppressed dispatch', {
            runId,
            workflowName: workflow.name,
            jobName: mat.expandedName,
          });
          jobContextData.set(mat.expandedName, jobEnvData);
          return;
        }
        if (suppression === InitDispatchSuppression.Filter) {
          logger.info('Workflow filter suppressed dispatch', {
            runId,
            workflow: workflow.name,
            job: mat.expandedName,
          });
          jobContextData.set(mat.expandedName, jobEnvData);
          return;
        }
        // A REJECTED job stops here. A HELD one continues: release dispatches
        // the STORED context verbatim, so values must resolve and store now.
        if (suppression === InitDispatchSuppression.Gated && jobEnvData.rejected) {
          // Defensive (nothing sets `rejected` between deferral and here), but
          // recorded: the static collector skips `pendingInit` jobs.
          await recordContextRuleRejectionAfterInit({ ctx, mat, jobEnvData });
          jobContextData.set(mat.expandedName, jobEnvData);
          return;
        }
        const contextGate = await applyInitResultContext({
          ctx,
          lockJob,
          expandedName: mat.expandedName,
          initResult,
          jobEnvData,
          hostCtx: hostCtxFromMat(mat),
          ...(typeof lockJob.concurrencyGroup === 'string' && !lockJob.dynamicConcurrencyGroup
            ? { concurrencyGroup: lockJob.concurrencyGroup }
            : {}),
        });
        // Decided after `kici run remote` got its accept response, so the
        // warning goes on the run's log stream for the CLI to print.
        if (jobEnvData.envWarning && deps.logWriter) {
          await deps.logWriter.appendChunk(
            runId,
            mat.expandedName,
            0,
            [jobEnvData.envWarning],
            Date.now(),
          );
        }
        // Static holds AFTER context rules, as on the synchronous path.
        await applyStaticApprovalHolds({ ctx, lockJob, jobEnvData });
        jobContextData.set(mat.expandedName, jobEnvData);
        // Re-checked AFTER resolution: `applyInitResultContext` sets `rejected`
        // for a dynamically-bound context.
        if (jobEnvData.rejected) {
          await recordContextRuleRejectionAfterInit({ ctx, mat, jobEnvData });
          return;
        }
        // Matrix BEFORE the single-job hold: a held dynamic matrix holds per
        // child inside `dispatchResolvedDynamicMatrix`.
        if (mat.pendingDynamicMatrix && initResult.matrixValues) {
          await dispatchResolvedDynamicMatrix({
            ctx,
            setup,
            buildPrep,
            buildJobConfig,
            mat,
            combos: initResult.matrixValues,
            jobContextData,
            gate: contextGate,
          });
        } else if (jobEnvData.held) {
          // Hold and context are created HERE so the stored input carries the
          // resolved values; `storePendingJobContext` upserts.
          await holdExecutionAfterInit({ ctx, setup, buildPrep, buildJobConfig, mat, jobEnvData });
        } else {
          await dispatchExecutionAfterInit({
            ctx,
            setup,
            buildPrep,
            buildJobConfig,
            mat,
            contexts: jobEnvData.contextNames,
            ...(jobEnvData.envWarning && { envWarning: jobEnvData.envWarning }),
            ...(jobEnvData.skippedEnvs && { skippedContexts: jobEnvData.skippedEnvs }),
          });
        }
      } catch (err) {
        const errMsg = toErrorMessage(err);
        logger.error('Deferred init job failed', {
          runId,
          workflow: workflow.name,
          job: mat.expandedName,
          error: errMsg,
        });
        if (deps.executionTracker) {
          const jobId = `init-failed-${mat.expandedName}`;
          await deps.executionTracker
            .addJobsToRun(
              runId,
              jobsOfWorkflow(ctx.workflow.name, [
                {
                  jobId,
                  jobName: mat.expandedName,
                  ...(mat.variantValues && { matrixValues: mat.variantValues }),
                  runsOnLabels: runsOnSelectorsForLockJob(lockJob).runsOnLabels,
                },
              ]),
            )
            .catch(() => {});
          const carried = err instanceof AgentJobFailedError ? err.initFailure : undefined;
          await deps.executionTracker
            .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
              error: errMsg,
              initFailure: {
                scope: 'job',
                category: carried?.category ?? InitFailureCategory.enum.dynamic_eval,
                message: errMsg,
                jobName: mat.expandedName,
              },
            })
            .catch(() => {});
        }
      }
    })();
    // Released in `.finally()` on the promise, not a try/finally inside it (the
    // body returns early on several paths above its own try); after its catch,
    // so the `init-failed-*` row lands while the token is still held.
    if (!held) {
      logger.warn('Deferred init job dispatched without a pending-jobs token', {
        runId,
        workflow: workflow.name,
      });
    }
    void spawned
      .catch((err: unknown) => {
        logger.error('Deferred init dispatch task failed', {
          runId,
          error: toErrorMessage(err),
        });
      })
      .finally(() => {
        if (!held) return;
        executionTracker?.releasePendingJobsHold(runId).catch((err: unknown) => {
          logger.error('Failed to release pending-jobs hold', {
            runId,
            error: toErrorMessage(err),
          });
        });
      });
  }
}

// ---------------------------------------------------------------------------
// Phase J — deferred dynamic dispatch
// ---------------------------------------------------------------------------

export interface GeneratedJobConfig {
  /**
   * `name` and `needs` rewritten to expanded matrix-child names; dispatch,
   * needs edges and tracking key on this name.
   */
  genJob: LockJob;
  genJobConfig: Record<string, unknown>;
  runsOnLabels: string[];
  /** JS post-filter. */
  runsOnPatterns: LabelMatcher[];
  excludeLabels: string[];
  /** JS post-filter. */
  excludePatterns: LabelMatcher[];
  /** Set when runsOn resolved to a roster host. */
  pinnedAgentId?: string;
  /** Cross-cluster reroute hint; null = not connected. */
  connectedInstanceId?: string | null;
  matrixValues?: Record<string, unknown>;
  /**
   * Inherited from the generator's LOCK entry; persisted to
   * `execution_jobs.git_credentials` at every dispatch site for the relay.
   */
  gitCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Context-data source for a later dispatch; no context data rests in storage. */
  contextResolution?: DeferredContextResolution;
}

/**
 * Split generated configs into pinned and unpinned. Pinned always use the
 * dispatcher pin path: `JobToRoute` has no pin field, so the coordinator would
 * silently drop it.
 */
export function partitionGeneratedConfigsByPin(configs: readonly GeneratedJobConfig[]): {
  pinnedConfigs: GeneratedJobConfig[];
  unpinnedConfigs: GeneratedJobConfig[];
} {
  const pinnedConfigs: GeneratedJobConfig[] = [];
  const unpinnedConfigs: GeneratedJobConfig[] = [];
  for (const c of configs) {
    if (c.pinnedAgentId) pinnedConfigs.push(c);
    else unpinnedConfigs.push(c);
  }
  return { pinnedConfigs, unpinnedConfigs };
}

async function dispatchEvalJob(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
  /** Result-aware generators only. */
  upstreamSnapshot?: UpstreamSnapshot;
}): Promise<{
  evalJobId: string;
  evalJobLabels: string[];
  evalJobName: string;
  /** Result-aware only: the synthetic row to swap for the real eval id. */
  replaceSyntheticId: string | undefined;
  runsOnLabels: string[];
}> {
  const { ctx, setup, buildPrep, dynamicEntry, upstreamSnapshot } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  const evalJobName = `__dynamic__${workflow.name}__${dynamicEntry.source.index}`;
  logger.info('Dispatching dynamic eval job', {
    runId,
    workflow: workflow.name,
    evalJob: evalJobName,
    sourceIndex: dynamicEntry.source.index,
    resultAware: !!upstreamSnapshot,
  });
  const jobConfig: Record<string, unknown> = {
    dynamicJobFn: true,
    workflowName: workflow.name,
    source: dynamicEntry.source,
    event,
    timeoutMs: 120_000,
    // `filter` gates the generator too (nothing generated on `false`), or a
    // mixed workflow half-dispatches. Omitted (never `false`) when absent.
    ...(workflow.hasFilter === true && { hasFilter: true }),
    // Deferred paths gate it the same way, ahead of the filter.
    ...(deferredPathsOf(ctx) && { deferredPaths: deferredPathsOf(ctx) }),
    ...(workflow.contentHash && !ctx.testRun && { contentHash: workflow.contentHash }),
    ...(workflow.resolvedHashFiles?.length && {
      resolvedHashFiles: workflow.resolvedHashFiles,
    }),
    // For the agent to build ctx.needs at eval time.
    ...(upstreamSnapshot && {
      resultAware: true,
      declaredNeeds: dynamicEntry.needs ?? [],
      upstreamSnapshot,
    }),
    ...globalJobConfigFor(ctx),
  };
  const evalJobInput: QueuedJobInput = {
    runId,
    workflowName: workflow.name,
    jobName: evalJobName,
    runsOnLabels: [
      INIT_RUNNER_ROLE_LABEL,
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig,
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarDigest: buildPrep.sourceTarDigest,
    // A global job restores the tarball into the workflow repository's checkout,
    // with or without a source pack.
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
  };
  // Look up registerDeferredEvalJob's synthetic row BEFORE dispatch: an await
  // between dispatch and the caller's pendingDynamics.track() races a fast
  // eval-complete reply and drops the resolve.
  const replaceSyntheticId =
    upstreamSnapshot && deps.executionTracker
      ? await deps.executionTracker.findDynamicEvalSyntheticId(runId, evalJobName)
      : undefined;

  const evalResult = await setup.dispatcher.dispatch(evalJobInput);
  if (evalResult.status !== 'dispatched' && evalResult.status !== 'queued') {
    throw new Error(`Dynamic eval job dispatch rejected: ${evalResult.status}`);
  }
  return {
    evalJobId: evalResult.jobId,
    evalJobLabels: evalJobInput.runsOnLabels,
    evalJobName,
    replaceSyntheticId,
    runsOnLabels: evalJobInput.runsOnLabels,
  };
}

/**
 * Record a dropped generated-job matrix as a `matrix_expansion` init failure so
 * the run's dashboard surfaces it, mirroring the static / top-level dynamic-matrix
 * paths.
 */
async function recordGeneratedMatrixFailure(
  deps: WorkflowDispatchContext['deps'],
  runId: string,
  workflowName: string,
  err: FanoutError,
): Promise<void> {
  if (!deps.executionTracker) return;
  const jobId = `matrix-failed-${randomUUID()}`;
  await deps.executionTracker
    .addJobsToRun(
      runId,
      jobsOfWorkflow(workflowName, [{ jobId, jobName: err.jobName, runsOnLabels: [] }]),
    )
    .catch(() => {});
  await deps.executionTracker
    .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
      error: err.message,
      initFailure: {
        scope: 'job',
        category: InitFailureCategory.enum.matrix_expansion,
        message: err.message,
        jobName: err.jobName,
      },
    })
    .catch(() => {});
}

/** Inputs {@link resolveGeneratedJobConfigs} builds every generated job's config from. */
interface ResolveGeneratedJobConfigsArgs {
  ctx: WorkflowDispatchContext;
  workflow: LockWorkflow;
  fullLockFile: WorkflowDispatchContext['fullLockFile'];
  runPublicKeyBase64: string | undefined;
  npmRegistries: NpmRegistrySpec[] | undefined;
  installEnvSecrets: Record<string, string> | undefined;
  generatedJobs: LockJob[];
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
  /** Threaded into each job's dynamicSource for re-eval. */
  upstreamSnapshot?: UpstreamSnapshot;
}

/** A generated job its contexts' gates held. */
export interface HeldGeneratedJob {
  config: GeneratedJobConfig;
  envData: JobEnvData;
}

/**
 * Generated jobs by gate verdict. Rejected or thrown jobs are in neither list;
 * they are recorded on the run as failed.
 */
export interface GeneratedJobResolution {
  /** Carrying their resolved context data. */
  dispatchable: GeneratedJobConfig[];
  /** Context secrets not resolved. */
  held: HeldGeneratedJob[];
}

/**
 * Gate a generated job's contexts through the SAME
 * {@link applyContextRulesAndSecrets} as a lock job. Its `contexts` is
 * job-code output, so binding one must cost the full set of rules and gates
 * before any vars or secrets resolve.
 */
async function gateGeneratedJobContexts(args: {
  ctx: WorkflowDispatchContext;
  workflow: Pick<LockWorkflow, 'contexts'>;
  mat: MaterializedJob;
}): Promise<JobEnvData> {
  const { ctx, workflow, mat } = args;
  const genJob = mat.lockJob;
  const jobEnvData: JobEnvData = {};
  // Workflow-level contexts bind too; dynamic elements are not resolved here,
  // so only static names are gated.
  const contextNames = resolveJobContextNames(workflow, genJob).names;
  if (contextNames.length === 0) return jobEnvData;
  await applyContextRulesAndSecrets({
    ctx,
    lockJob: genJob,
    expandedName: mat.expandedName,
    contextNames,
    concurrencyGroup:
      genJob.dynamicConcurrencyGroup || typeof genJob.concurrencyGroup !== 'string'
        ? undefined
        : genJob.concurrencyGroup,
    jobEnvData,
    hostCtx: hostCtxFromMat(mat),
    // Needs-gated: dispatched later by the scheduler, no in-pass slot.
    dispatchesThisPass: isRootJob(genJob),
    resolveRegistryAuth: false,
  });
  return jobEnvData;
}

/** Build one generated job's config from its gate-resolved context data. */
async function buildGeneratedJobConfig(args: {
  base: ResolveGeneratedJobConfigsArgs;
  mat: MaterializedJob;
  jobEnvData: JobEnvData;
  expectedJobNames: string[];
  expandNeeds: (needs: LockJob['needs']) => LockJob['needs'];
}): Promise<GeneratedJobConfig> {
  const { base, mat, jobEnvData, expectedJobNames, expandNeeds } = args;
  const { ctx, workflow, fullLockFile, runPublicKeyBase64, npmRegistries } = base;
  const { installEnvSecrets, dynamicEntry, upstreamSnapshot } = base;
  const { deps, event } = ctx;
  const genJob = mat.lockJob;
  // Inherit the GENERATOR's lock ceiling, never `genJob`'s: that is unvalidated
  // agent JSON, and reading it lets job code grant its own authorization.
  const inheritedGitCredentials = dynamicEntry.gitCredentials;
  // Run-wide CLI flat secrets win on collision + reach env-less dynamic jobs.
  const genSecrets: Record<string, string> = {
    ...(jobEnvData.jobSecrets ?? {}),
    ...(ctx.runWideFlatSecrets ?? {}),
  };
  const genNamespacedSecrets: Record<string, Record<string, string>> = {
    ...(jobEnvData.jobNamespacedSecrets ?? {}),
  };
  const hasSecrets = Object.keys(genSecrets).length > 0;
  const hasNamespaced = Object.keys(genNamespacedSecrets).length > 0;
  const expandedNeeds = expandNeeds(genJob.needs);
  const envelope = matrixEnvelopeFields(mat);
  const genJobConfig: Record<string, unknown> = {
    source: workflow.source ?? fullLockFile.source,
    workflowName: workflow.name,
    name: envelope.name,
    steps: genJob.steps,
    needs: expandedNeeds,
    // Raw matrix is consumed here; the child carries baseJobName + matrixValues
    // (ctx.job.name + ctx.matrix).
    ...(envelope.matrixValues && {
      baseJobName: envelope.baseJobName,
      matrixValues: envelope.matrixValues,
    }),
    ...(workflow.contentHash && !ctx.testRun && { contentHash: workflow.contentHash }),
    ...(hasSecrets && { secrets: genSecrets }),
    ...(hasNamespaced && { namespacedSecrets: genNamespacedSecrets }),
    ...(runPublicKeyBase64 && { runPublicKey: runPublicKeyBase64 }),
    ...(npmRegistries && npmRegistries.length > 0 && { npmRegistries }),
    ...(installEnvSecrets && Object.keys(installEnvSecrets).length > 0 && { installEnvSecrets }),
    ...(jobEnvData.contextName && { context: jobEnvData.contextName }),
    ...(jobEnvData.contextVars && { contextVars: jobEnvData.contextVars }),
    ...(genJob.env &&
      typeof genJob.env === 'object' && {
        jobEnv: genJob.env as Record<string, string>,
      }),
    ...(inheritedGitCredentials && { gitCredentials: inheritedGitCredentials }),
    dynamicSource: {
      index: dynamicEntry.source.index,
      event,
      expectedJobNames,
      // Re-eval sees the same frozen snapshot and declared needs.
      ...(upstreamSnapshot && {
        upstreamSnapshot,
        declaredNeeds: dynamicEntry.needs ?? [],
      }),
    },
    ...globalJobConfigFor(ctx),
  };
  const genSel = runsOnSelectorsForLockJob(genJob);
  const pin = await resolveRosterAgentPin({
    runsOnExact: genSel.runsOnExactRaw,
    runsOnPatterns: genSel.runsOnPatterns,
    hostRosterStore: deps.hostRosterStore,
  });
  return {
    genJob: { ...genJob, name: envelope.name, needs: expandedNeeds },
    genJobConfig,
    // A pin clears routing labels, like runsOnAll children.
    runsOnLabels: pin ? [] : genSel.runsOnLabels,
    runsOnPatterns: pin ? [] : genSel.runsOnPatterns,
    excludeLabels: genSel.excludeLabels,
    excludePatterns: genSel.excludePatterns,
    ...(pin && {
      pinnedAgentId: pin.pinnedAgentId,
      connectedInstanceId: pin.connectedInstanceId,
    }),
    ...(envelope.matrixValues && { matrixValues: envelope.matrixValues }),
    ...(inheritedGitCredentials && { gitCredentials: inheritedGitCredentials }),
    ...(jobEnvData.contextResolution && { contextResolution: jobEnvData.contextResolution }),
  };
}

/**
 * Gate each generated job and build its config. Rejected or thrown jobs are
 * recorded on the run as failed and returned in neither list.
 */
export async function resolveGeneratedJobConfigs(
  args: ResolveGeneratedJobConfigsArgs,
): Promise<GeneratedJobResolution> {
  const { ctx, generatedJobs } = args;
  const { deps, runId } = ctx;
  const dispatchable: GeneratedJobConfig[] = [];
  const held: HeldGeneratedJob[] = [];

  // The agent already resolved dynamic matrix fns to static matrices, so fan
  // out here like a lock static matrix; the expansion map rewrites needs. A
  // failing matrix is recorded and dropped so it cannot poison the rest.
  let fanout;
  const remaining = [...generatedJobs];
  for (;;) {
    try {
      fanout = materializeFanout(remaining);
      break;
    } catch (err) {
      if (!(err instanceof FanoutError)) throw err;
      logger.error('Dynamic generated job matrix materialization failed', {
        runId,
        job: err.jobName,
        error: err.message,
      });
      await recordGeneratedMatrixFailure(deps, runId, ctx.workflow.name, err);
      const before = remaining.length;
      const idx = remaining.findIndex((j) => j.name === err.jobName);
      if (idx >= 0) remaining.splice(idx, 1);
      if (remaining.length === before) throw err; // safety: avoid an infinite loop
    }
  }
  // The agent's re-eval determinism check compares BASE names (the factory
  // never expands matrices), de-duplicated across children.
  const expectedJobNames = [...new Set(fanout.jobs.map((m) => m.baseName))];

  const expandNeeds = (needs: LockJob['needs']): LockJob['needs'] => {
    const expanded: unknown[] = [];
    for (const need of needs) {
      if (typeof need === 'string') {
        for (const name of fanout.expansionMap.get(need) ?? [need]) {
          expanded.push(name);
        }
      } else if (typeof need === 'object' && 'name' in need && !('group' in need)) {
        const entry = need as { name: string; runOn?: ExecutionJobStatus[] };
        for (const name of fanout.expansionMap.get(entry.name) ?? [entry.name]) {
          expanded.push({ ...entry, name });
        }
      } else {
        expanded.push(need);
      }
    }
    return expanded as LockJob['needs'];
  };

  for (const mat of fanout.jobs) {
    let step = GeneratedJobStep.ContextGate;
    try {
      const jobEnvData = await gateGeneratedJobContexts({ ctx, workflow: args.workflow, mat });
      // fails-when: a generated job binds a context whose branch / repo / trigger rule refuses the
      // run
      // breaks-if-wrong: a job whose contexts admit the run must still build and dispatch below
      if (jobEnvData.rejected) {
        await recordContextRuleRejectionAfterInit({ ctx, mat, jobEnvData });
        continue;
      }
      step = GeneratedJobStep.JobConfig;
      const config = await buildGeneratedJobConfig({
        base: args,
        mat,
        jobEnvData,
        expectedJobNames,
        expandNeeds,
      });
      // fails-when: a reviewer / wait-timer / trust / concurrency gate holds the job
      // breaks-if-wrong: an ungated or admitted job must land in `dispatchable`
      if (jobEnvData.held) held.push({ config, envData: jobEnvData });
      else dispatchable.push(config);
    } catch (err) {
      await dropGeneratedJob({ ctx, mat, step, err });
    }
  }
  return { dispatchable, held };
}

/** The step of resolving one generated job that a per-job failure came from. */
enum GeneratedJobStep {
  /** `gateGeneratedJobContexts`. */
  ContextGate = 'context-gate',
  /** `buildGeneratedJobConfig`, including the global checkout fields. */
  JobConfig = 'job-config',
}

const DROPPED_GENERATED_JOB_MESSAGES: Record<GeneratedJobStep, string> = {
  [GeneratedJobStep.ContextGate]: 'Dropped a dynamic generated job: its context gate failed',
  [GeneratedJobStep.JobConfig]:
    'Dropped a dynamic generated job: its job config could not be built',
};

/** The failure a dropped generated job is recorded with on the run, per failed step. */
const DROPPED_GENERATED_JOB_FAILURES: Record<
  GeneratedJobStep,
  { category: InitFailureCategory; reason: string }
> = {
  [GeneratedJobStep.ContextGate]: {
    category: InitFailureCategory.enum.secret_resolution,
    reason: 'Its contexts could not be resolved',
  },
  [GeneratedJobStep.JobConfig]: {
    category: InitFailureCategory.enum.dynamic_eval,
    reason: 'Its job config could not be built',
  },
};

/**
 * Drop a generated job whose resolution threw: log the step, release its
 * in-pass slot by name (the gate may have thrown after reserving, leaving no
 * handle), and record it failed.
 *
 * The terminal row stops dependents waiting forever on a missing upstream and
 * a dependent-free run finishing green without it. Awaited before the caller
 * inserts edges and recomputes, so the recompute skips its dependents.
 */
async function dropGeneratedJob(args: {
  ctx: WorkflowDispatchContext;
  mat: MaterializedJob;
  step: GeneratedJobStep;
  err: unknown;
}): Promise<void> {
  const { ctx, mat, step, err } = args;
  const jobName = mat.expandedName;
  // fails-when: a root generated job dropped after its gate admitted it keeps its slot, so a
  // sibling under the same concurrency limit is queued behind a job that never runs
  // breaks-if-wrong: a sibling's own reservation under the same key stays in place
  for (const names of ctx.concurrencyAdmissions?.values() ?? []) names.delete(jobName);
  const error = toErrorMessage(err);
  logger.error(DROPPED_GENERATED_JOB_MESSAGES[step], {
    runId: ctx.runId,
    job: jobName,
    step,
    error,
  });
  await recordDroppedGeneratedJob({ ctx, mat, step, error });
}

/** Record a dropped generated job on the run as a failed job carrying a job-scoped init failure. */
async function recordDroppedGeneratedJob(args: {
  ctx: WorkflowDispatchContext;
  mat: MaterializedJob;
  step: GeneratedJobStep;
  error: string;
}): Promise<void> {
  const { ctx, mat, step, error } = args;
  const tracker = ctx.deps.executionTracker;
  if (!tracker) return;
  const { category, reason } = DROPPED_GENERATED_JOB_FAILURES[step];
  const message = `${reason}: ${error}`;
  const jobId = `generated-failed-${randomUUID()}`;
  const onError = (recordErr: unknown): void => {
    logger.error('Failed to record a dropped generated job on the run', {
      runId: ctx.runId,
      job: mat.expandedName,
      error: toErrorMessage(recordErr),
    });
  };
  await tracker
    .addJobsToRun(
      ctx.runId,
      jobsOfWorkflow(ctx.workflow.name, [
        {
          jobId,
          jobName: mat.expandedName,
          ...(mat.variantValues && { matrixValues: mat.variantValues }),
          ...variantTrackingFields(mat),
          runsOnLabels: runsOnLabelsOrNone(mat.lockJob),
        },
      ]),
    )
    .catch(onError);
  await tracker
    .onJobStatus(ctx.runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
      error: message,
      initFailure: { scope: 'job', category, message, jobName: mat.expandedName },
    })
    .catch(onError);
}

/**
 * Exact runs-on labels, or none when the job-code matchers are invalid —
 * possibly why the job is being dropped.
 */
function runsOnLabelsOrNone(lockJob: LockJob): string[] {
  // fails-when: a job dropped for an invalid matcher throws here again, so it is never recorded
  // breaks-if-wrong: a job with valid matchers is still recorded with its exact labels
  try {
    return runsOnSelectorsForLockJob(lockJob).runsOnLabels;
  } catch {
    return [];
  }
}

/** Insert the `execution_job_needs` edges of needs-gated generated jobs. */
async function insertGeneratedJobEdges(
  db: Kysely<Database>,
  runId: string,
  configs: readonly GeneratedJobConfig[],
): Promise<void> {
  const edgeRows: Array<{
    run_id: string;
    job_name: string;
    upstream_name: string;
    run_on: string;
  }> = [];
  for (const { genJob } of configs) {
    for (const need of genJob.needs) {
      if (typeof need === 'string') {
        edgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: need,
          run_on: SUCCESS_ONLY_RUN_ON_JSON,
        });
      } else if (typeof need === 'object' && 'name' in need && !('group' in need)) {
        edgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: (need as { name: string }).name,
          run_on: needsRunOnJson(need as { runOn?: ExecutionJobStatus[] }),
        });
      }
    }
  }
  if (edgeRows.length > 0) {
    await db
      .insertInto('execution_job_needs')
      .values(edgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** The queued dispatch input for one generated job, without a host pin. */
function buildGeneratedJobInput(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  config: GeneratedJobConfig;
}): QueuedJobInput {
  const { ctx, setup, buildPrep, config } = args;
  const { workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  return {
    runId,
    workflowName: workflow.name,
    jobName: config.genJob.name,
    runsOnLabels: config.runsOnLabels,
    runsOnPatterns: config.runsOnPatterns,
    excludeLabels: config.excludeLabels,
    excludePatterns: config.excludePatterns,
    jobConfig: config.genJobConfig,
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarDigest: buildPrep.sourceTarDigest,
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
    requestId: getRequestContext().requestId,
  };
}

async function gateAndStoreNonRootGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  gatedGeneratedConfigs: GeneratedJobConfig[];
}): Promise<void> {
  const { ctx, setup, buildPrep, gatedGeneratedConfigs } = args;
  const { deps, workflow, runId } = ctx;
  if (gatedGeneratedConfigs.length === 0 || !deps.db) return;
  await insertGeneratedJobEdges(deps.db, runId, gatedGeneratedConfigs);
  for (const config of gatedGeneratedConfigs) {
    const { genJob, runsOnLabels, matrixValues, gitCredentials } = config;
    const gatedJobInput = buildGeneratedJobInput({ ctx, setup, buildPrep, config });
    // A generated invoke gate registers as pending; the scheduler releases it.
    const gateInvokeParams = invokeParamsFromLockJob(genJob);
    if (gateInvokeParams) {
      await registerGeneratedInvokeGate({
        ctx,
        jobName: genJob.name,
        matrixValues,
        jobInput: gatedJobInput,
        invokeParams: gateInvokeParams,
        resolution: config.contextResolution,
        release: false,
      });
      continue;
    }
    await storeDeferredJobContext({
      ctx,
      db: deps.db,
      jobName: genJob.name,
      jobInput: gatedJobInput,
      runsOnLabels,
      resolution: config.contextResolution,
    });
    const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${genJob.name}-${randomUUID()}`;
    if (deps.executionTracker) {
      await deps.executionTracker.addJobsToRun(
        runId,
        jobsOfWorkflow(ctx.workflow.name, [
          {
            jobId: syntheticId,
            jobName: genJob.name,
            runsOnLabels,
            ...(matrixValues && { matrixValues }),
            ...(gitCredentials && { gitCredentials }),
          },
        ]),
      );
    }
    logger.info('Generated job gated by cross-domain needs', {
      runId,
      workflow: workflow.name,
      job: genJob.name,
      needs: genJob.needs,
    });
  }
}

/**
 * Hold gate-held generated jobs via {@link persistJobHold}, so approval
 * resumes each through `dispatchReadyJob`. Needs-gated ones get their edges so
 * approval cannot outrun upstreams. Placeholders register in one call
 * afterwards and a failure propagates: without one the run completes while
 * the job waits.
 */
async function holdGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  held: HeldGeneratedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, held } = args;
  const { deps, runId } = ctx;
  if (held.length === 0) return;
  const needsGated = held.map((h) => h.config).filter((c) => !isRootJob(c.genJob));
  if (deps.db && needsGated.length > 0) await insertGeneratedJobEdges(deps.db, runId, needsGated);
  const placeholders: DispatchedJob[] = [];
  for (const { config, envData } of held) {
    const { genJob, runsOnLabels, matrixValues, gitCredentials } = config;
    await persistJobHold({
      ctx,
      jobName: genJob.name,
      envData,
      runsOnLabels,
      buildJobInput: () => buildGeneratedJobInput({ ctx, setup, buildPrep, config }),
      placeholder: {
        jobName: genJob.name,
        runsOnLabels,
        ...(matrixValues && { matrixValues }),
        // The generator's lock-granted map, never the generated job's own.
        ...(gitCredentials && { gitCredentials }),
      },
      dispatchedJobs: placeholders,
    });
  }
  if (placeholders.length > 0 && deps.executionTracker) {
    await deps.executionTracker.addJobsToRun(
      runId,
      jobsOfWorkflow(ctx.workflow.name, placeholders),
    );
  }
}

async function directDispatchGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  configs: GeneratedJobConfig[];
}): Promise<void> {
  const { ctx, setup, buildPrep, configs } = args;
  const { deps, runId } = ctx;
  for (const config of configs) {
    const { genJob, runsOnLabels, matrixValues, pinnedAgentId, connectedInstanceId } = config;
    const { gitCredentials } = config;
    try {
      const genJobInput: QueuedJobInput = {
        ...buildGeneratedJobInput({ ctx, setup, buildPrep, config }),
        ...(pinnedAgentId && { pinnedAgentId }),
        ...(connectedInstanceId !== undefined && { connectedInstanceId }),
      };
      // A root generated gate is released now; the run is already tracked.
      const gateInvokeParams = invokeParamsFromLockJob(genJob);
      if (gateInvokeParams) {
        await registerGeneratedInvokeGate({
          ctx,
          jobName: genJob.name,
          matrixValues,
          jobInput: genJobInput,
          invokeParams: gateInvokeParams,
          resolution: config.contextResolution,
          release: true,
        });
        continue;
      }
      const genResult = await setup.dispatcher.dispatch(genJobInput);
      if (genResult.status !== 'rejected' && deps.executionTracker) {
        await deps.executionTracker.addJobsToRun(
          runId,
          jobsOfWorkflow(ctx.workflow.name, [
            {
              jobId: genResult.jobId,
              jobName: genJob.name,
              runsOnLabels,
              ...(matrixValues && { matrixValues }),
              ...(gitCredentials && { gitCredentials }),
            },
          ]),
        );
      }
      logger.info('Dynamic generated job dispatched (direct)', {
        runId,
        job: genJob.name,
        status: genResult.status,
      });
    } catch (err) {
      logger.error('Failed to dispatch dynamic generated job', {
        runId,
        job: genJob.name,
        error: toErrorMessage(err),
      });
    }
  }
}

async function routeRootGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  rootGeneratedConfigs: GeneratedJobConfig[];
}): Promise<void> {
  const { ctx, setup, buildPrep, rootGeneratedConfigs } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  if (rootGeneratedConfigs.length === 0) return;

  // Invoke gates stay on the ingesting orchestrator.
  const gateConfigs = rootGeneratedConfigs.filter((c) => isInvokeGate(c.genJob));
  if (gateConfigs.length > 0) {
    await directDispatchGeneratedJobs({ ctx, setup, buildPrep, configs: gateConfigs });
  }
  const nonGateConfigs = rootGeneratedConfigs.filter((c) => !isInvokeGate(c.genJob));
  if (nonGateConfigs.length === 0) return;

  const { pinnedConfigs, unpinnedConfigs } = partitionGeneratedConfigsByPin(nonGateConfigs);

  // Pinned jobs use dispatchPinned (see `partitionGeneratedConfigsByPin`), which
  // handles local, queue-with-pin and cross-cluster reroute like runsOnAll.
  if (pinnedConfigs.length > 0) {
    await directDispatchGeneratedJobs({ ctx, setup, buildPrep, configs: pinnedConfigs });
  }
  if (unpinnedConfigs.length === 0) return;

  const generatedJobsToRoute: JobToRoute[] = unpinnedConfigs.map(
    ({ genJob, genJobConfig, runsOnLabels, runsOnPatterns, excludeLabels, excludePatterns }) => ({
      jobName: genJob.name,
      runsOnLabels: [runsOnLabels],
      runsOnPatterns,
      excludePatterns,
      jobConfig: genJobConfig,
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      sourceTarUrl: buildPrep.sourceTarUrl,
      sourceTarDigest: buildPrep.sourceTarDigest,
      depsUrl: buildPrep.depsUrl,
      depsHash: buildPrep.depsHash,
      excludeLabels,
      ...((genJob as { resources?: import('@kici-dev/engine').ResourceRequest }).resources
        ? {
            resources: (genJob as { resources?: import('@kici-dev/engine').ResourceRequest })
              .resources,
          }
        : {}),
    }),
  );
  if (!(deps.coordinator && deps.coordinator.hasConnectedPeers())) {
    await directDispatchGeneratedJobs({
      ctx,
      setup,
      buildPrep,
      configs: unpinnedConfigs,
    });
    return;
  }
  const genCloneTokens = await mintRerouteCloneTokens(ctx);
  const genRunCtx: RunContext = {
    runId,
    deliveryId: setup.effectiveDeliveryId,
    routingKey: setup.info.routingKey,
    event: setup.info.event,
    action: setup.info.action,
    provider: setup.info.provider,
    payload: setup.info.payload,
    repoIdentifier,
    installationId: credentials?.installationId as number | undefined,
    workflowName: workflow.name,
    requestId: getRequestContext().requestId,
    sha: ref,
    ref: event.sourceBranch ?? event.targetBranch,
    ...genCloneTokens,
  };
  let genRouteTimeout: ReturnType<typeof setTimeout> | undefined;
  const routeResult = await Promise.race([
    deps.coordinator.routeJobs(genRunCtx, generatedJobsToRoute),
    new Promise<never>((_, reject) => {
      genRouteTimeout = setTimeout(
        () => reject(new Error('routeJobs timed out after 60s')),
        60_000,
      );
    }),
  ]).catch((err) => {
    logger.warn('Generated job coordinator routing timed out, falling back to direct dispatch', {
      runId,
      workflow: workflow.name,
      error: toErrorMessage(err),
      jobCount: generatedJobsToRoute.length,
    });
    return null;
  });
  clearTimeout(genRouteTimeout);
  if (!routeResult) {
    await directDispatchGeneratedJobs({
      ctx,
      setup,
      buildPrep,
      configs: unpinnedConfigs,
    });
    return;
  }
  for (const local of routeResult.localJobs) {
    if (deps.executionTracker) {
      const matchingConfig = unpinnedConfigs.find((c) => c.genJob.name === local.jobName);
      deps.executionTracker
        .addJobsToRun(
          runId,
          jobsOfWorkflow(ctx.workflow.name, [
            {
              jobId: local.jobId,
              jobName: local.jobName,
              runsOnLabels: matchingConfig?.runsOnLabels ?? [],
              ...(matchingConfig?.matrixValues && { matrixValues: matchingConfig.matrixValues }),
              ...(matchingConfig?.gitCredentials && {
                gitCredentials: matchingConfig.gitCredentials,
              }),
            },
          ]),
        )
        .catch((err) => {
          logger.error('Failed to add generated job to execution tracker', {
            runId,
            job: local.jobName,
            error: toErrorMessage(err),
          });
        });
    }
  }
  for (const rerouted of routeResult.reroutedJobs) {
    logger.info('Generated job rerouted to peer', {
      runId,
      job: rerouted.jobName,
      peerId: rerouted.peerId,
    });
  }
  for (const failed of routeResult.failedJobs) {
    logger.error(
      `Generated job '${failed.jobName}' routing failed: ${failed.reason}. ` +
        `This indicates a capability advertisement mismatch — the peer was selected ` +
        `based on advertised labels but rejected the job.`,
      {
        runId,
        workflow: workflow.name,
        job: failed.jobName,
        reason: failed.reason,
      },
    );
  }
  logger.info('Generated jobs routed via coordinator', {
    runId,
    workflow: workflow.name,
    local: routeResult.localJobs.length,
    rerouted: routeResult.reroutedJobs.length,
    failed: routeResult.failedJobs.length,
  });
}

async function setGroupNameAndResolveEdges(args: {
  ctx: WorkflowDispatchContext;
  staticJobs: readonly LockJob[];
  groupName: string | undefined;
  generatedJobNames: string[];
}): Promise<void> {
  const { ctx, staticJobs, groupName, generatedJobNames } = args;
  const { deps, runId } = ctx;
  if (!deps.db || !groupName) return;
  for (const memberName of generatedJobNames) {
    await deps.db
      .updateTable('execution_jobs')
      .set({ group_name: groupName })
      .where('run_id', '=', runId)
      .where('job_name', '=', memberName)
      .execute()
      .catch((err) => {
        logger.warn('Failed to set group_name on generated job', {
          runId,
          jobName: memberName,
          groupName,
          error: toErrorMessage(err),
        });
      });
  }
  const dependentStaticJobs = staticJobs
    .filter(
      (j) => j._type === 'static' && j.dependsOnGroups && j.dependsOnGroups.includes(groupName),
    )
    .map((j) => {
      const groupEntry = j.needs.find(
        (n): n is NeedsGroupEntry => typeof n === 'object' && 'group' in n && n.group === groupName,
      );
      return {
        jobName: j.name,
        runOn: groupEntry?.runOn ?? [ExecutionJobStatus.enum.success],
      };
    });
  if (dependentStaticJobs.length > 0) {
    await resolveGroupEdges(deps.db, runId, groupName, generatedJobNames, dependentStaticJobs);
    logger.info('Group edges resolved', {
      runId,
      groupName,
      members: generatedJobNames.length,
      dependents: dependentStaticJobs.length,
    });
  }
}

async function insertGeneratedNeedsEdges(
  db: Kysely<Database>,
  runId: string,
  generatedJobs: LockJob[],
): Promise<void> {
  const genEdgeRows: Array<{
    run_id: string;
    job_name: string;
    upstream_name: string;
    run_on: string;
  }> = [];
  for (const genJob of generatedJobs) {
    for (const need of genJob.needs) {
      if (typeof need === 'string') {
        genEdgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: need,
          run_on: SUCCESS_ONLY_RUN_ON_JSON,
        });
      } else if (typeof need === 'object' && 'name' in need && !('group' in need)) {
        genEdgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: (need as { name: string }).name,
          run_on: needsRunOnJson(need as { runOn?: ExecutionJobStatus[] }),
        });
      }
    }
  }
  if (genEdgeRows.length > 0) {
    await db
      .insertInto('execution_job_needs')
      .values(genEdgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** Topologically sort the resolved graph; fail every cycle participant and signal abort. */
async function detectAndFailCycles(args: {
  ctx: WorkflowDispatchContext;
}): Promise<{ cycle: boolean }> {
  const { ctx } = args;
  const { deps, runId } = ctx;
  if (!deps.db) return { cycle: false };
  const allEdges = await deps.db
    .selectFrom('execution_job_needs')
    .select(['job_name', 'upstream_name'])
    .where('run_id', '=', runId)
    .execute();
  const allJobRows = await deps.db
    .selectFrom('execution_jobs')
    .select('job_name')
    .where('run_id', '=', runId)
    .execute();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const { job_name } of allJobRows) {
    inDegree.set(job_name, 0);
    adjacency.set(job_name, []);
  }
  for (const { job_name, upstream_name } of allEdges) {
    adjacency.get(upstream_name)?.push(job_name);
    inDegree.set(job_name, (inDegree.get(job_name) ?? 0) + 1);
  }
  const topoQueue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  let visited = 0;
  while (topoQueue.length > 0) {
    const node = topoQueue.shift()!;
    visited++;
    for (const downstream of adjacency.get(node) ?? []) {
      const newDegree = (inDegree.get(downstream) ?? 1) - 1;
      inDegree.set(downstream, newDegree);
      if (newDegree === 0) topoQueue.push(downstream);
    }
  }
  if (visited >= allJobRows.length) return { cycle: false };
  const cycleJobs = [...inDegree.entries()].filter(([, d]) => d > 0).map(([n]) => n);
  const cycleTrace = cycleJobs.join(' -> ');
  logger.error('Eval-time cycle detected in job graph', { runId, cycleTrace });
  if (deps.executionTracker) {
    for (const cycleJobName of cycleJobs) {
      const cycleJobRow = await deps.db
        .selectFrom('execution_jobs')
        .select('job_id')
        .where('run_id', '=', runId)
        .where('job_name', '=', cycleJobName)
        .executeTakeFirst();
      if (cycleJobRow) {
        await deps.executionTracker.onJobStatus(
          runId,
          cycleJobRow.job_id,
          ExecutionJobStatus.enum.failed,
          Date.now(),
          undefined,
          { error: `cycle detected: ${cycleTrace}` },
        );
      }
    }
  }
  return { cycle: true };
}

async function recomputeAndDispatchReady(args: {
  ctx: WorkflowDispatchContext;
  staticJobs: readonly LockJob[];
  groupName: string | undefined;
  memberJobNames: string[];
}): Promise<void> {
  const { ctx, staticJobs, groupName, memberJobNames } = args;
  if (!ctx.deps.db) return;
  const affectedJobNames = [
    ...memberJobNames,
    ...staticJobs
      .filter((j) => j.dependsOnGroups && groupName && j.dependsOnGroups.includes(groupName))
      .map((j) => j.name),
  ];
  if (affectedJobNames.length === 0) return;
  await recomputeAndApplyReady(ctx, affectedJobNames);
}

/**
 * Recompute the needs gate for `jobNames`: open satisfied jobs, terminalize
 * excluded ones. The conditional `needs_satisfied = false → true` claim means
 * a job a concurrent `evaluateDownstreams` claimed is never dispatched twice.
 */
export async function recomputeAndApplyReady(
  ctx: NeedsSchedulingContext,
  jobNames: readonly string[],
): Promise<void> {
  const { deps, runId } = ctx;
  if (!deps.db || jobNames.length === 0) return;
  const schedulerResults = await recomputeNeedsSatisfied(deps.db, runId, [...jobNames]);
  for (const result of schedulerResults) {
    if (result.action === 'dispatch' && deps.executionTracker?.onJobReadyCallback) {
      await deps.executionTracker.onJobReadyCallback(runId, result.jobName);
    } else if (result.action === 'skip' && deps.executionTracker && deps.db) {
      const skipJobRow = await deps.db
        .selectFrom('execution_jobs')
        .select('job_id')
        .where('run_id', '=', runId)
        .where('job_name', '=', result.jobName)
        .executeTakeFirst();
      if (skipJobRow) {
        await deps.executionTracker.onJobStatus(
          runId,
          skipJobRow.job_id,
          ExecutionJobStatus.enum.skipped,
          Date.now(),
          undefined,
          { error: result.reason },
        );
      }
    }
  }
}

/** Split a result-aware generator's declared needs into job names and group names. */
function splitDeclaredNeeds(needs: BuildPrepResult['dynamicEntries'][number]['needs']): {
  jobNames: string[];
  groupNames: string[];
} {
  const jobNames: string[] = [];
  const groupNames: string[] = [];
  for (const need of needs ?? []) {
    if (typeof need === 'string') {
      jobNames.push(need);
    } else if ('group' in need) {
      groupNames.push((need as NeedsGroupEntry).group);
    } else if ('name' in need) {
      jobNames.push((need as NeedsEntry).name);
    }
  }
  return { jobNames, groupNames };
}

/**
 * Register a result-aware eval as a needs-gated job (synthetic pending row plus
 * edges) so the scheduler gates it like any job. Group needs expand to members,
 * which carry group_name from setGroupNameAndResolveEdges.
 */
async function registerDeferredEvalJob(args: {
  ctx: WorkflowDispatchContext;
  evalJobName: string;
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
}): Promise<void> {
  const { ctx, evalJobName, dynamicEntry } = args;
  const { deps, runId } = ctx;
  if (!deps.db) return;
  const { jobNames, groupNames } = splitDeclaredNeeds(dynamicEntry.needs);

  const groupMembers: string[] = [];
  for (const groupName of groupNames) {
    const members = await deps.db
      .selectFrom('execution_jobs')
      .select('job_name')
      .where('run_id', '=', runId)
      .where('group_name', '=', groupName)
      .execute();
    for (const m of members) groupMembers.push(m.job_name);
  }

  const upstreamNames = [...new Set([...jobNames, ...groupMembers])];
  const runOnByName = new Map<string, string>();
  for (const need of dynamicEntry.needs ?? []) {
    if (typeof need === 'object' && 'name' in need) {
      runOnByName.set((need as NeedsEntry).name, needsRunOnJson(need as NeedsEntry));
    }
  }
  const groupRunOn = new Map<string, string>();
  for (const need of dynamicEntry.needs ?? []) {
    if (typeof need === 'object' && 'group' in need) {
      groupRunOn.set((need as NeedsGroupEntry).group, needsRunOnJson(need as NeedsGroupEntry));
    }
  }

  // Gated by the scheduler and awaited by run-complete; replaced by the real
  // eval id when the gate opens.
  const syntheticId = `dynamic-eval-pending-${evalJobName}-${randomUUID()}`;
  if (deps.executionTracker) {
    await deps.executionTracker.addJobsToRun(
      runId,
      jobsOfWorkflow(ctx.workflow.name, [
        { jobId: syntheticId, jobName: evalJobName, runsOnLabels: [] },
      ]),
    );
  }

  const edgeRows = upstreamNames.map((upstreamName) => ({
    run_id: runId,
    job_name: evalJobName,
    upstream_name: upstreamName,
    run_on:
      runOnByName.get(upstreamName) ??
      // group member inherits its group's run-on set
      [...groupRunOn.values()][0] ??
      SUCCESS_ONLY_RUN_ON_JSON,
  }));
  if (edgeRows.length > 0) {
    await deps.db
      .insertInto('execution_job_needs')
      .values(edgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  logger.info('Registered deferred result-aware eval job', {
    runId,
    evalJob: evalJobName,
    upstreams: upstreamNames,
  });

  // Race guard: an upstream may have gone terminal before these edges existed,
  // so no future completion fires the gate. Recompute now.
  const results = await recomputeNeedsSatisfied(deps.db, runId, [evalJobName]);
  for (const result of results) {
    if (result.action === 'dispatch' && deps.executionTracker?.onJobReadyCallback) {
      await deps.executionTracker.onJobReadyCallback(runId, evalJobName);
    } else if (result.action === 'skip') {
      // Upstream status outside run_on: open the gate anyway so the task
      // proceeds with an empty snapshot (a wider `when` set decides meaning).
      if (deps.executionTracker?.onJobReadyCallback) {
        await deps.executionTracker.onJobReadyCallback(runId, evalJobName);
      }
    }
  }
}

// Lives in `orchestrator-core.ts` (no reverse import cycle); re-exported for
// consumers that import it from here.
export { gatherInvokeResults };

/**
 * Frozen upstream snapshot for a result-aware eval: stored outputs (as backing
 * jobRef.result), group → ordered members, and invoke results. Captured once at
 * eval dispatch and replayed unchanged on agent re-eval.
 */
async function gatherUpstreamSnapshot(args: {
  ctx: WorkflowDispatchContext;
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
}): Promise<UpstreamSnapshot> {
  const { ctx, dynamicEntry } = args;
  const { deps, runId } = ctx;
  const snapshot: UpstreamSnapshot = { jobs: {}, groups: {}, statuses: {} };
  if (!deps.db) return snapshot;
  const { jobNames, groupNames } = splitDeclaredNeeds(dynamicEntry.needs);

  // A need naming an invoke gate resolves to one result per proxy child
  // (`ctx.needs['<gate>'].result`).
  const invokeResults = await gatherInvokeResults(deps.db, runId, jobNames);
  if (Object.keys(invokeResults).length > 0) snapshot.invokeResults = invokeResults;

  // Group members in a deterministic order (group eval order ≈ ready_at, then name).
  const groupMembers: string[] = [];
  for (const groupName of groupNames) {
    const members = await deps.db
      .selectFrom('execution_jobs')
      .select(['job_name', 'ready_at'])
      .where('run_id', '=', runId)
      .where('group_name', '=', groupName)
      .orderBy('ready_at', 'asc')
      .orderBy('job_name', 'asc')
      .execute();
    const memberNames = members.map((m) => m.job_name);
    snapshot.groups[groupName] = memberNames;
    for (const n of memberNames) groupMembers.push(n);
  }

  const allJobNames = [...new Set([...jobNames, ...groupMembers])];
  if (allJobNames.length > 0) {
    const rows = await deps.db
      .selectFrom('execution_jobs')
      .select(['job_name', 'outputs', 'status'])
      .where('run_id', '=', runId)
      .where('job_name', 'in', allJobNames)
      .execute();
    for (const row of rows) {
      // JSONB, parsed or string; an empty or unparseable cell yields no outputs.
      const parsed = parseOutputsCell(row.outputs);
      if (parsed) snapshot.jobs[row.job_name] = parsed;
      if (row.status && snapshot.statuses) {
        snapshot.statuses[row.job_name] = row.status as ExecutionJobStatus;
      }
    }
  }
  return snapshot;
}

async function processDynamicEntry(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  secrets: SecretBundle;
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
}): Promise<void> {
  const { ctx, setup, buildPrep, secrets, dynamicEntry } = args;
  const { deps, workflow, fullLockFile, runId } = ctx;
  if (!deps.pendingDynamics) return;
  const evalJobName = `__dynamic__${workflow.name}__${dynamicEntry.source.index}`;
  try {
    // Result-aware: wait for the scheduler to open the eval's gate, then
    // snapshot the terminal upstreams.
    let upstreamSnapshot: UpstreamSnapshot | undefined;
    if (dynamicEntry.resultAware) {
      // Gate promise BEFORE edges: the race guard may fire onJobReadyCallback
      // synchronously.
      const gateOpened = trackEvalGate(runId, evalJobName);
      await registerDeferredEvalJob({ ctx, evalJobName, dynamicEntry });
      await gateOpened;
      upstreamSnapshot = await gatherUpstreamSnapshot({ ctx, dynamicEntry });
      logger.info('Result-aware eval gate opened, dispatching eval with snapshot', {
        runId,
        workflow: workflow.name,
        evalJob: evalJobName,
        snapshotJobs: Object.keys(upstreamSnapshot.jobs).length,
        snapshotGroups: Object.keys(upstreamSnapshot.groups).length,
      });
    }
    const { evalJobId, replaceSyntheticId, runsOnLabels } = await dispatchEvalJob({
      ctx,
      setup,
      buildPrep,
      dynamicEntry,
      upstreamSnapshot,
    });
    // Track BEFORE any further await, or a fast eval-complete reply is missed.
    const generatedJobsPromise = deps.pendingDynamics.track(evalJobId);
    // replaceSyntheticId is set only for a result-aware eval.
    if (deps.executionTracker) {
      await deps.executionTracker.addJobsToRun(
        runId,
        jobsOfWorkflow(ctx.workflow.name, [
          { jobId: evalJobId, jobName: evalJobName, runsOnLabels },
        ]),
        undefined,
        replaceSyntheticId,
      );
    }
    const generatedJobs = await generatedJobsPromise;
    logger.info('Dynamic eval completed, dispatching generated jobs', {
      runId,
      workflow: workflow.name,
      generatedCount: generatedJobs.length,
      jobNames: generatedJobs.map((j) => j.name),
    });

    const generated = await resolveGeneratedJobConfigs({
      ctx,
      workflow,
      fullLockFile,
      runPublicKeyBase64: secrets.runPublicKeyBase64,
      npmRegistries: secrets.npmRegistries,
      installEnvSecrets: secrets.installEnvSecrets,
      generatedJobs,
      dynamicEntry,
      upstreamSnapshot,
    });
    const rootGeneratedConfigs = generated.dispatchable.filter((c) => isRootJob(c.genJob));
    const gatedGeneratedConfigs = generated.dispatchable.filter((c) => !isRootJob(c.genJob));

    await holdGeneratedJobs({ ctx, setup, buildPrep, held: generated.held });
    await gateAndStoreNonRootGeneratedJobs({
      ctx,
      setup,
      buildPrep,
      gatedGeneratedConfigs,
    });
    await routeRootGeneratedJobs({ ctx, setup, buildPrep, rootGeneratedConfigs });

    if (!deps.db) return;
    await setGroupNameAndResolveEdges({
      ctx,
      staticJobs: buildPrep.staticJobs,
      groupName: dynamicEntry.group,
      generatedJobNames: generatedJobs.map((j) => j.name),
    });
    await insertGeneratedNeedsEdges(deps.db, runId, generatedJobs);
    const cycleCheck = await detectAndFailCycles({ ctx });
    if (cycleCheck.cycle) return;
    await recomputeAndDispatchReady({
      ctx,
      staticJobs: buildPrep.staticJobs,
      groupName: dynamicEntry.group,
      memberJobNames: generatedJobs.map((j) => j.name),
    });
  } catch (err) {
    const errMsg = toErrorMessage(err);
    logger.error('Dynamic eval job failed', {
      runId,
      workflow: workflow.name,
      sourceIndex: dynamicEntry.source.index,
      error: errMsg,
    });
    if (deps.executionTracker) {
      const carried = err instanceof AgentJobFailedError ? err.initFailure : undefined;
      const jobName =
        carried?.jobName ?? dynamicEntry.group ?? `__dynamic__${dynamicEntry.source.index}`;
      const jobId = `dynamic-eval-failed-${dynamicEntry.source.index}`;
      await deps.executionTracker
        .addJobsToRun(
          runId,
          jobsOfWorkflow(ctx.workflow.name, [{ jobId, jobName, runsOnLabels: [] }]),
        )
        .catch(() => {});
      await deps.executionTracker
        .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
          error: errMsg,
          initFailure: {
            scope: 'job',
            category: carried?.category ?? InitFailureCategory.enum.dynamic_eval,
            message: errMsg,
            jobName,
          },
        })
        .catch(() => {});
    }
  }
}

function startDeferredDynamicDispatch(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  secrets: SecretBundle;
}): void {
  const { ctx, setup, buildPrep, secrets } = args;
  const { deps } = ctx;
  if (buildPrep.dynamicEntries.length === 0 || !deps.pendingDynamics) return;
  const { executionTracker } = deps;
  for (const dynamicEntry of buildPrep.dynamicEntries) {
    // Own token, taken synchronously (see `startDeferredInitDispatch`).
    const held = executionTracker?.holdRunForPendingJobs(ctx.runId) ?? false;
    const spawned = processDynamicEntry({ ctx, setup, buildPrep, secrets, dynamicEntry });
    // `.finally()` on the promise, not a try/finally inside processDynamicEntry
    // (it returns early above its own try); after the catch, so
    // `dynamic-eval-failed-*` lands while held.
    if (!held) {
      logger.warn('Dynamic entry dispatched without a pending-jobs token', {
        runId: ctx.runId,
        workflow: ctx.workflow.name,
      });
    }
    void spawned
      .catch((err: unknown) => {
        logger.error('Deferred dynamic dispatch task failed', {
          runId: ctx.runId,
          error: toErrorMessage(err),
        });
      })
      .finally(() => {
        if (!held) return;
        executionTracker?.releasePendingJobsHold(ctx.runId).catch((err: unknown) => {
          logger.error('Failed to release pending-jobs hold', {
            runId: ctx.runId,
            error: toErrorMessage(err),
          });
        });
      });
  }
}

/**
 * When ALL jobs are deferred, create the run row BEFORE dispatching them, or a
 * fast completion inserts execution_jobs against a missing run (FK violation).
 */
async function ensureExecutionRunForDeferred(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  declaredContexts: readonly string[];
  dispatchedJobs: DispatchedJob[];
  deferredInitCount: number;
  reason: 'init' | 'dynamic';
  /** See `recordRunStart`. */
  runTrackedEarly: boolean;
  runContextName: string | undefined;
  runContextId: string | undefined;
}): Promise<void> {
  const {
    ctx,
    setup,
    declaredContexts,
    dispatchedJobs,
    deferredInitCount,
    reason,
    runTrackedEarly,
  } = args;
  const { deps } = ctx;
  // Only when unregistered: a second `onExecutionStarted` resets the job map.
  if (!deps.executionTracker || runTrackedEarly) return;
  if (dispatchedJobs.length !== 0) return;
  if (reason === 'dynamic' && deferredInitCount > 0) return;
  await startTrackedRun(deps.executionTracker, ctx, setup, [], { declaredContexts });
  stampRunStartColumns(ctx, args.runContextName, args.runContextId);
}

/**
 * Complete the posted check runs for a dispatch that ends with no job. The
 * exit rows (`recordInitFailureRun`, `onBuildFailed`) fire only
 * `onExecutionStatusChange`, never `onExecutionComplete` (the one wired to
 * `updateWorkflowStatus`), so the checks would stay `queued` and block branch
 * protection.
 *
 * Names match `setupDispatchContext`'s `setPendingAwait` field for field.
 * Never throws: a provider error must not turn a recorded failure into a
 * dispatch error. `setup` is optional for the top-level catch; the `ctx`
 * fallback reproduces its provider and routing-key overlay exactly.
 */
async function completeChecksForUndispatchedRun(args: {
  ctx: WorkflowDispatchContext;
  setup?: DispatchSetup;
  conclusion: CheckRunConclusion;
  summary: string;
}): Promise<void> {
  const { ctx, setup, conclusion, summary } = args;
  const { deps, workflow, repoIdentifier, credentials, ref, runId } = ctx;
  if (!deps.checkRunReporter) return;
  const [owner, repo] = repoIdentifier.split('/');
  if (!owner || !repo) return;
  try {
    await deps.checkRunReporter.completeUndispatchedCheckRuns({
      provider: setup?.info.provider ?? ctx.effectiveProvider ?? ctx.info.provider,
      routingKey: setup?.info.routingKey ?? ctx.effectiveRoutingKey ?? ctx.info.routingKey,
      owner,
      repo,
      sha: ref,
      workflowName: workflow.name,
      ...(ctx.global && { workflowRepoIdentifier: ctx.global.workflowRepoIdentifier }),
      jobNames: workflow.jobs.filter(isLockStaticJob).map((j) => j.name),
      installationId: (credentials as { installationId?: number }).installationId,
      runId,
      conclusion,
      summary,
    });
  } catch (err) {
    logger.warn('Failed to complete check runs for an undispatched run', {
      runId,
      error: toErrorMessage(err),
    });
  }
}

/**
 * Persist a failed run row for a pre-dispatch init-failure exit, so the Runs
 * view shows it instead of no trace, and complete the stranded checks. The row
 * is skipped without an `executionTracker`.
 */
async function recordInitFailureFromSkip(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  category: InitFailureCategory;
  reason: string;
}): Promise<void> {
  const { ctx, setup, category, reason } = args;
  const { deps, workflow, repoIdentifier, workflowRepoIdentifier, credentials, event, ref, runId } =
    ctx;
  await deps.executionTracker?.recordInitFailureRun({
    runId,
    workflowName: workflow.name,
    provider: setup.info.provider,
    repoIdentifier,
    workflowRepoIdentifier,
    // The branch the run PRESENTS (as `onExecutionStarted` writes, and the
    // context branch gate evaluates), not `sourceBranch`: a fork names its PR
    // head freely, and internal-event branch inheritance reads this row as a
    // branch claim.
    ref: event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    providerContext: (credentials ?? {}) as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    initFailure: {
      scope: 'run',
      category,
      message: reason,
    },
    triggerEvent: dispatchTriggerEvent(ctx),
    commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
    ...preDispatchRunProvenance(ctx),
    ...(ctx.testRun && { testRun: ctx.testRun }),
  });

  // Not tracker-guarded: checks come from another dependency.
  await completeChecksForUndispatchedRun({
    ctx,
    setup,
    conclusion: CheckRunConclusion.enum.failure,
    summary: `This run failed before any job started (${category}). ${reason}`,
  });
}

/**
 * Fail the run on an invalid approval `timeoutSeconds` before any dispatch, so
 * it never reaches the hold builders (past `expires_at`, `new Date(Infinity)`).
 * True when it recorded `approval_misconfig`; the caller must short-circuit.
 */
async function recordApprovalMisconfigIfInvalid(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
): Promise<boolean> {
  const invalid = findInvalidApprovalTimeout(ctx.workflow);
  if (!invalid) return false;
  const where = invalid.scope === 'job' ? `job '${invalid.jobName}'` : 'workflow';
  await recordInitFailureFromSkip({
    ctx,
    setup,
    category: InitFailureCategory.enum.approval_misconfig,
    reason: `approval timeout for ${where} must be a positive integer number of seconds, got ${invalid.value}`,
  });
  return true;
}

/**
 * Pause at the install gate: a `held` run row (reused on resume), the
 * workflow-scoped held_runs row, and the pending workflow context the release
 * rebuilds from. No jobs are queued.
 */
async function holdWorkflowForInstallGate(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  hold: InstallGateHold;
  reuseRunId: string | undefined;
}): Promise<void> {
  const { ctx, setup, hold } = args;
  const { deps, workflow, repoIdentifier, workflowRepoIdentifier, credentials, event, ref, runId } =
    ctx;

  if (deps.executionTracker) {
    await deps.executionTracker.recordRunHeld({
      runId,
      workflowName: workflow.name,
      provider: setup.info.provider,
      repoIdentifier,
      workflowRepoIdentifier,
      // The presented branch, never `sourceBranch` (see `recordInitFailureFromSkip`).
      ref: event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      providerContext: (credentials ?? {}) as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      contextName: hold.envName,
      reason: hold.requirement.reason,
      triggerEvent: dispatchTriggerEvent(ctx),
      commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
      workflowSha: ctx.global?.workflowSha ?? null,
      workflowBranch: ctx.global?.workflowBranch ?? null,
      ...preDispatchRunProvenance(ctx),
      ...(ctx.testRun && { testRun: ctx.testRun }),
    });
  }

  if (deps.heldRunStore) {
    await deps.heldRunStore.createHold(ctx.resolvedOrgId, {
      runId,
      jobId: installGateJobId(workflow.name),
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.context,
      contextId: hold.contextId,
      queueType: hold.queueType,
      holdType: hold.holdType,
      requirement: hold.requirement,
    });
  }

  // The release reads the record to know which contexts the approval covers.
  await storePendingWorkflowContext(
    deps.db,
    toSerializableInputs({ ...ctx, installGateRecord: hold.record }),
  );
}

/**
 * How long the hold stays approvable. The window rides on the decision from
 * the same policy read (no second read, no TOCTOU); default when absent.
 */
function securityHoldExpiryMs(decision: Extract<TrustPolicyOutcome, { action: 'hold' }>): number {
  const seconds = decision.approvalExpirySeconds ?? DEFAULT_APPROVAL_EXPIRY_SECONDS;
  return seconds * 1_000;
}

/**
 * The `held_runs` row the org trust policy's PR-wide hold writes for `runId`.
 *
 * Shared by the per-workflow hold below and the held pre-run evaluation round,
 * so both land in the same queue and release through the same route.
 */
export function buildSecurityHoldData(
  runId: string,
  decision: Extract<TrustPolicyOutcome, { action: 'hold' }>,
) {
  return {
    runId,
    jobId: SECURITY_HOLD_JOB_IDS[decision.reason],
    contextId: null,
    holdType: HoldType.enum.security,
    queueType: 'security' as const,
    reason: decision.reason,
    expiresAt: new Date(Date.now() + securityHoldExpiryMs(decision)),
    // The pair `routeRelease` discriminates on. Workflow scope because the
    // hold owns the whole dispatch, not one job; `context` because the org
    // trust policy raised it, not an SDK `requireApproval`.
    scope: HoldScope.enum.workflow,
    triggerSource: TriggerSource.enum.context,
  };
}

/**
 * Hold a run in the security queue per the org trust policy; the reason comes
 * from the gate, so one helper covers every arm.
 *
 * Like the install-gate hold, no job exists yet, so the whole dispatch is
 * stored and replayed: `/kici approve` → `resumeWorkflow` re-runs it with
 * `reuseRunId`, `applyTrustPolicyGate` short-circuits, and the run continues
 * with this dispatch's `trustResolution`. `/kici reject` cancels and drops the
 * context; stale-detector expiry fails it.
 *
 * The row carries the PR number: the `/kici approve|reject` comment path joins
 * on `pr_number`, and a NULL leaves the hold fail-closed unreachable.
 */
async function holdRunForSecurityPolicy(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  decision: Extract<TrustPolicyOutcome, { action: 'hold' }>;
}): Promise<void> {
  const { ctx, setup, decision } = args;
  const {
    deps,
    workflow,
    repoIdentifier,
    workflowRepoIdentifier,
    credentials,
    event,
    ref,
    runId,
    trustResolution,
  } = ctx;

  if (deps.executionTracker) {
    await deps.executionTracker.recordRunHeld({
      runId,
      workflowName: workflow.name,
      provider: setup.info.provider,
      repoIdentifier,
      workflowRepoIdentifier,
      // The presented branch, never `sourceBranch` (see `recordInitFailureFromSkip`).
      ref: event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      providerContext: (credentials ?? {}) as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      reason: decision.reason,
      triggerEvent: dispatchTriggerEvent(ctx),
      commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
      prNumber: event.prNumber ?? null,
      workflowSha: ctx.global?.workflowSha ?? null,
      workflowBranch: ctx.global?.workflowBranch ?? null,
      ...preDispatchRunProvenance(ctx),
      ...(ctx.testRun && { testRun: ctx.testRun }),
    });
  }

  let heldRow: HeldRun | undefined;
  if (deps.heldRunStore) {
    const holdData = buildSecurityHoldData(runId, decision);
    // Row and context TOGETHER, as in `holdJobForApproval`: a row without its
    // context is unreleasable and reaches `failRunResumeLost`, which cannot
    // complete the queued `kici/…` checks.
    //
    // Inside the store guard: without a row, nothing could reference or clean
    // up the context.
    const writeHoldAndContext = async (exec?: Transaction<Database>): Promise<HeldRun> => {
      const row = await deps.heldRunStore!.create(ctx.resolvedOrgId, holdData, exec);
      await storePendingWorkflowContext(exec ?? deps.db, toSerializableInputs(ctx));
      return row;
    };
    // A local `kici run` has no database; the context is in memory only.
    heldRow = deps.db
      ? await deps.db.transaction().execute(writeHoldAndContext)
      : await writeHoldAndContext();
  }

  // Store-gated too: a post with no `held_runs` row is a check nothing settles.
  if (deps.heldRunStore && heldRow && ctx.bundle?.checkStatusPoster) {
    // The replay reuses this run id and skips re-resolving trust, so the note's
    // tier is the resumed run's tier.
    const postureNote = buildReducedPrivilegeNote(trustResolution?.tier, ctx.lockFileSource);
    const holdSummary =
      buildSecurityHoldSummary(
        decision.reason,
        trustResolution?.tier,
        trustResolution?.contributorUsername,
      ) + (postureNote ? `\n\n${postureNote}` : '');
    await postPendingHoldCheck({
      poster: ctx.bundle.checkStatusPoster,
      store: deps.heldRunStore,
      orgId: ctx.resolvedOrgId,
      heldRunIds: [heldRow.id],
      repoIdentifier,
      sha: ref,
      summary: holdSummary,
      credentials,
      logContext: { runId, reason: decision.reason },
      postFailureMessage: 'Failed to post security-policy hold check',
    });
  }
}

/** What an ignored dispatch returns: nothing dispatched, nothing held. */
function ignoredDispatchResult(): DispatchMatchedWorkflowResult {
  return { dispatchedJobCount: 0, dispatchedJobIds: [], held: false };
}

/**
 * Answer `ignore` before setup, which posts queued checks nothing would
 * complete (a branch-protection blocker). Other verdicts wait for
 * `applyTrustPolicyGate` after setup: they need the setup bag, and deciding
 * earlier would reorder the approval-misconfig check. Null to continue.
 */
function declineIgnoredDispatch(
  ctx: WorkflowDispatchContext,
  opts: DispatchMatchedWorkflowOptions,
): DispatchMatchedWorkflowResult | null {
  // A resume re-entry must not act on the verdict twice.
  if (opts.reuseRunId) return null;
  if (ctx.securityDecision.action !== 'ignore') return null;
  return ignoredDispatchResult();
}

/**
 * PR-wide trust-policy gate: run, hold, or reject a non-trusted contributor's
 * PR. Runs before any dispatch and short-circuits the context gate, so no two
 * competing holds. Skipped on resume. Null to continue.
 */
async function applyTrustPolicyGate(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
  opts: { reuseRunId?: string | false },
): Promise<DispatchMatchedWorkflowResult | null> {
  // A resume re-entry must not act twice.
  if (opts.reuseRunId) return null;

  const decision = ctx.securityDecision;
  switch (decision.action) {
    case 'pass':
      return null;
    case 'ignore':
      // Redundant with `declineIgnoredDispatch`, but keeps the switch total:
      // `default` would reject, writing the visible failed run `ignore` withholds.
      return ignoredDispatchResult();
    case 'hold':
      await holdRunForSecurityPolicy({ ctx, setup, decision });
      return { dispatchedJobCount: 0, dispatchedJobIds: [], held: true };
    case 'reject':
      await rejectRunForSecurityPolicy({ ctx, setup, decision });
      return { dispatchedJobCount: 0, dispatchedJobIds: [] };
    default: {
      // An unrecognised action denies; falling through dispatches untrusted
      // code. Unreachable today: `evaluateTrustPolicy` returns only `pass` /
      // `hold` / `ignore` and turns an unknown `forkPolicy` into `hold`. Stricter
      // than the evaluator's hold because the run is about to start.
      const unrecognised = decision as { action: string; reason?: TrustPolicyHoldReason };
      await rejectRunForSecurityPolicy({
        ctx,
        setup,
        decision: {
          action: 'reject',
          reason: unrecognised.reason ?? SecurityHoldReason.enum.fork_pr,
          message: `Unrecognised trust-policy verdict "${String(unrecognised.action)}"`,
        },
      });
      return { dispatchedJobCount: 0, dispatchedJobIds: [] };
    }
  }
}

/**
 * Fail a run the trust policy rejected, before any job starts: a run-scoped
 * init failure (visible in the run list and audit trail), a failure via the
 * hold path's check poster (so hold→reject updates the check in place), and
 * completion of the queued checks.
 *
 * Unreachable through today's producers (see `applyTrustPolicyGate`'s
 * `default` arm); kept whole so a verdict that arrives is denied completely.
 */
async function rejectRunForSecurityPolicy(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  decision: Extract<TrustPolicyOutcome, { action: 'reject' }>;
}): Promise<void> {
  const { ctx, setup, decision } = args;
  const {
    deps,
    workflow,
    repoIdentifier,
    workflowRepoIdentifier,
    credentials,
    event,
    ref,
    runId,
    trustResolution,
  } = ctx;

  const rejectionSummary = buildSecurityRejectionSummary(
    decision.reason,
    decision.message,
    trustResolution?.tier,
    trustResolution?.contributorUsername,
  );

  await deps.executionTracker?.recordInitFailureRun({
    runId,
    workflowName: workflow.name,
    provider: setup.info.provider,
    repoIdentifier,
    workflowRepoIdentifier,
    // The branch the run PRESENTS (as `onExecutionStarted` writes, and the
    // context branch gate evaluates), not `sourceBranch`: a fork names its PR
    // head freely, and internal-event branch inheritance reads this row as a
    // branch claim.
    ref: event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    providerContext: (credentials ?? {}) as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    initFailure: {
      // Run-scoped: the policy rejected the whole PR, not one job.
      scope: 'run',
      category: InitFailureCategory.enum.trust_policy,
      message: decision.message,
    },
    triggerEvent: dispatchTriggerEvent(ctx),
    commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
    ...preDispatchRunProvenance(ctx),
  });

  ctx.bundle?.checkStatusPoster
    ?.postCheckStatus(
      repoIdentifier,
      ref,
      'failure',
      'Rejected by trust policy',
      // No reduced-privilege note: a rejected run is never dispatched.
      rejectionSummary,
      credentials,
    )
    .catch((err) => {
      logger.warn('Failed to post trust-policy rejection check', {
        runId,
        reason: decision.reason,
        error: toErrorMessage(err),
      });
    });

  // `KiCI Security` is a separate check, so the queued ones need completing.
  // Same summary: `kici/<workflow>` is often the only check a contributor
  // reads, and its last line names what an org owner must change.
  await completeChecksForUndispatchedRun({
    ctx,
    setup,
    conclusion: CheckRunConclusion.enum.failure,
    summary: rejectionSummary,
  });
}

/**
 * Phases I + J — hand deferred work to fire-and-forget tasks. An all-deferred
 * workflow gets its row from `ensureExecutionRunForDeferred` first; each task
 * takes its own pending-jobs token.
 */
async function startDeferredPhases(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  secrets: SecretBundle;
  evalResult: JobEnvEvalResult;
  dispatchedJobs: DispatchedJob[];
  runTrackedEarly: boolean;
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, secrets, evalResult } = args;
  const { dispatchedJobs, runTrackedEarly } = args;
  if (evalResult.deferredInitJobs.length > 0) {
    await ensureExecutionRunForDeferred({
      ctx,
      setup,
      declaredContexts: secrets.declaredContexts,
      dispatchedJobs,
      deferredInitCount: evalResult.deferredInitJobs.length,
      reason: 'init',
      runTrackedEarly,
      runContextName: evalResult.runContextName,
      runContextId: evalResult.runContextId,
    });
  }
  startDeferredInitDispatch({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobContextData: evalResult.jobContextData,
    deferredInitJobs: evalResult.deferredInitJobs,
  });

  if (buildPrep.dynamicEntries.length === 0 || !ctx.deps.pendingDynamics) return;
  const hasStaticJobs = buildPrep.staticJobs.length > 0;
  logger.info(
    hasStaticJobs
      ? 'Starting deferred dynamic job dispatch'
      : 'Dynamic-only workflow dispatching eval jobs',
    {
      runId: ctx.runId,
      workflow: ctx.workflow.name,
      dynamicEntryCount: buildPrep.dynamicEntries.length,
      hasStaticJobs,
    },
  );
  await ensureExecutionRunForDeferred({
    ctx,
    setup,
    declaredContexts: secrets.declaredContexts,
    dispatchedJobs,
    deferredInitCount: evalResult.deferredInitJobs.length,
    reason: 'dynamic',
    runTrackedEarly,
    runContextName: evalResult.runContextName,
    runContextId: evalResult.runContextId,
  });
  startDeferredDynamicDispatch({ ctx, setup, buildPrep, secrets });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Dispatch a single matched workflow, phase by phase:
 *   A. setup → wrapped dispatcher + overlaid info
 *   B. cache + build → buildPrep with cache URLs and build-job state
 *   C. workflow secrets + ephemeral key → secret bundle
 *   D. per-job env evaluation → job env data + deferred-init queue
 *   E+F+G. static job dispatch → dispatchedJobs / rejectedJobs
 *   H. execution-tracker registration + edges + rejected-mark
 *   I. deferred init dispatch (fire-and-forget per job)
 *   J. deferred dynamic dispatch (fire-and-forget per dynamic entry)
 */
export async function dispatchMatchedWorkflow(
  ctx: WorkflowDispatchContext,
  opts: DispatchMatchedWorkflowOptions = {},
): Promise<DispatchMatchedWorkflowResult> {
  // Reset stale flags from a reused context: this call owes nothing yet.
  ctx.dispatchWindowTokenHeld = false;
  ctx.runRegisteredBeforeDispatch = false;
  ctx.pendingChecksPosted = false;
  try {
    return await dispatchMatchedWorkflowInner(ctx, opts);
  } catch (err) {
    // The row may hold zero jobs, which nothing reaps or cancels (see
    // `startRunBeforeDispatch`); `failRun` terminalizes and evicts it without
    // needing a job.
    if (ctx.runRegisteredBeforeDispatch) {
      try {
        await ctx.deps.executionTracker?.failRun(
          ctx.runId,
          `Workflow dispatch failed: ${toErrorMessage(err)}`,
        );
      } catch (failErr) {
        logger.error('Failed to terminalize a run after a dispatch error', {
          runId: ctx.runId,
          workflow: ctx.workflow.name,
          error: toErrorMessage(failErr),
        });
      }
    }
    // The only place a thrown dispatch closes the queued checks: early exits
    // complete their own, `failRun` touches none. Keyed on the flag, not the
    // throw site (a rolled-back hold transaction is one case of many). `setup`
    // may not exist, hence the `ctx` fallback.
    //
    // Unconditional, even after a resumable hold landed: the resume re-posts
    // the queued checks after this conclusion and wins, whereas a permanently
    // `queued` check never recovers.
    if (ctx.pendingChecksPosted) {
      await completeChecksForUndispatchedRun({
        ctx,
        conclusion: CheckRunConclusion.enum.failure,
        summary: `The workflow could not be dispatched, so no job started. ${toErrorMessage(err)}`,
      });
    }
    // Propagated: an infrastructure fault must fail the delivery.
    throw err;
  } finally {
    // The window token must never outlive this call (a leak wedges the run
    // `running` until the stale detector). It covers jobs registered before
    // return (`recordRunStart`, `needs-pending-*` / `rejected-*` rows); deferred
    // init/dynamic tasks hold their own, taken before this drops.
    //
    // Releasing can finalize the run and throw: swallow-and-log, since a throw
    // from `finally` replaces the result and hides the original failure.
    if (ctx.dispatchWindowTokenHeld) {
      ctx.dispatchWindowTokenHeld = false;
      try {
        await ctx.deps.executionTracker?.releasePendingJobsHold(ctx.runId);
      } catch (err) {
        logger.error('Failed to release pending-jobs hold', {
          runId: ctx.runId,
          error: toErrorMessage(err),
        });
      }
    }
  }
}

/**
 * Resume path: flip the reused row off `held` (`recordRunStart` reuses it).
 * Guarded on `held`, so it is the claim: a re-fired release that loses it must
 * not dispatch again. Returns whether to continue.
 */
async function claimResumedRun(
  ctx: WorkflowDispatchContext,
  opts: DispatchMatchedWorkflowOptions,
): Promise<boolean> {
  if (!opts.reuseRunId || !ctx.deps.executionTracker) return true;
  const claimed = await ctx.deps.executionTracker.resumeHeldRun(opts.reuseRunId);
  // fails-when: two release signals for one held run both dispatch its jobs
  // breaks-if-wrong: the first release of a held run must still dispatch it
  if (!claimed) {
    logger.info('Held run already resumed by another release; not dispatching it again', {
      runId: opts.reuseRunId,
    });
  }
  return claimed;
}

async function dispatchMatchedWorkflowInner(
  ctx: WorkflowDispatchContext,
  opts: DispatchMatchedWorkflowOptions,
): Promise<DispatchMatchedWorkflowResult> {
  const ignored = declineIgnoredDispatch(ctx, opts);
  if (ignored) return ignored;

  const setup = await setupDispatchContext(ctx);
  if (await recordApprovalMisconfigIfInvalid(ctx, setup)) {
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }

  const gated = await applyTrustPolicyGate(ctx, setup, opts);
  if (gated) return gated;

  const buildPrep = await prepareCacheAndBuild(ctx, setup);
  if (buildPrep.abort) {
    // No job will run. `onBuildFailed` reaches no check run, and the build's
    // `kici/<workflow>/setup` check is a different one.
    await completeChecksForUndispatchedRun({
      ctx,
      setup,
      conclusion: CheckRunConclusion.enum.failure,
      summary: 'The workflow build did not complete, so no job started.',
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }
  const secretsResult = await resolveWorkflowSecretsAndKey(ctx);
  if ('skipDispatch' in secretsResult) {
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: InitFailureCategory.enum.secret_resolution,
      reason: secretsResult.reason,
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }
  const secrets = secretsResult;
  const installResult = await resolveWorkflowInstallSecrets(
    ctx,
    secrets,
    opts.skipInstallProtectionGate ?? false,
  );
  if ('held' in installResult && installResult.held) {
    await holdWorkflowForInstallGate({
      ctx,
      setup,
      hold: installResult.hold,
      reuseRunId: opts.reuseRunId,
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [], held: true };
  }
  if ('skipDispatch' in installResult && installResult.skipDispatch) {
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: InitFailureCategory.enum.install_secrets,
      reason: installResult.reason,
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }

  if (!(await claimResumedRun(ctx, opts))) {
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }

  const evalResult = await evaluateJobContexts({ ctx, setup, buildPrep });

  // The single sandbox enforcement point: a denied request fails the whole run
  // loudly before any job is queued; no reader means deny-all.
  const sandboxAllowList: SandboxAllowList = ctx.deps.sandboxAllowListReader
    ? await ctx.deps.sandboxAllowListReader.read(ctx.resolvedOrgId)
    : { capabilities: [], allowHostNetwork: false };
  // A Dockerfile build escapes the sandbox, so an untrusted ref's build is
  // refused here too, never left to the agent; hence `sandbox_denied`.
  const dockerfileResolution = resolveWorkflowDockerfileBuilds(ctx.workflow, {
    scope: deriveCacheRefScope(ctx.trustResolution),
    allowUntrusted: await readAllowUntrustedDockerfileBuilds(ctx),
  });
  if ('denied' in dockerfileResolution) {
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: InitFailureCategory.enum.sandbox_denied,
      reason: dockerfileResolution.denied.reason,
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }

  const sandboxResolution = resolveWorkflowSandboxGrants(ctx.workflow, sandboxAllowList);
  if ('denied' in sandboxResolution) {
    // Before recordRunStart, so a plain failRun would leave no trace.
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: InitFailureCategory.enum.sandbox_denied,
      reason: sandboxResolution.denied.reason,
    });
    return { dispatchedJobCount: 0, dispatchedJobIds: [] };
  }

  const buildJobConfig = makeBuildJobConfig({
    workflow: ctx.workflow,
    fullLockFile: ctx.fullLockFile,
    jobContextData: evalResult.jobContextData,
    runPublicKeyBase64: secrets.runPublicKeyBase64,
    npmRegistries: secrets.npmRegistries,
    installEnvSecrets: secrets.installEnvSecrets,
    event: envelopeEvent(ctx.event, ctx.eventWithFiles),
    eventEnvelopeOverride: ctx.eventEnvelopeOverride,
    cacheOrgId: ctx.resolvedOrgId,
    cacheRepoId: cacheRepoIdFor(ctx),
    cacheRefScope: deriveCacheRefScope(ctx.trustResolution),
    omitContentHash: !!ctx.testRun,
    runWideFlatSecrets: ctx.runWideFlatSecrets,
    dispatchInputs: ctx.dispatchInputs,
    resolvedSandboxGrants: sandboxResolution.grants,
  });

  const dispatchedJobs: DispatchedJob[] = [];
  const rejectedJobs: RejectedJob[] = [];
  if (buildPrep.buildJobId && buildPrep.buildJobName) {
    dispatchedJobs.push({
      jobId: buildPrep.buildJobId,
      jobName: buildPrep.buildJobName,
      runsOnLabels: buildPrep.buildJobLabels,
    });
  }

  // Register the run BEFORE any job reaches an agent (`startRunBeforeDispatch`).
  const runTrackedEarly =
    buildPrep.buildJobTrackedEarly ||
    (await startRunBeforeDispatch({
      ctx,
      setup,
      buildPrep,
      declaredContexts: secrets.declaredContexts,
    }));

  await dispatchStaticJobs({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobContextData: evalResult.jobContextData,
    dispatchedJobs,
    rejectedJobs,
  });
  // Unmaterialized fan-outs get a synthetic terminal row so the run never reads
  // as complete with no jobs and downstreams keep a real edge: failed as
  // matrix_expansion, or skipped when narrowed to empty.
  for (const failure of buildPrep.matrixFailures) {
    dispatchedJobs.push({ jobId: failure.jobId, jobName: failure.jobName });
    rejectedJobs.push(
      failure.terminalStatus === ExecutionJobStatus.enum.skipped
        ? failure
        : { ...failure, category: InitFailureCategory.enum.matrix_expansion },
    );
  }
  // Context lists and test-run warnings onto job rows; warnings are also
  // aggregated for the trigger response.
  const envWarnings: string[] = [];
  for (const dj of dispatchedJobs) {
    const ed = evalResult.jobContextData.get(dj.jobName);
    if (ed?.contextNames?.length) dj.contexts = ed.contextNames;
    if (ed?.skippedEnvs?.length) dj.skippedContexts = ed.skippedEnvs;
    if (ed?.envWarning) {
      dj.envWarning = ed.envWarning;
      envWarnings.push(ed.envWarning);
    }
  }
  await recordRunStart({
    ctx,
    setup,
    buildPrep,
    declaredContexts: secrets.declaredContexts,
    runContextName: evalResult.runContextName,
    runContextId: evalResult.runContextId,
    dispatchedJobs,
    runTrackedEarly,
  });
  await insertEdgesAndMarkRejected({
    ctx,
    buildPrep,
    dispatchedJobs,
    rejectedJobs,
  });

  // Before the deferred phases, so gate proxies are in flight when downstream
  // jobs are evaluated.
  await invokeRootGates({ ctx, buildPrep });

  // No-jobs guard: no job and no deferred recovery leaves the run invisible or
  // stuck `pending` with zero jobs. Write a failed row
  // (`recordInitFailureRun` overwrites a non-terminal one).
  //
  // Context-rule rejections have their own `rejected-*` rows; the
  // `rejectedJobs` branch is a fail-safe that keeps the recorded category.
  if (
    dispatchedJobs.length === 0 &&
    evalResult.deferredInitJobs.length === 0 &&
    buildPrep.dynamicEntries.length === 0 &&
    (rejectedJobs.length > 0 || ctx.runRegisteredBeforeDispatch)
  ) {
    const rejected = rejectedJobs[0];
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: rejected
        ? (rejected.category ?? categorizeRejectReason(rejected.reason))
        : InitFailureCategory.enum.no_agent,
      reason: rejected?.reason ?? 'No jobs were dispatched for this run',
    });
  }

  await startDeferredPhases({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    secrets,
    evalResult,
    dispatchedJobs,
    runTrackedEarly,
  });

  return {
    dispatchedJobCount: dispatchedJobs.length,
    dispatchedJobIds: dispatchedJobs.map((j) => j.jobId),
    deferredJobCount: evalResult.deferredInitJobs.length + buildPrep.dynamicEntries.length,
    ...(envWarnings.length > 0 && { envWarnings }),
  };
}
