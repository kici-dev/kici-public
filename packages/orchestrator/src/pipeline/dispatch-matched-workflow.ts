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
 * Splits the historic 2438-line `dispatchMatchedWorkflow` into typed phase
 * helpers so each piece can be reasoned about independently. The main
 * exported function is a narrative orchestrator that threads the typed
 * results through the pipeline.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import type { Kysely, Transaction } from 'kysely';
import {
  isLockStaticJob,
  isLockDynamicJobFn,
  isLockInlineValue,
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
import { resolveContainerRegistryAuth } from '../scaler/resolve-container-auth.js';
import { resolveSandboxGrant } from './resolve-sandbox-grant.js';
import type { SandboxAllowList } from './sandbox-allowlist-reader.js';
import { flattenLockSteps } from './flatten-lock-steps.js';
import { storeWebhookPayload } from './webhook-payload-store.js';
import type { Database, HeldRun } from '../db/types.js';
import { JobKind } from '../db/types.js';
import { isInvokeGate, invokeParamsFromLockJob, type InvokeGateParams } from './invoke-gate.js';
import { parseOutputsCell, gatherInvokeResults } from '../orchestrator-core.js';
import { AgentJobFailedError } from '../cache/agent-job-failed-error.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RunContext, JobToRoute } from '../cluster/coordinator.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { TrustPolicyHoldReason, TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import type { CreateHeldRunData } from '../contexts/held-runs.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
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
import {
  buildJobContextDisplayNames,
  resolveJobContextNames,
  resolveMultiEnvMergedData,
} from './job-contexts.js';
import { toContext } from '../contexts/context-store.js';
import { resolveInstallSecrets, type NpmRegistrySpec } from './install-secrets-resolver.js';
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

const logger = createLogger({ prefix: 'pipeline' });

/** Success-only run-on set: the default for a bare-string or unset needs edge. */
const SUCCESS_ONLY_RUN_ON_JSON = JSON.stringify([ExecutionJobStatus.enum.success]);

/**
 * Serialize a lock needs object-form entry's `runOn` status-set to the JSON
 * column value stored on an execution_job_needs edge. Falls back to the
 * success-only default when the entry carries no runOn.
 */
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
 * Pre-resolve a clone token from the dispatch bundle's cloneTokenProvider for
 * the cluster-reroute path. Workers have no provider credentials of their own,
 * so without this token an agent on a peer attempts an unauthenticated HTTPS
 * clone of the source repo and fails on private repos with
 * "could not read Username for 'https://github.com'". Returns undefined when
 * the bundle has no cloneTokenProvider, when the provider returns no token,
 * or when minting throws — failure is non-fatal because the local-dispatch
 * path mints a token of its own at job.dispatch time.
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context for dispatching a single matched workflow.
 *
 * Captures every per-workflow closure dependency so the dispatch body is
 * callable from BOTH the same-source path AND the cross-source delegation
 * shell. `crossSource` is the discriminator the helper uses to override the
 * dispatch `deliveryId` so fan-out targets land on their composite dedup
 * slot (`${inbound.deliveryId}:${reg.id}`) instead of the inbound delivery
 * id.
 */
export interface WorkflowDispatchContext {
  info: WebhookInfo;
  deps: ProcessingDeps;
  /**
   * Provider bundle for the matched source. Undefined for local-repo test runs
   * (`kici run` against an inline lock file with no remote provider): in that
   * mode there is no clone-url builder / check-status poster / clone-token
   * provider, and `repoUrl` falls back to `''` (the agent treats a missing url
   * as a local/`fullRepo` clone). The webhook adapter always passes a defined
   * bundle, so its dispatch behavior is unchanged.
   */
  bundle?: ProviderBundle;
  payload: unknown;
  repoIdentifier: string;
  /**
   * The repository that DEFINES the workflow being dispatched. `repoIdentifier`
   * is the repository the run acts on; for an organization-wide workflow the
   * two are different repositories, and every run row this dispatch writes has
   * to say which one defined it.
   *
   * REQUIRED, for the same reason `securityDecision` is: a dispatch path that
   * does not state it must not compile. Left optional, a new caller omits it
   * silently and every row it records claims the workflow lives in the
   * repository the run acted on — a null marker is read as that fact, not as
   * "unknown" (`registration/registration-run-match.ts`).
   *
   * Every caller today states `repoIdentifier` or a value equal to it, because
   * no cross-repository global dispatch enters this function — the global path
   * builds its job inputs directly and dispatches them itself. The recording
   * sites narrow, so stating the acted-on repository records nothing.
   */
  workflowRepoIdentifier: string;
  credentials: Record<string, unknown>;
  event: SimulatedEvent;
  eventWithFiles: SimulatedEvent;
  ref: string;
  fullLockFile: {
    workflows: readonly LockWorkflow[];
    lockfileHash?: string;
    source: { file: string };
  };
  resolvedOrgId: string;
  /**
   * Siblings admitted against a context concurrency limit during THIS dispatch
   * pass, keyed by {@link concurrencyAdmissionKey}.
   *
   * The gate's running count counts jobs whose status is already `running`, so
   * it cannot see anything this pass has only just admitted. Without this tally
   * every child of a fan-out is evaluated against that one blind value and all
   * N are admitted against a single slot.
   *
   * Created lazily on first use and dropped with the ctx. It is per-pass state,
   * never persisted and never shared between passes; two concurrent passes
   * still race, which is accepted — this is a throughput control, not an
   * isolation boundary.
   */
  concurrencyAdmissions?: Map<string, number>;
  workflow: LockWorkflow;
  decision: WorkflowDecision;
  runId: string;
  trustResolution: TrustResolution | undefined;
  lockFileSource: string | undefined;
  /** True when this run executes an uploaded local working tree (CLI remote run). */
  localWorkingTree: boolean;
  /**
   * Identity that initiated this run, for `execution_runs.triggered_by`.
   *
   * Set by the CLI remote-run path, which knows its caller: the Platform relays
   * the developer's actor on `test.relay.trigger` and the test pipeline renders
   * it here. Undefined on the webhook path, where the initiator is a provider
   * account rather than a KiCI principal — that attribution is carried by
   * `triggerActorUsername` / `triggerActorUserId` instead.
   */
  triggeredBy?: string | null;
  /** Agent provenance label when the run was initiated through an agent credential. */
  triggeredByAgentLabel?: string | null;
  /** True only when invoked from the cross-source dispatch shell. */
  crossSource: boolean;
  /**
   * Trigger-event string for the run's `triggerEvent`, stated explicitly rather
   * than derived from `event.type`.
   *
   * The internal-event adapter needs this because a user `kiciEvent()` renders
   * two different values: `jobConfig.event.type` is the literal `kici_event`,
   * while the run carries the raw event name. `event.type` carries the former,
   * so the latter has to be stated.
   *
   * Absent ⇒ the value derived from the event, unchanged for the webhook,
   * CLI-remote-run and resume callers.
   */
  triggerEventOverride?: string;
  /**
   * The exact `jobConfig.event` envelope to ship, stated explicitly instead of
   * spreading the `SimulatedEvent` this dispatch matched against.
   *
   * Same reason as `triggerEventOverride`: the matcher's event shape and the
   * shape user code observes are not the same object. `SimulatedEvent` requires
   * `targetBranch` and carries `changedFiles`; the envelope omits both. An
   * internally triggered run genuinely has no changed files, and its branch is
   * provenance the orchestrator evaluates (the trigger matcher and the context
   * branch gate) rather than a field user code asked for — the envelope becomes
   * `RuleContext.event` on the agent and the `event` half of
   * `buildConcurrencyGroupContext`, so publishing the branch would silently
   * re-key the documented `ctx.event.targetBranch ?? 'default'` concurrency
   * group of every existing internal workflow.
   *
   * Absent ⇒ the envelope derived from the event, unchanged for the webhook,
   * CLI-remote-run and resume callers.
   */
  eventEnvelopeOverride?: Record<string, unknown>;
  /**
   * Chain depth to stamp on the started run. A run summoned by an invoke gate
   * carries its summoner's depth + 1, which is what bounds the chain-depth
   * circuit breaker. Absent ⇒ 0, the column default (a webhook-triggered run
   * starts a chain).
   *
   * Threading this is load-bearing: the breaker fails OPEN if the value is
   * lost, so an unbounded summon recursion would go undetected. It is stamped
   * as soon as the run row exists, because `releaseInvokeGate` reads the column
   * back at gate-release time — which happens inside this same dispatch.
   */
  chainDepth?: number;
  /**
   * Marks a run dispatched by a failure-lifecycle trigger, so its own
   * completion is excluded from batch accumulation and a broken notifier
   * cannot re-trigger itself (`EventRouter.isFailureLifecycleRun`).
   *
   * Persisted as a field INSIDE the `trigger_decision` JSON blob, merged onto
   * the decision summary rather than replacing it.
   */
  dispatchedByFailureLifecycle?: boolean;
  /**
   * Marks a run the orchestrator triggered itself — a schedule fire, a
   * workflow/job completion, a failure batch, a user `kiciEvent()`, or an
   * invoke-gate summon — as opposed to one a provider webhook triggered.
   *
   * Read by the context branch gate, and by nothing else. Such a run usually
   * carries a real branch in `event.targetBranch` — a schedule fire presents
   * its registration's default branch, every other internal trigger inherits
   * the branch of the run that emitted its event — and the gate matches it like
   * any other run's. The flag singles out the runs whose `targetBranch` is
   * EMPTY: a failure batch or a scaler event (many runs behind it, or none), a
   * registration whose default branch has never been captured, an emitting run
   * that is gone. The gate rejects those naming that cause, instead of quoting
   * an empty value as though it were a branch name. It does NOT weaken the
   * gate — a run with no branch cannot satisfy a restriction, `*` included.
   *
   * Absent ⇒ webhook-triggered, unchanged for the webhook, CLI-remote-run and
   * resume callers.
   */
  internallyTriggered?: boolean;
  /**
   * Outcome of the org trust-policy gate for this PR event. `pass` dispatches
   * normally; `hold` parks the run in the security queue; `reject` fails it
   * before any job starts. Computed once per PR event in the webhook pipeline
   * and threaded down; the dispatch gate acts on it directly, see
   * `holdRunForSecurityPolicy` / `rejectRunForSecurityPolicy`.
   *
   * REQUIRED: a dispatch path that does not state a decision must not compile.
   * This field was optional once and the gate read `if (!decision) return
   * null`, so forgetting to thread it meant the run passed the security gate —
   * fail-open by omission inside a fail-closed control. A `pass` is stated
   * explicitly.
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
   * Set once `setupDispatchContext` has posted this dispatch's queued
   * `kici/<workflow>` check and one `kici/<workflow>/job/<name>` per static job.
   *
   * Those checks go up BEFORE anything decides whether the run will start, so
   * every exit after setup owes them a conclusion. The named early exits each
   * complete their own; a THROW does not, and nothing else can — the workflow
   * check keys off a run whose jobs never registered, and the stale sweep only
   * touches check runs already `in_progress`. Left alone they stay `queued`
   * forever, which on a pull request is a check that never finishes and a
   * branch-protection blocker.
   */
  pendingChecksPosted?: boolean;
  /** Composite dedup key `${info.deliveryId}:${reg.id}` (cross-source only). */
  crossSourceDeliveryId?: string;
  /**
   * Routing key to use for dispatched QueuedJobInput + log / tracker rows.
   * Same-source: equal to `info.routingKey`. Cross-source: equal to
   * `reg.routingKey` (the registration's owning source, NOT the inbound
   * generic routing key).
   */
  effectiveRoutingKey?: string;
  /**
   * Provider identifier to use for dispatched QueuedJobInput + tracker rows.
   * Same-source: equal to `info.provider`. Cross-source: equal to
   * `regBundle.normalizer.provider` (the registration's provider type,
   * e.g. 'github').
   */
  effectiveProvider?: string;
  /**
   * Extra jobConfig fields merged into every dispatched QueuedJobInput by
   * this helper. Cross-source callers use this to inject provenance fields
   * (`crossSource: true`, `inboundRoutingKey`, `inboundEventName`,
   * `workflowRepoUrl`, `workflowRef`, `workflowSha`,
   * `workflowRepoIdentifier`) that downstream agents / dashboards need for
   * correct clone + logging.
   */
  extraJobConfig?: Record<string, unknown>;
  /**
   * Test-run provenance. Present only for `kici run` / test-trigger dispatches.
   * When set, `recordRunStart` stamps `is_test_run = true` and
   * `fixture_id = testRun.fixtureId` on the `execution_runs` row. Undefined for
   * webhook runs (the stamp block is skipped).
   */
  testRun?: { fixtureId: string };
  /**
   * Run-wide flat secrets layered onto EVERY dispatched job's `jobConfig.secrets`
   * (env-declaring or not). Used by the test path to deliver `kici run --secret`
   * / `--env` CLI flat secrets, which must reach a job regardless of whether it
   * declares an `context:`. Merged UNDER the per-job env-resolved secrets so
   * the CLI value wins on a key collision (matching the prior B1-env -> A-CLI
   * precedence). Undefined for webhook runs.
   */
  runWideFlatSecrets?: Record<string, string>;
  /**
   * Runtime host narrowing from `kici run --target` (Ansible `--limit`). Applied
   * as a post-filter over each runsOnAll job's matched roster: effective hosts =
   * runsOnAll ∩ target. Narrow-only. Undefined for webhook runs (no narrowing).
   */
  target?: HostTargetSelector;
  /**
   * Resolved (coerced + defaulted + validated) workflow-dispatch inputs from
   * `kici run --input`. Carried onto every dispatched job's request so the agent
   * exposes them as `ctx.dispatchInputs`. Undefined for webhook runs.
   */
  dispatchInputs?: Record<string, unknown>;
}

/**
 * The trigger-event string every recording site in this file stamps on the run.
 *
 * `ctx.triggerEventOverride` wins verbatim when stated; otherwise the value is
 * derived from the simulated event exactly as the webhook / CLI-remote-run /
 * resume callers have always derived it. Routing every site through one helper
 * is what keeps a new recording path from silently ignoring the override.
 *
 * "Stated" means a non-blank string. A `??` alone would let `''` (or a
 * whitespace-only string) through as a value, and a blank trigger event is not
 * a trigger event: it reaches the dashboard and the Platform forward as the
 * run's only answer to "what fired this?", where it renders as nothing at all
 * rather than as the derived value the caller clearly meant to keep.
 *
 * The guard is only ever load-bearing when the DERIVED value is non-blank — a
 * caller that states a blank override over a real `event.type`. It does NOT
 * rescue a dispatch whose event type is itself blank (a bare `__` name
 * de-prefixes both to `''`, so the fallback returns `''` too); that input is
 * unemittable, since the emit path refuses the whole `__` namespace and the
 * orchestrator mints only enumerated names.
 */
function dispatchTriggerEvent(ctx: WorkflowDispatchContext): string {
  const override = ctx.triggerEventOverride;
  if (override !== undefined && override.trim() !== '') return override;
  return buildTriggerEvent(ctx.event.type, ctx.event.action);
}

/**
 * The `trigger_decision` blob for a run this dispatch records.
 *
 * `dispatchedByFailureLifecycle` is MERGED onto the decision summary, never
 * substituted for it: the summary's own fields are what the dashboard and the
 * registration matcher read back, and `EventRouter.isFailureLifecycleRun`
 * only needs its own key to be present alongside them. The key is omitted
 * entirely when the dispatch is not a failure-lifecycle one, so a plain run's
 * blob is byte-identical to what it was before this field existed.
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
 * Stamp the inherited chain depth on the run row this dispatch just recorded.
 *
 * Called immediately after each site that inserts the row, NOT at the end of
 * dispatch: `releaseInvokeGate` reads `execution_runs.chain_depth` back when it
 * releases a root gate, which happens inside this same call. A depth written
 * afterwards would leave the circuit breaker reading 0 for a summoned run and
 * failing open on an unbounded summon recursion.
 *
 * A run that starts its own chain writes nothing at all — the column defaults
 * to 0, so the webhook path keeps its exact previous write set.
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

/**
 * The two internal-trigger fields every PRE-dispatch recording site has to
 * carry. There are five: the install-gate hold, the trust-policy hold, the
 * trust-policy reject, the init-failure skip, and the build that failed before
 * tracking started. Each writes its `execution_runs` row and returns, so there
 * is no later dispatch step to stamp either value.
 *
 * `chainDepth` is the load-bearing one, and only on the two HOLDS: a hold is
 * RESUMABLE, so released, the run goes on to fire its own invoke gate, and
 * `releaseInvokeGate` reads `execution_runs.chain_depth` back to bound the
 * recursion. A row inserted without it carries the column's `0` default, which
 * does not read as "unknown" — it reads as "this run starts a chain", so the
 * circuit breaker fails OPEN. That was harmless only while no summoned run
 * could reach these sites; routing internal events through this dispatch makes
 * it reachable. The three terminal sites are stamped for the record rather
 * than for a reader: their row is the run's only trace, and one saying `0`
 * claims to have started the chain it actually died inside.
 *
 * `dispatchedByFailureLifecycle` rides along for the same lifetime reason: a
 * HELD run resumes onto its own row and completes, and that completion is what
 * a `workflows_failed_batch` accumulator would otherwise fold back into the
 * very batch that spawned it. The terminal sites record it for consistency —
 * none of them emits a completion event today.
 *
 * A stated `chainDepth` is passed on verbatim, `0` included; the tracker is
 * where `0` normalizes away (see `inheritedChainDepth`), so that decision lives
 * in one place instead of being re-made at every layer.
 */
function preDispatchRunProvenance(ctx: WorkflowDispatchContext): {
  chainDepth?: number;
  dispatchedByFailureLifecycle?: boolean;
} {
  return {
    ...(ctx.chainDepth !== undefined && { chainDepth: ctx.chainDepth }),
    ...(ctx.dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
  };
}

/**
 * The minimal slice of a dispatch context the needs catch-up + ready-recompute
 * helpers read. Both the per-repository `WorkflowDispatchContext` and the
 * global-workflow dispatch path (which builds its own inputs and never
 * constructs a full `WorkflowDispatchContext`) can drive the needs scheduler
 * through this narrow shape.
 */
export type NeedsSchedulingContext = Pick<WorkflowDispatchContext, 'deps' | 'runId'>;

/**
 * Build the dispatch-envelope event, carrying the orchestrator's already-fetched
 * changed-files list + status from `eventWithFiles` as a fast-path (the agent
 * recomputes from the clone when status !== 'fetched', so this only forfeits the
 * optimization when a path is missed — correctness comes from the agent).
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
  /** Number of jobs successfully dispatched (non-rejected). */
  dispatchedJobCount: number;
  /** Execution job ids of every dispatched/tracked job (root, gated, synthetic). */
  dispatchedJobIds: string[];
  /**
   * Jobs whose dispatch is deferred to the agent init round (a dynamic context
   * or a deferred-init job) and therefore not yet in `dispatchedJobIds`. These
   * still run — they are dispatched asynchronously by `startDeferredPhases` —
   * so a caller must not treat a run with pending deferred work as "nothing
   * dispatched". Absent/0 on the early-return paths.
   */
  deferredJobCount?: number;
  /** True when the workflow install gate paused the dispatch (held run). */
  held?: boolean;
  /**
   * User-visible warnings aggregated from dispatched jobs — today, one per job
   * whose bound test-run context(s) were unavailable and skipped. Surfaced
   * on the accepted trigger response so the CLI can print them.
   */
  envWarnings?: string[];
}

/** Options controlling a (re-)dispatch of a matched workflow. */
export interface DispatchMatchedWorkflowOptions {
  /**
   * Resume path: skip the workflow install protection gate (already satisfied)
   * so secrets resolve directly and the dispatch flows into job dispatch.
   */
  skipInstallProtectionGate?: boolean;
  /**
   * The run id whose `held` execution_runs row should be reused (flipped to
   * pending) instead of inserting a fresh row.
   */
  reuseRunId?: string;
}

// ---------------------------------------------------------------------------
// Internal types — threaded between phase helpers
// ---------------------------------------------------------------------------

type DispatchFn = (input: QueuedJobInput) => ReturnType<Dispatcher['dispatch']>;

interface DispatchSetup {
  /** Wrapped dispatcher that injects ctx.extraJobConfig into every dispatch. */
  dispatcher: { dispatch: DispatchFn };
  /** WebhookInfo overlaid with effective routing key + provider. */
  info: WebhookInfo;
  /** Composite delivery id on cross-source, otherwise info.deliveryId. */
  effectiveDeliveryId: string;
  workflowConcurrency: { cancelInProgress?: boolean; max?: number } | undefined;
  workflowTimeoutMs: number | undefined;
  /**
   * Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`),
   * carried on `ctx.extraJobConfig` by the test-trigger / `kici run --check`
   * path. Persisted onto the `execution_runs` row so `computeRunStatus` can
   * fail a `check-fail-on-drift` run that detected drift. Undefined for the
   * default apply-mode webhook path.
   */
  checkMode: string | undefined;
}

interface BuildPrepResult {
  sourceTarUrl: string | undefined;
  sourceTarHash: string | undefined;
  depsUrl: string | undefined;
  depsHash: string | undefined;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  hasDynamicEntries: boolean;
  dynamicEntries: ReadonlyArray<Extract<LockWorkflow['jobs'][number], { _type: 'dynamic' }>>;
  staticJobs: readonly LockJob[];
  /**
   * Static jobs expanded into dispatchable children (matrix fan-out). Non-matrix
   * jobs pass through 1:1. Every dispatch phase iterates this list, keying by
   * `expandedName`. Dynamic-matrix jobs are flagged `pendingDynamicMatrix`.
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
  /** True when the build failed but dynamic entries can still proceed. */
  buildFailed: boolean;
  /**
   * True when the helper has fully short-circuited the dispatch (build failed
   * and no dynamic entries to fall back on, or build job rejected). Caller
   * MUST early-return with `dispatchedJobCount: 0`.
   */
  abort: boolean;
}

interface SecretBundle {
  resolvedSecrets: Record<string, string> | undefined;
  resolvedNamespacedSecrets: Record<string, Record<string, string>> | undefined;
  declaredContexts: readonly string[];
  runPublicKeyBase64: string | undefined;
  /** Resolved private npm registries (token bytes already filled in). Undefined = none. */
  npmRegistries: NpmRegistrySpec[] | undefined;
  /** Bare-name resolved secrets to project as install env vars. Undefined = none. */
  installEnvSecrets: Record<string, string> | undefined;
}

interface JobEnvData {
  contextName?: string;
  /** Configured env id matched for the first declared context name. */
  contextId?: string;
  /**
   * Ordered bound-context names persisted on the job row (`(dynamic)`
   * placeholder for elements unresolved at dispatch; overwritten with the
   * agent-resolved list for dynamic contexts). Empty/undefined = no binding.
   */
  contextNames?: string[];
  contextVars?: Record<string, string>;
  jobEnv?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
  /**
   * Registry credentials for this job's container image, resolved from the
   * secret NAMES the lock carries. Lifted to a top-level dispatch field (and
   * stripped from jobConfig) before the message reaches the agent.
   */
  containerRegistryAuth?: { username: string; password: string; serveraddress: string };
  held?: boolean;
  /**
   * Pending approval hold for this job, set when a context policy or
   * explicit lock `approval` requires human sign-off. The dispatch loop turns
   * this into a `held_runs` row + a stored pending job context so `release()`
   * can re-dispatch after approval.
   */
  approvalHold?: PendingApprovalHold;
  /**
   * A non-reviewer hold (security / wait-timer / concurrency-queue) decided by a
   * context's protection rules. Carried rather than written on the spot so
   * `holdJobForApproval` can create the row and the job's resume path in ONE
   * transaction — the reviewer branch uses `approvalHold` for the same purpose.
   */
  nonApprovalHold?: CreateHeldRunData;
  rejected?: boolean;
  rejectReason?: string;
  pendingInit?: boolean;
  /** Bound contexts skipped on a test/local run because they disallow local execution. */
  skippedEnvs?: string[];
  /**
   * User-visible warning set whenever any bound context was unavailable for
   * a test run (non-test or unconfigured) and skipped — surfaced on the CLI run
   * output and the dashboard run view.
   */
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
 * Synthetic job-id prefix every needs-gate site stamps on a job it holds back.
 * The release path (`dispatchReadyJob` → `findSyntheticJobId` → `addJobsToRun`)
 * keys on it, so it is load-bearing rather than cosmetic — which is what makes
 * it a sound way to recover the gated set without threading a parallel list
 * through both the single-orchestrator and cluster dispatch paths.
 */
export const NEEDS_PENDING_JOB_ID_PREFIX = 'needs-pending-';

/**
 * Fallback reason for a context protection-rule rejection whose evaluator
 * returned no reason of its own. The real reason names the offending context
 * and rule; this only covers the degenerate case, and is shared so the setter
 * and the run-facing record can never carry different words for it.
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
  /** Ordered bound-context names persisted on the job row (multi-env jobs). */
  contexts?: string[];
  /** Bound contexts skipped on a test run (non-test / unconfigured). */
  skippedContexts?: string[];
  /** User-visible warning naming the skipped test-run contexts. */
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
   * Terminal status to record for this job. Defaults to `failed`. A zeroed
   * `runsOnAll` that intentionally narrowed to no hosts is recorded as `skipped`
   * (no init-failure) so its downstreams' `when` sets govern propagation.
   */
  terminalStatus?: ExecutionJobStatus;
}

type BuildJobConfigFn = (mat: MaterializedJob) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// Phase A — setup
// ---------------------------------------------------------------------------

/**
 * Build the wrapped dispatcher, overlay info with effective routing/provider,
 * persist the webhook payload, fire source-location callbacks, and post the
 * pending check-run check. Pure side-effects + a typed result bag for
 * downstream phases.
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

  // The test-trigger / `kici run --check` path stamps the run mode onto
  // ctx.extraJobConfig.checkMode; surface it so onExecutionStarted persists it.
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
      jobNames,
      installationId: (credentials as { installationId?: number }).installationId,
      routingKey: info.routingKey,
      // Explicit runId/requestId so the reporter can build details_url
      // even if a later async hop drops the ALS frame.
      runId,
      requestId: getRequestContext().requestId,
    });
    // Only after the post resolved: the flag says the checks are ON the commit,
    // so a failed post must not make the catch fabricate a conclusion for a
    // check run that was never created.
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
 * Choose the execution platform for this workflow. The first job's runsOn
 * label set determines which agents are candidates; the first matching agent
 * picks platform/arch. Falls back to linux/x64 when no agents are registered.
 */
function chooseTargetPlatform(
  workflow: LockWorkflow,
  agentRegistry: ProcessingDeps['agentRegistry'],
): { targetPlatform: string; targetArch: string } {
  let targetPlatform = 'linux';
  let targetArch = 'x64';
  if (!agentRegistry) return { targetPlatform, targetArch };
  // Only exact labels can pick a representative agent; regex patterns can't be
  // turned into a concrete label to probe. An empty exact set falls back to
  // 'default' so a glob-only first job still probes for any agent.
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
 * Probe source + dep caches and forward stats to Platform.
 * Cross-source dispatch always clones-and-installs, so caches are bypassed.
 */
async function probeCaches(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
  contentHash: string | undefined,
  lockfileHash: string | undefined,
  targetPlatform: string,
  targetArch: string,
): Promise<{ sourceHit: boolean; depHit: boolean }> {
  const { deps, workflow, crossSource } = ctx;
  let sourceHit = false;
  let depHit = false;
  // Local-repo runs (no bundle) carry their source as a working-tree overlay,
  // and `file://` in-place runs (`localWorkingTree`) run the operator's real
  // tree directly — neither is a cacheable provider build, so skip the source/dep
  // cache probe entirely (a stale cached tarball must never shadow the tree).
  if (!ctx.bundle || ctx.localWorkingTree) {
    return { sourceHit, depHit };
  }
  if (!crossSource && contentHash && deps.sourceCache) {
    sourceHit = await deps.sourceCache.has(contentHash);
    if (sourceHit) {
      sourceCacheHitsTotal.add(1);
      logger.info('Source cache hit', { workflow: workflow.name, contentHash });
    } else {
      sourceCacheMissesTotal.add(1);
      logger.info('Source cache miss', { workflow: workflow.name, contentHash });
    }
    deps.platformClient?.send({ type: 'cache.stats', cacheType: 'source', hit: sourceHit });
  }
  if (!crossSource && lockfileHash && deps.depCache) {
    depHit = await deps.depCache.has(lockfileHash, targetPlatform, targetArch);
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
 * Whether this dispatch must run a `__build__` job before its real jobs.
 *
 * Either cache missing is a reason to build. The two are keyed on different
 * things — the source cache on the workflow source's contentHash, the dep cache
 * on the lockfile hash — so they miss independently, and a dependency bump is
 * exactly the case that leaves the source warm and the deps cold. Gating only on
 * the source miss made that state permanent: no build job ran, so nothing ever
 * uploaded the dep tarball, so every agent fell back to installing from the
 * registry on every job — and an agent with no route to that registry (a
 * cloud-hosted one-shot agent, an air-gapped runner) could not run the job at
 * all. The `__build__` job already carries `buildSourceNeeded` /
 * `buildDepsNeeded` separately and the agent already honors both, so a
 * deps-only build was implemented and simply unreachable.
 *
 * A hash is required alongside its miss: with no hash there is no cache key to
 * write, so building would produce an artifact nothing could ever look up.
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

/**
 * Build the QueuedJobInput for a __build__ job. Same-shape helper used by the
 * build-job dispatch flow inside `runBuildJob`.
 */
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
  const { workflow, fullLockFile, bundle, repoIdentifier, credentials, event, ref } = ctx;
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
      workflowName: workflow.name,
      buildSourceNeeded: !args.sourceHit && !!args.contentHash,
      buildDepsNeeded: !args.depHit && !!args.lockfileHash,
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
    },
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
  };
}

/**
 * Build the QueuedJobInput for a synthetic `__bringup__` job: the orchestrator
 * dispatches one per declared-but-un-agented `includeUninitialized` child to an
 * agent holding `kici:capability:ssh-transport`, which runs the agent-side
 * `ensureInitRunner(targetAgentId)` over SSH. The init-runner then connects
 * under `targetAgentId`, and the child's pinned-hold (already queued with that
 * pin) drains its bootstrap steps onto it. The bring-up job clones nothing and
 * runs no sandbox (`bringupOnly`).
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
 * Dispatch the synthetic `__bringup__` job for one un-agented fan-out child. The
 * bring-up runs on an ssh-transport ops agent; if none is connected, the
 * bring-up job queues with its label pin and the held target child times out via
 * the normal queue path. Best-effort: a bring-up dispatch failure is logged, not
 * thrown — the held child surfaces the timeout if no init-runner ever connects.
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
 * Run the build job and track its result. Returns the build job metadata or
 * sentinel values when the build fails. Mutates execution-tracker rows so
 * downstream phases can attach execution_jobs to a real run.
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
  /**
   * True when the workflow has jobs that are dispatched only after the build
   * finishes. Drives the pending-jobs token that keeps the run from being
   * finalized the moment the build job goes terminal.
   */
  hasPostBuildJobs: boolean;
}): Promise<{
  buildJobId: string | undefined;
  buildJobName: string;
  buildJobLabels: string[] | undefined;
  buildJobTrackedEarly: boolean;
  rejected: boolean;
  /**
   * Set when `ensureBuild` rejects (typically a build-coordinator timeout).
   * Returned instead of thrown so the caller still sees `buildJobId` if the
   * inner closure managed to insert the build job's dispatch_queue row
   * before the timer fired — without that, the caller has no way to mark
   * the orphaned `dispatched` row as `failed`.
   */
  error: unknown;
}> {
  const { ctx, setup, contentHash, lockfileHash } = args;
  const {
    deps,
    workflow,
    repoIdentifier,
    credentials,
    event,
    ref,
    runId,
    decision,
    localWorkingTree,
    triggeredBy,
    triggeredByAgentLabel,
  } = ctx;
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
          await deps.executionTracker.onExecutionStarted(
            runId,
            workflow.name,
            setup.info.provider,
            repoIdentifier,
            event.targetBranch,
            ref,
            setup.effectiveDeliveryId,
            credentials as Record<string, unknown>,
            dispatchTriggerDecision(ctx, decision),
            [
              {
                jobId: syntheticId,
                jobName: buildJobName,
                runsOnLabels: buildJobInput.runsOnLabels,
              },
            ],
            setup.info.routingKey,
            undefined,
            dispatchTriggerEvent(ctx),
            extractCommitMessage(setup.info.event, setup.info.payload),
            undefined, // parentRunId
            triggeredBy,
            undefined, // originalRunId
            setup.workflowConcurrency,
            setup.workflowTimeoutMs,
            setup.checkMode,
            localWorkingTree,
            event.senderUsername ?? undefined,
            event.senderUserId ?? undefined,
            triggeredByAgentLabel, // triggeredByAgentLabel
            event.prNumber ?? null,
          );
          await stampChainDepth(ctx);
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
        await deps.executionTracker.onExecutionStarted(
          runId,
          workflow.name,
          setup.info.provider,
          repoIdentifier,
          event.targetBranch,
          ref,
          setup.effectiveDeliveryId,
          credentials as Record<string, unknown>,
          dispatchTriggerDecision(ctx, decision),
          [{ jobId: buildJobId, jobName: buildJobName, runsOnLabels: buildJobLabels }],
          setup.info.routingKey,
          undefined,
          dispatchTriggerEvent(ctx),
          extractCommitMessage(setup.info.event, setup.info.payload),
          undefined, // parentRunId
          triggeredBy,
          undefined, // originalRunId
          setup.workflowConcurrency,
          setup.workflowTimeoutMs,
          setup.checkMode,
          localWorkingTree,
          event.senderUsername ?? undefined,
          event.senderUserId ?? undefined,
          triggeredByAgentLabel, // triggeredByAgentLabel
          event.prNumber ?? null,
        );
        await stampChainDepth(ctx);
        buildJobTrackedEarly = true;
        // The run is now registered with the build job ALONE, and this closure
        // awaits the build before any other job is dispatched. Without a token
        // the build going terminal satisfies isRunComplete, so the run is
        // finalized mid-build — posting the provider check status and
        // forwarding a terminal run status to the Platform before a single real
        // job has run. Taken here rather than after the build so it is in place
        // before the build can report terminal; released by
        // dispatchMatchedWorkflow's finally.
        if (args.hasPostBuildJobs && deps.executionTracker.holdRunForPendingJobs(runId)) {
          args.ctx.dispatchWindowTokenHeld = true;
        }
      }
      if (
        deps.pendingBuilds &&
        (result.status === 'dispatched' ||
          result.status === 'queued' ||
          result.status === 'queued-no-backend')
      ) {
        await deps.pendingBuilds.track(result.jobId);
      }
    });
  } catch (err) {
    // ensureBuild rejected (typically build-coordinator timeout). Don't
    // re-throw — the closure may have already populated `buildJobId` /
    // `buildJobTrackedEarly` synchronously before the timer fired, and
    // the caller needs that state to drive `recordBuildFailure`. The
    // caller routes on `error` instead of relying on the throw.
    error = err;
  }
  return { buildJobId, buildJobName, buildJobLabels, buildJobTrackedEarly, rejected, error };
}

/**
 * Mark a build failure end-to-end: record the failed check status, fail the
 * execution_runs row, and (optionally) bootstrap a minimal failed run when
 * the build threw before onExecutionStarted ran.
 */
async function recordBuildFailure(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildJobTrackedEarly: boolean;
  err: unknown;
  /**
   * Build job's dispatch_queue id when the inner closure managed to insert
   * the row before `ensureBuild` rejected. Used to mark the orphaned
   * `Dispatched` row as `Failed` directly: the run-level cascade in
   * `executionTracker.onBuildFailed` only fires when `buildJobTrackedEarly`
   * is true, but the dispatch_queue row exists regardless.
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
  // Mark the build job's dispatch_queue row as failed even when the
  // run-level cascade can't reach it (`buildJobTrackedEarly` is false
  // because the build-coordinator timeout fired before the closure's
  // `onExecutionStarted` await returned). Without this, the row
  // stays in `Dispatched` indefinitely until the agent eventually
  // sends `job.complete` — and the build-timeout E2E (which polls
  // for `failed`/`expired`) would never observe a terminal state.
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
 * Mark a build success: post the success check status and read final URLs
 * from the cache for downstream dispatch.
 */
async function readPostBuildCacheUrls(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  contentHash: string | undefined;
  lockfileHash: string | undefined;
  targetPlatform: string;
  targetArch: string;
}): Promise<{
  sourceTarUrl: string | undefined;
  sourceTarHash: string | undefined;
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
  let sourceTarHash: string | undefined;
  let depsUrl: string | undefined;
  let depsHash: string | undefined;
  if (contentHash && deps.sourceCache) {
    sourceTarUrl = (await deps.sourceCache.getUrl(contentHash)) ?? undefined;
    sourceTarHash = contentHash;
  }
  if (lockfileHash && deps.depCache) {
    const depResult = await deps.depCache.getUrlAndHash(lockfileHash, targetPlatform, targetArch);
    if (depResult) {
      depsUrl = depResult.url;
      depsHash = depResult.hash;
    }
  }
  return { sourceTarUrl, sourceTarHash, depsUrl, depsHash };
}

/**
 * Phase B orchestrator: probe caches, dispatch the build job (if needed),
 * and surface enough state for downstream phases to skip / continue
 * appropriately.
 */
/**
 * Materialize each static job's matrix into dispatchable children. A job whose
 * matrix is invalid (zero combinations / over the cap) is dropped from the
 * dispatch list and recorded as a `matrix_expansion` matrix failure so the run's
 * other jobs still proceed. Dynamic-matrix jobs pass through with a
 * `pendingDynamicMatrix` marker for the eval flow.
 */
/**
 * Resolve a `runsOnAll` lock job against the declared host roster and partition
 * the matched hosts into the target set per the `onUnreachable` policy (R2):
 * `ready` hosts always run; unreachable durable (`static`) hosts hold / fail /
 * skip; stale ephemeral hosts are always skipped. Throws {@link FanoutError}
 * when the run can't proceed (fail policy with an absent host, or zero targets).
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
  // `includeUninitialized` widens the fan-out to declared-but-un-agented hosts:
  // each unreachable static host becomes a bring-up target (its child is held
  // until a temporary init-runner connects under the same agentId) rather than
  // being subject to the `onUnreachable` policy. A live host runs on its own
  // agent. Default (absent) ⇒ today's `onUnreachable` semantics, no bring-up.
  const includeUninitialized = lockJob.includeUninitialized === true;
  // `findFanoutTargets`, not `findMatching`: fan-out covers declared fleet
  // members, so an auto-scaler-spawned agent is never a target. Pinning a child
  // to one would run it at the pool's fixed shape instead of its own.
  const matched = await deps.hostRosterStore.findFanoutTargets(
    predicate.include,
    predicate.exclude,
    deps.rosterGraceMs ?? 300_000,
  );

  // `--target` narrows the runsOnAll-matched roster as a post-filter (never
  // widens). `matched` is kept intact for the non-target zero-host heuristic
  // below; only `candidates` is narrowed.
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
      // The roster matched hosts but `--target` removed every one. `allowEmpty`
      // chooses the synthetic job's terminal state: skipped (downstream `when`
      // governs) vs failed (fail-loud).
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
}

/**
 * Partition a lock job's runsOn / excludeLabels matchers into exact labels (SQL
 * `@>` prefilter + registry index) and regex patterns (JS post-filter). A
 * `runsOnAll` host-fanout job has no `runsOn`; its pinned children carry no
 * routing (the pin targets the resolved agent directly).
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
  };
}

/**
 * Runtime facts a job's own shape demands of the host that runs it.
 *
 * Only a `container.dockerfile` job gets one. Building shells out to a
 * `docker` / `podman` CLI, so a host without one cannot run the job at all, and
 * the agent self-reports `kici:runtime:container-build` when it has one.
 *
 * A job that names a finalized `image` deliberately gets NOTHING added. Adding
 * an implicit requirement to jobs that already work is how container jobs were
 * stranded once before: they had been running fine, and a routing gate the
 * orchestrator could not actually evaluate made them match nothing. A dockerfile
 * job is new, so requiring the fact strands no existing workflow — and an agent
 * old enough not to report the fact is an agent that cannot build anyway.
 *
 * Applied when matching REGISTERED agents (the dispatcher), and deliberately
 * NOT when consulting the scaler. A scaler backend is chosen by exact label-set
 * containment, so a required label the operator never wrote in a pool's label
 * set matches no backend at all — the job would be stranded `queued-no-backend`
 * rather than spawned. The pool's hosts are the operator's to describe; what an
 * agent can actually do is known only once it registers and says so.
 */
export function requiredRuntimeLabelsFor(container: unknown): string[] {
  if (!container || typeof container !== 'object') return [];
  const dockerfile = (container as { dockerfile?: unknown }).dockerfile;
  return typeof dockerfile === 'string' && dockerfile.length > 0
    ? [CONTAINER_BUILD_RUNTIME_LABEL]
    : [];
}

/**
 * Resolve a generated job's single bare-`agentId` `runsOn` into a host pin.
 *
 * The documented inventory fan-out pattern is `runsOn: [h.agentId]`. A bare
 * agentId is not a label any agent advertises, so the normal label path leaves
 * the job `queued-no-backend`. When the single exact label names a known roster
 * host, resolve it to a `pinnedAgentId` dispatch (+ the host's coordinator for
 * cross-cluster reroute) — exact parity with how `runsOnAll` children pin. Any
 * other shape (multi-label, a regex pattern, a non-roster label, or no roster
 * store) returns null and the caller keeps normal label routing.
 */
export async function resolveRosterAgentPin(args: {
  runsOnLabels: string[];
  runsOnPatterns: LabelMatcher[];
  hostRosterStore: HostRosterStore | undefined;
}): Promise<{ pinnedAgentId: string; connectedInstanceId: string | null } | null> {
  const { runsOnLabels, runsOnPatterns, hostRosterStore } = args;
  if (!hostRosterStore) return null;
  if (runsOnLabels.length !== 1 || runsOnPatterns.length > 0) return null;
  const candidate = runsOnLabels[0];
  const row = await hostRosterStore.get(candidate);
  if (!row) return null;
  return { pinnedAgentId: candidate, connectedInstanceId: row.connected_instance_id ?? null };
}

/**
 * The generic fan-out tracking fields persisted on `execution_jobs` for a
 * materialized child: `baseJobName` + `variantKind` + `variantLabel`. Serves
 * matrix (label = combination suffix) and host (label = hostname) uniformly so
 * the dashboard groups on real columns instead of string-parsing the name.
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

/** Per-child rolling-wave plan: which children are held + the base's wave policy. */
export interface WavePlan {
  /** `expandedName`s held behind the wave gate (beyond the maxParallel window). */
  held: Set<string>;
  /** `expandedName` → the base's `{maxParallel, failFast}`, stamped on every child of a bounded wave. */
  policy: Map<string, { maxParallel: number; failFast: boolean }>;
}

/**
 * Compute the rolling-wave plan for a materialized job set.
 *
 * For each base job declaring `maxParallel` whose fan-out produced more than one
 * child, children are ordered deterministically by `fanoutIndex` (the
 * agentId / variant-label rank assigned at materialization; falling back to
 * `expandedName` for children with no index) and every child at index `>=
 * maxParallel` is held (`wave_gated=true`). The first `maxParallel` dispatch
 * immediately; held children release one-per-terminal via the wave-scheduler.
 * Every child of a bounded-wave base — held or not — gets a `policy` entry so
 * the wave-scheduler can read the width/failFast at terminal time. A non-fan-out
 * job (single child) or one without `maxParallel` contributes nothing.
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
    // Order by the deterministic fan-out index so wave-release order == child
    // index; fall back to expandedName for children without an index.
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
        // Map the zeroed base to its synthetic terminal job (its own name) so
        // insertEdgesForRun creates a real edge for downstreams. The synthetic
        // row's status (skipped vs failed) then governs propagation via `when`.
        expansionMap.set(lockJob.name, [lockJob.name]);
        continue;
      }
      throw err;
    }
  }
  return { materializedJobs, expansionMap, matrixFailures };
}

async function prepareCacheAndBuild(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
): Promise<BuildPrepResult> {
  const { deps, workflow, fullLockFile, crossSource, localWorkingTree } = ctx;
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
  let sourceTarHash: string | undefined;
  let depsUrl: string | undefined;
  let depsHash: string | undefined;
  let buildJobId: string | undefined;
  let buildJobName: string | undefined;
  let buildJobLabels: string[] | undefined;
  let buildJobTrackedEarly = false;
  let buildFailed = false;

  // A build job fetches + caches the workflow source from the provider bundle.
  // A local-repo run (no bundle — `kici run` against an inline lock with the
  // working tree carried as an overlay) has no remote source to build, so it
  // skips the build and dispatches its static jobs directly. The webhook path
  // always has a bundle, so its build behavior is unchanged.
  //
  // A local `file://` IN-PLACE run (`localWorkingTree`) likewise skips the
  // source-pack build: the agent runs the operator's real tree directly (under
  // its KICI_IN_PLACE profile — no clone, no source-restore), so packing a
  // source tarball is both wasteful and wrong (it would carry a dist-less clone).
  const cacheInfraAvailable =
    !crossSource &&
    !localWorkingTree &&
    !!ctx.bundle &&
    deps.buildCoordinator &&
    (deps.sourceCache || deps.depCache);
  // Either cache missing is a reason to build. The two are keyed on different
  // things — the source cache on the workflow source's contentHash, the dep
  // cache on the lockfile hash — so they miss independently, and a dependency
  // bump is exactly the case that leaves the source warm and the deps cold.
  // Gating only on the source miss made that state permanent: no build job ran,
  // so nothing ever uploaded the dep tarball, so every agent fell back to
  // installing from the registry on every job — and an agent with no route to
  // that registry (a cloud-hosted one-shot agent, an air-gapped runner) could
  // not run the job at all. The build job already carries `buildSourceNeeded` /
  // `buildDepsNeeded` separately and the agent already honors both, so a
  // deps-only build was implemented and simply unreachable.
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
        sourceTarHash,
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
          sourceTarHash,
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
      ({ sourceTarUrl, sourceTarHash, depsUrl, depsHash } = await readPostBuildCacheUrls({
        ctx,
        setup,
        contentHash,
        lockfileHash,
        targetPlatform,
        targetArch,
      }));
    }
  } else if (sourceHit && contentHash && deps.sourceCache) {
    sourceTarUrl = (await deps.sourceCache.getUrl(contentHash)) ?? undefined;
    sourceTarHash = contentHash;
  }

  if (depHit && lockfileHash && deps.depCache) {
    const depResult = await deps.depCache.getUrlAndHash(lockfileHash, targetPlatform, targetArch);
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
    sourceTarHash,
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
  const { deps, workflow, runId, resolvedOrgId } = ctx;
  let resolvedSecrets: Record<string, string> | undefined;
  let resolvedNamespacedSecrets: Record<string, Record<string, string>> | undefined;
  const declaredContexts = workflow.contexts ?? [];

  if (declaredContexts.length > 0) {
    if (!deps.secretResolver) {
      const reason =
        'Workflow declares secret contexts but secrets subsystem is not configured (KICI_SECRET_KEY missing)';
      logger.error(reason, {
        workflow: workflow.name,
        contexts: declaredContexts,
      });
      return { skipDispatch: true, reason };
    }
    try {
      const mergedSecrets: Record<string, string> = {};
      const mergedNamespaced: Record<string, Record<string, string>> = {};
      for (const envName of declaredContexts) {
        const envSecrets = await deps.secretResolver.resolveForJob(resolvedOrgId, envName);
        Object.assign(mergedSecrets, envSecrets);
        mergedNamespaced[envName] = envSecrets;
      }
      if (Object.keys(mergedSecrets).length > 0) {
        resolvedSecrets = mergedSecrets;
        resolvedNamespacedSecrets = mergedNamespaced;
      }
    } catch (err: unknown) {
      const errMessage = toErrorMessage(err);
      logger.error('Secret resolution failed, skipping workflow', {
        workflow: workflow.name,
        error: errMessage,
      });
      return {
        skipDispatch: true,
        reason: `Secret resolution failed: ${errMessage}`,
      };
    }
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
    resolvedSecrets,
    resolvedNamespacedSecrets,
    declaredContexts,
    runPublicKeyBase64,
    npmRegistries: undefined,
    installEnvSecrets: undefined,
  };
}

// ---------------------------------------------------------------------------
// Phase C2 — workflow-level install auth (private npm registries + installEnv)
// ---------------------------------------------------------------------------

/**
 * Resolve the workflow's `registries:` and `installEnv:` declarations into
 * per-dispatch fields. Fires per-context protection rules, looks up
 * each `<env>:<secret>` reference via the secret resolver, validates registry
 * URL schemes, and applies the contributor-trust strip.
 *
 * Returns a `skipDispatch` sentinel when the helper rejects the dispatch
 * (malformed ref, missing env, missing secret, gate non-pass, bad URL
 * scheme). On accept, mutates `secrets.npmRegistries` /
 * `secrets.installEnvSecrets` so downstream phases pick them up.
 */
/** A workflow install gate that paused dispatch — surfaced to the caller. */
interface InstallGateHold {
  action: 'hold' | 'wait' | 'queue';
  envName: string;
  contextId: string;
  holdType: string;
  queueType: 'context' | 'security';
  requirement: ApprovalRequirement;
}

async function resolveWorkflowInstallSecrets(
  ctx: WorkflowDispatchContext,
  secrets: SecretBundle,
  skipProtectionGate: boolean,
): Promise<
  | { skipDispatch: true; reason: string }
  | { skipDispatch: false }
  | { held: true; hold: InstallGateHold }
> {
  const { deps, workflow, runId, resolvedOrgId, repoIdentifier, event, trustResolution } = ctx;
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
    branch: event.targetBranch,
    triggerType: event.type,
    repository: repoIdentifier,
    runId,
    // Workflow-level install has no per-job id; surface a deterministic
    // synthetic id so audit logs make the workflow scope visible.
    jobId: installGateJobId(workflow.name),
    internallyTriggered: ctx.internallyTriggered === true,
  };

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
  });

  if (result.decision === 'hold') {
    logger.info('Workflow install gate held dispatch', {
      runId,
      workflow: workflow.name,
      action: result.action,
      env: result.envName,
      holdType: result.holdType,
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

/**
 * Build the deferred init job for jobs with dynamic fields.
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
  const initJobInput: QueuedJobInput = {
    runId,
    workflowName: workflow.name,
    jobName: initJobName,
    runsOnLabels: [
      INIT_RUNNER_ROLE_LABEL,
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig: {
      initOnly: true,
      // The init job resolves dynamic fields against the BASE job definition in
      // source; for a dynamic matrix the base name is what findJobByName needs.
      targetJobName: mat.baseName,
      // A non-global workflow's `filter` gets no eval round of its own — the
      // init job evaluates it before this job's dynamic fields, and a `false`
      // verdict suppresses the dispatch. Omitted (never `false`) when the
      // workflow declares none, matching how the lock file records it.
      ...(workflow.hasFilter === true && { hasFilter: true }),
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
    },
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarHash: buildPrep.contentHash || undefined,
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
  };
  return { mat, initJobInput };
}

/**
 * Read the org's configured approval-hold expiry (seconds), falling back to the
 * cluster default of 24h when the org row or column is absent.
 */
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
 * Union the explicit lock approval clauses with the context reviewer
 * clauses into a single AND list (deduped). Every set must be satisfied.
 *
 * `workflowApproval` is the workflow-level `requireApproval`, which the caller
 * passes only for a root job — the only kind `applyStaticApprovalHolds` ever
 * holds under a workflow-scoped requirement. It has no default: the parameter
 * is required so a future call site cannot silently drop the source.
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
 * Build a workflow-scoped hold from the lock workflow's `approval` block. The
 * gate holds the workflow's root jobs (those with no `needs`) before any job
 * dispatches; downstream jobs are gated by their `needs` edges. Each held root
 * job carries this same requirement and re-dispatches on approval.
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
 * Scan a lock workflow's always-mode approval timeouts (workflow-level +
 * each static job) for a non-positive / non-finite `timeoutSeconds`. Returns the
 * first offender or null. Step-scope approvals ride the validated
 * `step.approval-request` wire schema and are not checked here.
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
 * Build the per-host secret-resolution context for a materialized child. A
 * `runsOnAll` host child carries its identity on `mat.agent` (preferred) or
 * `mat.pinnedAgentId`/`mat.host`; a non-host child (matrix/static) has none, so
 * resolution stays fleet-wide (`'**'`-only). Returns `undefined` when there are
 * no host facts to scope by.
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
 * Apply per-job context data: protection rules, hold creation, context
 * variables, and per-job secret resolution. Mutates `jobEnvData` in place.
 */
/**
 * User-facing warning naming bound contexts that cannot participate in a
 * test run — non-test (`allowLocalExecution=false`) or unconfigured — plus which
 * test-allowed contexts (if any) the job runs with instead.
 */
function formatTestRunUnavailableEnvWarning(unavailable: string[], remaining: string[]): string {
  const names = unavailable.map((n) => `'${n}'`).join(', ');
  const tail = remaining.length
    ? `running with ${remaining.map((n) => `'${n}'`).join(', ')}`
    : 'running with no context variables';
  return `bound context(s) ${names} are unavailable for this test run and were skipped; ${tail}`;
}

/**
 * Mint the two approval holds that are decided by the LOCK FILE alone — the
 * job's own `requireApproval` and the workflow-level one on a root job.
 *
 * Kept separate from {@link applyContextRulesAndSecrets} because these two need
 * nothing an agent must compute: they are statically knowable at dispatch, for
 * every job, including one whose dynamic fields defer to an init round. That is
 * the whole point of the split — the dynamic-field deferral sits above the
 * per-job evaluation block, and when these holds lived inside that block a job
 * pairing `requireApproval` with `dynamicEnv` / a dynamic context /
 * `dynamicConcurrencyGroup` / a dynamic matrix dispatched with no gate at all.
 *
 * Both guards on `!jobEnvData.approvalHold`, so a context-driven hold minted
 * earlier wins: it unions the job's own approval clauses AND — on a root job —
 * the workflow's into itself (`unionApprovalClauses`), making it the strictly
 * stronger requirement. Ordering is therefore load-bearing on the static path —
 * call this AFTER the context rules, never before.
 */
async function applyStaticApprovalHolds(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, lockJob, jobEnvData } = args;
  const { deps } = ctx;
  // Explicit SDK requireApproval on a job with no context-driven hold:
  // hold the job with trigger_source='explicit'.
  // An approval this orchestrator cannot enforce must be loud. Without a
  // heldRunStore the job dispatches ungated, which is the same outcome the
  // dynamicJob path already reports as an error rather than dropping silently.
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
  // Workflow-level requireApproval holds the run before any job dispatches:
  // every root job (no `needs`) is held under one workflow-scoped requirement.
  // Downstream jobs are gated by their `needs` edges, so holding the roots
  // holds the whole run.
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
 * Resolve which of a job's bound contexts actually participate in this
 * dispatch, and record the run's context identity on `jobEnvData`.
 *
 * Returns `null` when none participates — every bound name was unconfigured,
 * or a test run skipped them all. The caller then dispatches with the job's own
 * env only: a bound `context:` never rejects on absence.
 *
 * Split out of {@link applyContextRulesAndSecrets} for length only; the
 * sequence is unchanged. The returned entries keep `env` optional because
 * `evaluateMultiContextGates` takes that shape — the caller narrows once, after
 * the reject gates have run.
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

  // Match each bound context by name (in order).
  let matched: Array<{ name: string; env: EngineContext | undefined }> = [];
  for (const name of contextNames) {
    const cfg = await deps.contextStore.matchContext(resolvedOrgId, name);
    matched.push({ name, env: cfg ? toContext(cfg) : undefined });
  }

  // The run's context column / concurrency grouping uses the first declared
  // bound name, even if some bound contexts have no configured record.
  jobEnvData.contextName = contextNames[0];
  // Record the id of the configured env matched for the first declared name —
  // tied to the same name written into the run's `context` column. Captured
  // before the missing/test-skip filtering below, which only governs
  // protection rules / secrets, not history identity.
  jobEnvData.contextId = matched[0]?.env?.id;

  // Lenient missing-context handling: a bound name with no configured record
  // simply does not contribute protection rules / vars (the established
  // single-context behavior). Proactive rejection of a provably-missing
  // context is the deferred registration-time satisfiability check.
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

  // Skip-on-test (allow-and-warn): a test/local run never rejects on a bound
  // context. Bound contexts that cannot participate in a test run —
  // non-test (`allowLocalExecution === false`) or unconfigured (missing above) —
  // are dropped (their vars/secrets and gates do not participate) and named in a
  // single user-visible warning. The fixture `secrets:` gate stays fail-closed;
  // a bound `context:` only warns. If every bound env is unavailable, the
  // job runs with no context vars.
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

  // No configured context participates (all missing and/or test-skipped):
  // dispatch with the job's own env only, no context-scoped vars/secrets.
  if (matched.length === 0) return null;

  return matched;
}

/**
 * Key for the in-pass admission tally.
 *
 * The org id is part of the key so the tally inherits the cross-tenant scoping
 * the running-count query already enforces on `execution_runs.customer_id`: a
 * context name shared across tenants must not leak concurrency between them.
 * One dispatch pass carries a single `resolvedOrgId`, so the org component is a
 * standing invariant rather than a live discriminator — it is here so a future
 * pass dispatching for more than one org cannot silently merge two orgs'
 * tallies. `JSON.stringify` over the pair is used rather than string
 * concatenation so no separator character can make two different pairs collide.
 */
export function concurrencyAdmissionKey(orgId: string, concurrencyGroup: string): string {
  return JSON.stringify([orgId, concurrencyGroup]);
}

/** This dispatch pass's admission tally, created on first use. */
function admissionTally(ctx: WorkflowDispatchContext): Map<string, number> {
  ctx.concurrencyAdmissions ??= new Map();
  return ctx.concurrencyAdmissions;
}

/**
 * Give back a slot an admitted job will never use.
 *
 * The one caller is the dynamic-matrix fan-out: the placeholder is gated before
 * the agent resolves the combinations, and it is then replaced by its children
 * rather than dispatched, so its reservation has to be released before they are
 * gated or a fan-out of N children would consume N+1 slots.
 */
function releaseAdmission(ctx: WorkflowDispatchContext, admissionKey: string): void {
  const admissions = admissionTally(ctx);
  admissions.set(admissionKey, Math.max(0, (admissions.get(admissionKey) ?? 0) - 1));
}

/**
 * Point-in-time count of jobs already RUNNING in a concurrency group, scoped to
 * the dispatching org so a context name shared across tenants does not leak
 * concurrency between them.
 *
 * Read per gated job, not once per pass: the count is per concurrency group, so
 * two jobs in one pass bound to different groups get different answers, and a
 * job from another run can reach `running` at any moment. What it cannot see is
 * what this pass has just admitted — which is why the caller adds the in-pass
 * admission tally to it before evaluating the gate.
 */
async function countRunningJobsInGroup(
  ctx: WorkflowDispatchContext,
  concurrencyGroup: string,
): Promise<number> {
  const { deps, resolvedOrgId } = ctx;
  if (!deps.db) return 0;
  const result = await deps.db
    .selectFrom('execution_jobs')
    .select(deps.db.fn.countAll<number>().as('count'))
    .where('execution_jobs.status', '=', ExecutionJobStatus.enum.running)
    .innerJoin('execution_runs', 'execution_runs.run_id', 'execution_jobs.run_id')
    .where('execution_runs.context', '=', concurrencyGroup)
    .where('execution_runs.customer_id', '=', resolvedOrgId)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

/** The gate-time facts a matrix fan-out replays once per child. */
interface ContextGateInputs {
  /** The aggregated effective context every bound context contributed to. */
  env: EngineContext;
  dispatchCtx: JobDispatchContext;
  effectiveConcurrencyGroup: string;
  trustTier: TrustTier | undefined;
}

/** {@link ContextGateInputs} plus what this job's own evaluation consumed. */
interface ContextGateHandle extends ContextGateInputs {
  /** Tally key this job's admission was counted under. */
  admissionKey: string;
  /** True when the gate PASSED, so this job holds an in-pass slot. */
  admitted: boolean;
}

/**
 * Evaluate one job's admission against its bound contexts' protection rules and
 * record the verdict on `jobEnvData`.
 *
 * Extracted from {@link applyContextRulesAndSecrets} so a dynamic-matrix
 * fan-out can re-evaluate it per child WITHOUT re-running the whole routine —
 * re-running it would re-resolve the context's scoped secrets once per child
 * and emit N identical audit lines for one logical admission. It is also what
 * keeps that function under the 200-line ESLint ceiling.
 *
 * The count fed to the concurrency gate is the DB running count PLUS the
 * siblings already admitted in this dispatch pass — but only for a job that
 * actually dispatches in this pass (`dispatchesThisPass`). The running count
 * cannot see what this pass has just admitted, so without the second term every
 * child of a fan-out is evaluated against the same blind value.
 */
async function applyContextProtectionGates(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  gate: ContextGateInputs;
  jobEnvData: JobEnvData;
  /**
   * Whether this job reaches an agent during THIS dispatch pass, which is what
   * decides if it takes part in the in-pass admission tally.
   *
   * A needs-gated job does not: the dispatch loop stores its pending context and
   * registers it under a `needs-pending-` id, and the needs scheduler dispatches
   * it later. Letting it reserve a slot is not merely conservative — a job the
   * concurrency gate queues takes the hold path, which is evaluated BEFORE the
   * needs branch, so the job never reaches the needs scheduler at all and the
   * queued-hold release path dispatches it with no upstream check. It would then
   * run beside a still-pending upstream, or after a FAILED one.
   *
   * Defaults to `true`: every other call site gates a job it is about to
   * dispatch.
   */
  dispatchesThisPass?: boolean;
}): Promise<ContextGateHandle> {
  const { ctx, lockJob, gate, jobEnvData } = args;
  const dispatchesThisPass = args.dispatchesThisPass ?? true;
  const { deps, runId, workflow, resolvedOrgId } = ctx;
  const { env, dispatchCtx, effectiveConcurrencyGroup, trustTier } = gate;

  const runningCount = await countRunningJobsInGroup(ctx, effectiveConcurrencyGroup);
  // Read the tally and RESERVE this job's slot in one synchronous turn, before
  // the await below. `evaluateProtectionRules` is async, so two dynamic-matrix
  // flow-backs resuming inside that await would otherwise both read the same
  // pre-increment value and both be admitted against one slot. A non-pass
  // verdict releases the reservation immediately after.
  const admissions = admissionTally(ctx);
  const admissionKey = concurrencyAdmissionKey(resolvedOrgId, effectiveConcurrencyGroup);
  const alreadyAdmitted = dispatchesThisPass ? (admissions.get(admissionKey) ?? 0) : 0;
  if (dispatchesThisPass) admissions.set(admissionKey, alreadyAdmitted + 1);

  const gateResult = await evaluateProtectionRules(
    env,
    dispatchCtx,
    runningCount + alreadyAdmitted,
    effectiveConcurrencyGroup,
    trustTier,
  );
  if (dispatchesThisPass && gateResult.action !== 'pass') {
    // Not dispatching, so it holds no slot. Re-read rather than reusing
    // `alreadyAdmitted + 1`: a sibling may have reserved in between, and its
    // reservation must survive this release.
    admissions.set(admissionKey, Math.max(0, (admissions.get(admissionKey) ?? 1) - 1));
  }
  const handle: ContextGateHandle = {
    ...gate,
    admissionKey,
    // A job that took no part in the tally holds no slot, so a later
    // `releaseAdmission` on its handle must not give one back.
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
    // An approval hold (reviewer gate) defers hold creation to the dispatch
    // loop so the resume path can store the job's dispatch context. Security /
    // wait / queue holds keep the legacy immediate-create behaviour.
    if (deps.heldRunStore && isApprovalHold) {
      // This hold REPLACES whatever `applyStaticApprovalHolds` would have
      // minted (both its branches are guarded on `!approvalHold`), so it must
      // carry every source that would otherwise have gated the job. The
      // workflow-level gate holds root jobs only — downstream jobs are gated by
      // their `needs` edges — so a non-root job's clause set stays untouched.
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
      // Carried, not written here: `holdJobForApproval` writes it together with
      // the job's pending dispatch context so a hold can never exist without a
      // resume path.
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
    // The pending `KiCI Security` check of a security-typed hold is NOT posted
    // here. Nothing has written a `held_runs` row yet, and every route that
    // settles that check reaches it through one — so a post here that the row
    // write never followed (no store, no database, a rolled-back transaction)
    // would strand a pending check that nothing can ever terminalize. It is
    // posted by `holdJobForApproval`, after the row and the resume context land
    // in one transaction.
  }
  return handle;
}

/**
 * Resolve a job's bound contexts, run their protection gates, and — when the
 * job is admitted — resolve the contexts' variables and scoped secrets onto its
 * `jobEnvData`.
 *
 * Returns the {@link ContextGateHandle} a dynamic-matrix fan-out re-gates each
 * child with, or `undefined` when no gate ran (no context store, no
 * participating context, or a hard multi-context rejection).
 */
async function applyContextRulesAndSecrets(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  /**
   * The materialized job's expanded name — what `held_runs.job_id` carries for
   * a hold this function creates. `lockJob.name` must NOT be used: every child
   * of a matrix job shares it, so sibling holds would be indistinguishable.
   */
  expandedName: string;
  contextNames: readonly string[];
  concurrencyGroup: string | undefined;
  jobEnvData: JobEnvData;
  hostCtx?: HostFacts;
  /**
   * Whether this job reaches an agent during THIS dispatch pass. Forwarded to
   * {@link applyContextProtectionGates}, which documents why a needs-gated job
   * must stay out of the in-pass admission tally. Defaults to `true`.
   */
  dispatchesThisPass?: boolean;
}): Promise<ContextGateHandle | undefined> {
  const { ctx, lockJob, expandedName, contextNames, concurrencyGroup, jobEnvData, hostCtx } = args;
  const { deps, repoIdentifier, event, runId, workflow, resolvedOrgId } = ctx;
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

  // Every reader of `held_runs.job_id` resolves it as the job name: the
  // dashboard approval queue, `kici approve --job`, and the MCP approve/reject
  // tools. Store the expanded name so those surfaces can name and target the
  // held job.
  const jobId = expandedName;
  const dispatchCtx: JobDispatchContext = {
    branch: event.targetBranch,
    triggerType: event.type,
    repository: repoIdentifier,
    runId,
    jobId,
    internallyTriggered: ctx.internallyTriggered === true,
  };

  // All-must-pass hard reject gates (enabled/branch/trigger/repo) across every
  // configured bound context. When any rejects, the run is rejected with a
  // reason naming the offending context and rule.
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

  // Every remaining bound context is configured and passed the reject gates.
  const present = matched.map((m) => ({ name: m.name, env: m.env as EngineContext }));
  // The configured primary context drives the merged-data resolution below.
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
    },
    jobEnvData,
    ...(args.dispatchesThisPass !== undefined && {
      dispatchesThisPass: args.dispatchesThisPass,
    }),
  });

  if (!jobEnvData.rejected && !jobEnvData.held) {
    try {
      const merged = await resolveMultiEnvMergedData({
        deps: { variableStore: deps.variableStore, secretResolver: deps.secretResolver },
        orgId: resolvedOrgId,
        entries: present,
        hostCtx,
        routingKey: ctx.info.routingKey,
      });
      if (merged.contextVars) jobEnvData.contextVars = merged.contextVars;
      if (merged.jobSecrets) jobEnvData.jobSecrets = merged.jobSecrets;
      if (merged.jobNamespacedSecrets)
        jobEnvData.jobNamespacedSecrets = merged.jobNamespacedSecrets;

      // Private-registry credentials for the job's container image. Resolved
      // HERE, orchestrator-side: the lock carries `<context>:<secret-name>`
      // references and the agent never resolves a secret itself. The reference
      // names its own context, so it is looked up directly rather than through
      // the job's bound contexts — the same rule `gitCredentials` follows.
      const resolver = deps.secretResolver;
      if (resolver && lockJob.container && typeof lockJob.container === 'object') {
        // The AUTH resolver, not the spawn resolver: a job that builds its
        // image has no spawn (the image does not exist yet) but still needs
        // credentials for the Dockerfile's own `FROM` base.
        jobEnvData.containerRegistryAuth = await resolveContainerRegistryAuth(lockJob.container, {
          resolveSecret: async (ref) => {
            const idx = ref.indexOf(':');
            if (idx <= 0) return undefined;
            return (
              (await resolver.resolveNamed(resolvedOrgId, ref.slice(0, idx), ref.slice(idx + 1))) ??
              undefined
            );
          },
        });
      }
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

  return gateHandle;
}

/**
 * Phase D — evaluate static jobs' context data, queue deferred-init jobs
 * for jobs with dynamic fields, and pick the first `runContextName` for
 * the run.
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
    const { names: contextNames, needsInit: envNeedsInit } = resolveJobContextNames(lockJob);
    // Ordered display list persisted on the job row (placeholder for unresolved
    // dynamic elements; the deferred-init flow-back overwrites it once resolved).
    const displayEnvNames = buildJobContextDisplayNames(lockJob);
    if (displayEnvNames.length > 0) jobEnvData.contextNames = displayEnvNames;
    // A dynamic field cannot be evaluated here AT ALL — its value is only known
    // once the agent has run the workflow module — so the whole per-job block
    // below is skipped and the init result drives it instead.
    const needsInit =
      envNeedsInit ||
      lockJob.dynamicEnv === true ||
      lockJob.dynamicConcurrencyGroup === true ||
      // A dynamic matrix is resolved by the same agent-eval init flow: the agent
      // runs the matrix fn, returns the combinations, and the init-result path
      // re-materializes N children at dispatch.
      mat.pendingDynamicMatrix === true;

    if (needsInit && deps.pendingInits) {
      // Approval is decided by the lock file, not by the init round — but it is
      // minted in the FLOW-BACK, not here. Setting `held` before the round would
      // make `applyContextRulesAndSecrets` skip its own final block (guarded on
      // `!held`), so the job's context vars, secrets and registry auth would
      // never resolve and the stored input the release path dispatches would be
      // missing them. The documented ordering — context rules first, static
      // holds after — has to hold on this path too.
      //
      // Nothing between here and the flow-back reads `held`: the dispatch loop
      // and the peer filter both exclude a `pendingInit` job first.
      jobEnvData.pendingInit = true;
      deferredInitJobs.push(buildDeferredInitJob({ ctx, setup, buildPrep, mat }));
      jobContextData.set(mat.expandedName, jobEnvData);
      continue;
    }

    const jobEnv: Record<string, string> | undefined =
      lockJob.dynamicEnv || isLockInlineValue(lockJob.env) ? undefined : lockJob.env;
    const concurrencyGroup: string | undefined =
      lockJob.dynamicConcurrencyGroup || typeof lockJob.concurrencyGroup !== 'string'
        ? undefined
        : lockJob.concurrencyGroup;

    if (jobEnv) jobEnvData.jobEnv = jobEnv;
    if (contextNames.length > 0) {
      // Run the matcher first so jobEnvData.contextId is populated, then
      // capture the run-level name + id from the first env-bearing job.
      await applyContextRulesAndSecrets({
        ctx,
        lockJob,
        expandedName: mat.expandedName,
        contextNames,
        concurrencyGroup,
        jobEnvData,
        hostCtx: hostCtxFromMat(mat),
        // A needs-gated job does not dispatch from this pass — the loop below
        // stores its pending context and the needs scheduler dispatches it
        // later — so it takes no in-pass slot.
        dispatchesThisPass: isRootJob(lockJob),
      });
      if (!runContextName) {
        runContextName = contextNames[0];
        runContextId = jobEnvData.contextId;
      }
    }
    await applyStaticApprovalHolds({ ctx, lockJob, jobEnvData });
    // A workflow-level `filter` defers only the DISPATCH — never the evaluation
    // above. Everything a job gets without a filter (its bound contexts, their
    // vars and scoped secrets, the context rules that can reject it, and its
    // approval hold) it still gets with one; the init job just decides whether
    // the dispatch happens. Reusing the dynamic-field `continue` here is what
    // made declaring a filter silently drop all of it.
    //
    // A rejected or held job needs no verdict: it is not dispatching from here
    // either way, and giving it an init job would let the flow-back dispatch it
    // past the very hold that stopped it. The consequence is that a held job's
    // filter is never evaluated — approval, not the filter, is its gate.
    if (
      workflow.hasFilter === true &&
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
 * Resolve every static job's `sandbox:` escape-hatch request against the org
 * allow-list. Deny is loud + total: the first non-allow-listed request returns
 * `{ denied }` (the caller fails the whole run) — a disallowed capability is
 * never silently stripped and run. Jobs with no request, or a non-escalating
 * one, contribute no grant. The agent applies only the returned grants and never
 * reads the allow-list.
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

/**
 * Read the org's Dockerfile-build opt-in, defaulting to DENY.
 *
 * Deny on a read failure, not allow: an unreadable setting must not widen what
 * an untrusted ref may do.
 */
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
 * Refuse a Dockerfile build on an untrusted ref, unless the org opted in.
 *
 * A job may build its container image from a Dockerfile in the repository. That
 * build runs arbitrary `RUN` commands on the agent host's daemon, OUTSIDE the
 * hardened posture the job's own steps get — `docker build` cannot be
 * capability-restricted the way a container run can. So an untrusted ref (a fork
 * PR, an unresolved contributor, or an internally-triggered run without a
 * trusted emitter — the same classification the user-cache write scope uses)
 * reaches it only where the operator said so.
 *
 * "Without a trusted emitter" covers both halves of the internal case: a
 * `kiciEvent()` subscriber that inherited a `known` / `unknown` tier, and one
 * that inherited nothing at all (no emitting run, no persisted tier, a lookup
 * that failed) — the strict fallback, which is not an "untrusted emitter".
 *
 * Enforced here, at dispatch, and nowhere else: the agent applies only what
 * dispatch authorized, exactly as it does for the sandbox capability grant. Deny
 * is loud and total — the build never starts.
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
  resolvedSecrets: Record<string, string> | undefined;
  resolvedNamespacedSecrets: Record<string, Record<string, string>> | undefined;
  runPublicKeyBase64: string | undefined;
  npmRegistries: NpmRegistrySpec[] | undefined;
  installEnvSecrets: Record<string, string> | undefined;
  event: SimulatedEvent;
  /**
   * Verbatim `jobConfig.event` envelope, when the caller states one. See
   * `WorkflowDispatchContext.eventEnvelopeOverride`.
   */
  eventEnvelopeOverride: Record<string, unknown> | undefined;
  /** Org id that owns the run — namespaces the user-facing cache. */
  cacheOrgId: string;
  /** Repo identifier (e.g. "owner/repo") — second user-cache namespacing level. */
  cacheRepoId: string;
  /** User-cache write scope for this dispatch (trusted => shared, else isolated). */
  cacheRefScope: CacheRefScope;
  /**
   * True for test runs (`kici run`), which ship the workflow body as a
   * working-tree overlay that may differ from the committed lock. Omitting
   * `contentHash` tells the agent to skip the lock-vs-source hash check so the
   * overlaid (uncommitted) source is accepted.
   */
  omitContentHash: boolean;
  /**
   * Run-wide flat secrets layered onto every job's secrets, UNDER the per-job
   * env-resolved set so the run-wide value wins on collision (the test path's
   * CLI `--secret` / `--env` flat secrets). Undefined for webhook runs.
   */
  runWideFlatSecrets: Record<string, string> | undefined;
  /**
   * Resolved (coerced + defaulted) workflow-dispatch inputs from `kici run
   * --input`, stamped onto every job's config so the agent exposes them as
   * `ctx.dispatchInputs`. Undefined for webhook runs.
   */
  dispatchInputs: Record<string, unknown> | undefined;
  /**
   * Dispatch-resolved per-job sandbox escape-hatch grants, keyed by lock-job
   * name. Populated only for jobs whose `sandbox:` request the orchestrator
   * authorized against the org allow-list (a denied request fails the run before
   * this builder runs). Absent key ⇒ no grant ⇒ default hardened posture.
   */
  resolvedSandboxGrants: ReadonlyMap<string, ResolvedSandboxGrant>;
}): BuildJobConfigFn {
  const {
    workflow,
    fullLockFile,
    jobContextData,
    resolvedSecrets,
    resolvedNamespacedSecrets,
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
    // Run-wide CLI flat secrets are spread LAST so they win on a key collision
    // with the per-job env-resolved set, and so they reach an env-less job too.
    const mergedSecrets = {
      ...resolvedSecrets,
      ...(envData?.jobSecrets ?? {}),
      ...(runWideFlatSecrets ?? {}),
    };
    const mergedNamespaced = {
      ...resolvedNamespacedSecrets,
      ...(envData?.jobNamespacedSecrets ?? {}),
    };
    const hasSecrets = Object.keys(mergedSecrets).length > 0;
    const hasNamespaced = Object.keys(mergedNamespaced).length > 0;
    return {
      source: workflow.source ?? fullLockFile.source,
      workflowName: workflow.name,
      // The expanded child name is the job identity for reporting + log labels;
      // the agent exposes the BASE name on ctx.job.name (via baseJobName) and the
      // combination only via ctx.matrix.
      name: mat.expandedName,
      baseJobName: mat.baseName,
      ...(mat.variantValues && { matrixValues: mat.variantValues }),
      // Operator dispatch inputs (run-scoped, identical for every job).
      ...(dispatchInputs && { dispatchInputs }),
      // Host fan-out: expose the per-host identity as ctx.host / ctx.agent.
      ...(mat.host && { host: mat.host }),
      ...(mat.agent && {
        agent: {
          host: mat.agent.host,
          labels: [...mat.agent.labels],
          ...(mat.agent.platform && { platform: mat.agent.platform }),
          ...(mat.agent.arch && { arch: mat.agent.arch }),
        },
      }),
      // Fan-out position: expose the deterministic ordinal as ctx.fanout.
      ...fanoutEnvelopeFields(mat),
      // Single-agent selection policy (read by the dispatcher at selection time;
      // the agent ignores it). Defaults to deterministic when the lock omits it.
      ...(lockJob.runsOnPick && { runsOnPick: lockJob.runsOnPick }),
      steps: lockJob.steps,
      needs: lockJob.needs,
      rules: lockJob.rules,
      // The job's container image selects the container execution backend on the
      // agent (determineExecutionMode gives jobConfig.container top priority), so
      // it must survive dispatch or a container:-field job silently runs bare-metal.
      ...(lockJob.container && { container: lockJob.container }),
      // The dispatch-resolved sandbox escape-hatch grant (allow-listed here, the
      // single enforcement point). The agent applies only this resolved grant and
      // never reads the allow-list. Absent ⇒ default hardened posture.
      ...(resolvedSandboxGrants.get(lockJob.name) && {
        sandboxGrant: resolvedSandboxGrants.get(lockJob.name),
      }),
      ...(workflow.contentHash && !omitContentHash && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
      ...(hasSecrets && { secrets: mergedSecrets }),
      ...(hasNamespaced && { namespacedSecrets: mergedNamespaced }),
      ...(runPublicKeyBase64 && { runPublicKey: runPublicKeyBase64 }),
      ...(npmRegistries && npmRegistries.length > 0 && { npmRegistries }),
      ...(installEnvSecrets && Object.keys(installEnvSecrets).length > 0 && { installEnvSecrets }),
      ...(envData?.contextName && { context: envData.contextName }),
      ...(envData?.containerRegistryAuth && {
        containerRegistryAuth: envData.containerRegistryAuth,
      }),
      ...(envData?.contextVars && { contextVars: envData.contextVars }),
      ...(envData?.jobEnv && { jobEnv: envData.jobEnv }),
      ...(lockJob.resources && { resources: lockJob.resources }),
      // Job-level wall-clock timeout (ms). The agent reads jobConfig.timeout in
      // buildRequest → request.jobTimeoutMs to arm the job deadline.
      ...(lockJob.timeout !== undefined && { timeout: lockJob.timeout }),
      // User-facing cache namespacing — carried through the dispatch so the
      // agent-WS handler can resolve the org/repo/scope of a cache request
      // from the tracked dispatch (never from the agent's wire message).
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

/**
 * Build the QueuedJobInput for an execution job (used by both cluster and
 * single-orch paths).
 */
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
    // Bake ctx.extraJobConfig into the job's config so a needs-gated / wave-held
    // child carries it too: gated children are stored as a pending context and
    // re-dispatched later by the needs scheduler through the base dispatcher,
    // which does NOT re-apply the dispatcher wrapper's extraJobConfig merge.
    // Without this, a test run's overlay/`fullRepo` provenance would be lost on
    // the downstream and the agent would try to clone an empty repoUrl.
    jobConfig: { ...buildJobConfig(mat), ...ctx.extraJobConfig },
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarHash: buildPrep.sourceTarHash,
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
    requestId: getRequestContext().requestId,
    ...(lockJob.resources && { resources: lockJob.resources }),
    // Host fan-out: pin this child to its resolved agent (+ the cross-cluster
    // reroute hint). The dispatcher routes it only to that agent.
    ...(mat.pinnedAgentId && { pinnedAgentId: mat.pinnedAgentId }),
    ...(mat.connectedInstanceId !== undefined && {
      connectedInstanceId: mat.connectedInstanceId,
    }),
  };
}

/**
 * Post the pending `KiCI Security` status, and record on every hold that gates
 * this commit's check that the commit now carries it.
 *
 * The record is what a settle reads to decide whether a hold has a check to
 * terminalize. Deriving that from the row's shape instead answers what the code
 * INTENDED, and `postCheckStatus` CREATES the named run when it finds none — so
 * a post the provider refused left a shape saying "posted" and a settle that
 * put a completed `KiCI Security` run on a commit which never had one.
 *
 * `heldRunIds` is plural because the commit carries ONE check run: a job held on
 * two independent requirements has both of them gating it, and marking only the
 * one whose summary was rendered would let the first to end resolve a check the
 * other is still gating.
 *
 * Awaited, where the post used to be fire-and-forget: the record can only be
 * written once the provider has accepted, and a record racing the settle is a
 * record the settle may not see. A failed post is still swallowed — the dispatch
 * loop is never blocked by a provider error — but the round-trip is now
 * serial and inside the per-job loop, so N held jobs cost N of them.
 *
 * On success and then a failed record the commit keeps a pending check the
 * settle will decline to close. That is the residue the fire-and-forget post
 * could already leave, now narrowed to whatever can fail between the accepted
 * post and ONE statement. The record is therefore retried
 * {@link PENDING_CHECK_MARK_ATTEMPTS} times before it is given up on, which
 * closes the half of that window the doc above names as reachable without a
 * process dying — a lost connection, a statement timeout, a deadlock. What is
 * left is a process death inside the retry window, and nothing in reach closes
 * that: a sweeper would have to ask the provider whether the check exists, and
 * `CheckStatusPoster` has no read method. Adding one means a new method on a
 * compat-protected engine interface, every implementation and every hand-built
 * bundle, to recover a window measured in milliseconds — against a recovery
 * that already exists, since pushing a new commit re-posts. A sweeper without
 * that read could only guess, and a wrong guess FABRICATES a check, which is
 * the worse direction either way: a fabricated failing check on a pull request
 * is worse than a stuck one.
 *
 * The record is one statement over every id, never one per id. A partial mark
 * would leave an unmarked hold uncounted by the contention query, so the first
 * hold to end would terminalize the shared check while the other still gates
 * the job — a fabricated PASSING check, the worse direction, and reachable
 * without any process dying. See `markPendingCheckPosted`.
 */
/**
 * How many times {@link postPendingHoldCheck} tries to record an accepted post
 * on the hold rows before giving up and leaving the check unclosable.
 */
export const PENDING_CHECK_MARK_ATTEMPTS = 3;
/** Backoff between mark attempts, multiplied by the attempt number. */
const PENDING_CHECK_MARK_RETRY_BASE_MS = 25;

async function postPendingHoldCheck(args: {
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
        // Names the consequence: a give-up leaves a pending check on the commit
        // that no settle will close, recoverable only by a new commit.
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
 * Hold a job awaiting approval: create the `held_runs` row (with the resolved
 * `ApprovalRequirement`) and persist the job's dispatch context so `release()`
 * can re-dispatch it through `dispatchReadyJob` after approval. A job with no
 * `approvalHold` (legacy security / wait / queue holds whose row was created
 * eagerly) just logs and stays held.
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
  const lockJob = mat.lockJob;
  const { deps, workflow, runId } = ctx;
  const selectors = runsOnSelectorsForLockJob(lockJob);
  const runsOnLabels = selectors.runsOnLabels;
  const hold = envData.approvalHold;
  const nonApproval = envData.nonApprovalHold;
  // `approvalHold` no longer gates whether a resume path is persisted — it only
  // selects which store method writes the row. A hold with no resume path is
  // what let a wait-timer / concurrency / trust gate drop its job: the job was
  // registered nowhere, so `isRunComplete` (which iterates only registered jobs)
  // could pass without it whenever a sibling job dispatched, and a single-job
  // run instead took the `dispatchedJobs.length === 0` init-failure branch and
  // failed with a misleading "no jobs were dispatched".
  if ((!hold && !nonApproval) || !deps.heldRunStore || !deps.db) {
    logger.info('Job held by protection rules (not persisted — no hold data or no store)', {
      runId,
      workflow: workflow.name,
      job: mat.expandedName,
    });
    return;
  }

  const jobInput = buildExecutionJobInput({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    mat,
    selectors,
  });

  // The held_runs row keys the resume by (run_id, job_id) where job_id is the
  // expanded job *name* — release() consumes the pending context by the same name.
  //
  // The rows and the pending context are written TOGETHER. Serially, every order
  // has an unacceptable failure: row-first can leave a hold nothing can resume,
  // and context-first can leave a registered job nothing can release (a
  // permanently stuck run). A rollback leaves the job as if the hold had never
  // been attempted.
  //
  // BOTH rows when the job carries both, because they are two independent
  // requirements and a job gated by two must satisfy both to run. The gate that
  // enforces that is `dispatchReadyJob`'s `hasPendingHold`, which refuses while
  // ANY pending row names this (run_id, job_id) — so releasing one leaves the
  // other still gating, and the resume only proceeds once neither is pending.
  // Writing only the reviewer row did not merely lose a record: the trust gate
  // was then unenforced, and the reviewer hold releases on `contexts:write`
  // plus clause eligibility where the trust hold required `ci_trust:write` —
  // a lower permission releasing a job the security gate held.
  const heldRows = await deps.db.transaction().execute(async (trx) => {
    const rows: { row: HeldRun; scope: string; triggerSource: string; holdType?: string }[] = [];
    if (hold) {
      rows.push({
        row: await deps.heldRunStore!.createHold(
          ctx.resolvedOrgId,
          {
            runId,
            jobId: mat.expandedName,
            scope: hold.scope,
            triggerSource: hold.triggerSource,
            requirement: hold.requirement,
            contextId: hold.contextId,
            queueType: hold.queueType,
          },
          // The transaction, explicitly: the store's own connection is not
          // enrolled in it, so an insert left on the default executor commits
          // whatever the context write beside it does.
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
    await storePendingJobContext(trx, runId, mat.expandedName, { jobInput, runsOnLabels });
    return rows;
  });
  // Audit each hold creation. The orchestrator's dispatch subsystem creates the
  // hold automatically in response to a webhook (no Keycloak user context), so
  // the actor is the dispatcher system component. One entry per row: a hold an
  // operator can be asked to approve, with no audit trail saying it was raised,
  // is a gap regardless of what else was raised alongside it.
  for (const written of heldRows) {
    void deps.accessLogWriter?.record({
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
        jobId: mat.expandedName,
        holdScope: written.scope,
        triggerSource: written.triggerSource,
        holdType: written.holdType,
      },
    });
  }
  // Register a synthetic placeholder so the run is not considered complete
  // while the job awaits approval. Uses the same `needs-pending-` prefix as the
  // needs scheduler so release() can resume through dispatchReadyJob, which
  // swaps this placeholder for the real dispatched job id.
  const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
  dispatchedJobs.push({
    jobId: syntheticId,
    jobName: mat.expandedName,
    ...(mat.variantValues && { matrixValues: mat.variantValues }),
    // A held matrix / host child keeps its variant identity. Without these the
    // row carries a null `base_job_name`, which the rolling-wave scheduler keys
    // on — so the wave would never fire for a child that was held.
    ...variantTrackingFields(mat),
    runsOnLabels,
  });

  logger.info(hold ? 'Job held for approval' : 'Job held by a context protection gate', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
    scope: hold?.scope ?? HoldScope.enum.job,
    triggerSource: hold?.triggerSource ?? TriggerSource.enum.context,
    ...(hold
      ? { clauses: hold.requirement.clauses.length }
      : { holdType: nonApproval?.holdType, reason: nonApproval?.reason }),
  });

  // The ids that own the one `KiCI Security` check posted below. Every row this
  // job wrote, not just the one whose summary is rendered: the commit carries a
  // SINGLE check run, so a job holding on two requirements has both of them
  // gating that one check. Marking only the rendered row would let the first
  // hold to end terminalize the check — `success`, on an approve — while the
  // other still gates the job, which is the "branch protection goes green over
  // held work" hazard the contention query exists to prevent.
  const heldRunIds = heldRows.map((written) => written.row.id);

  // Surface the pending approval on the provider's commit check, naming the
  // clauses an approver must satisfy. Step-level holds run inside the agent, so
  // this stays at job granularity. A failed check post is logged and swallowed:
  // it must not block the dispatch loop.
  // Reviewer holds only: the check description names the clauses an approver
  // must satisfy, and a wait-timer / concurrency / trust hold has none. Posting
  // "awaiting approval" for one would tell a reader to go approve something no
  // approval releases.
  if (hold && ctx.bundle?.checkStatusPoster) {
    // A reviewer hold resumes: its pending dispatch context was written above,
    // in the same transaction as the `held_runs` row, so approval re-dispatches
    // the job under this run's own trust resolution. The note names what that
    // resumed job will not have.
    const postureNote = buildReducedPrivilegeNote(ctx.trustResolution?.tier, ctx.lockFileSource);
    // The second gate, when there is one. Both holds were written above and both
    // must be released, but the commit carries one check run — so a description
    // naming only the approval clauses leaves the approver approving, nothing
    // running, and the text unchanged. It has to say what else is outstanding
    // and who clears it.
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
      logContext: { runId, job: mat.expandedName },
      postFailureMessage: 'Failed to post approval hold check',
    });
  }

  // The per-env context gate's own security hold posts here rather than at the
  // gate, for the same reason the reviewer post above does: every route that
  // terminalizes a `KiCI Security` check reaches it through the `held_runs`
  // row, so a pending post the row write never followed is a check nothing can
  // ever settle — a permanent branch-protection blocker on the commit. Posting
  // after the transaction costs the contributor the transaction's own duration
  // before the check appears, and buys back the case where it would never go
  // away.
  //
  // `else if`, because the two are not exclusive: a job pairing `requireApproval`
  // with a security-typed context gate carries BOTH `approvalHold` and
  // `nonApprovalHold` — the gate mints one, and `applyStaticApprovalHolds` runs
  // after it and mints the other on a `!approvalHold` guard alone. Both holds
  // are written and both gate the job, but the commit has ONE `KiCI Security`
  // check run, so two posts wrote the same run back to back and which summary a
  // contributor read was a race. The reviewer copy is rendered because it names
  // concrete clauses a human can act on; both rows own the check either way,
  // through `heldRunIds` above.
  else if (nonApproval?.holdType === HoldType.enum.security && ctx.bundle?.checkStatusPoster) {
    // The reduced-privilege note belongs here: the transaction above wrote this
    // hold's pending dispatch context under the job's expanded name, and
    // `/kici approve` re-dispatches it through `dispatchReadyJob` under the same
    // unresolved-or-untrusted tier — so the run really does execute with the
    // reductions the note names.
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
      logContext: { runId, job: mat.expandedName },
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
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, needsGatedJobs, dispatchedJobs } = args;
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
    await storePendingJobContext(deps.db, runId, gated.expandedName, { jobInput, runsOnLabels });
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

  // expandedName -> combination values, so the route-result pushes (keyed only by
  // jobName) can re-attach matrixValues to the dispatched job rows.
  const matrixByName = new Map<string, Record<string, unknown>>();
  for (const mj of rootDispatchableJobs) {
    if (mj.variantValues) matrixByName.set(mj.expandedName, mj.variantValues);
  }

  if (rootDispatchableJobs.length === 0) {
    logger.info('All dispatchable jobs deferred or needs-gated, skipping coordinator routing', {
      runId,
      workflow: workflow.name,
      needsGated: needsGatedCount,
    });
    return;
  }

  const cloneToken = await mintCloneTokenForReroute({
    bundle,
    repoIdentifier,
    credentials,
    runId,
    workflowName: workflow.name,
  });
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
    ...(cloneToken && { cloneToken }),
  };
  const jobsToRoute: JobToRoute[] = rootDispatchableJobs.map((mj) => {
    const j = mj.lockJob;
    const sel = runsOnSelectorsForLockJob(j);
    return {
      jobName: mj.expandedName,
      runsOnLabels: [sel.runsOnLabels],
      runsOnPatterns: sel.runsOnPatterns,
      excludePatterns: sel.excludePatterns,
      jobConfig: buildJobConfig(mj),
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      sourceTarUrl: buildPrep.sourceTarUrl,
      sourceTarHash: buildPrep.sourceTarHash,
      depsUrl: buildPrep.depsUrl,
      depsHash: buildPrep.depsHash,
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
        sourceTarHash: jtr.sourceTarHash,
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
          runsOnLabels: flatLabels,
        });
        rejectedJobs.push({ jobId: syntheticId, jobName: jtr.jobName, reason: result.reason });
      } else {
        // Tracked like `queued` — see the sibling comment in
        // `dispatchSingleOrchPath`: an untracked queued job is invisible to
        // `isRunComplete` and lets the run finish green without it.
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
      runsOnLabels: flatLabels,
    });
  }
  // Rerouted jobs MUST also feed dispatchedJobs so the downstream
  // onExecutionStarted call writes execution_runs + execution_jobs rows
  // for them. Otherwise the run row never exists on this coord and
  // onPeerJobProgress's recoverRunFromDb returns null for every progress
  // update from the worker, leaving the run permanently in `running`.
  for (const rerouted of routeResult.reroutedJobs) {
    const jtr = jobsToRoute.find((j) => j.jobName === rerouted.jobName);
    const flatLabels = jtr?.runsOnLabels?.[0] ?? [];
    const matrixValues = matrixByName.get(rerouted.jobName);
    dispatchedJobs.push({
      jobId: rerouted.jobId,
      jobName: rerouted.jobName,
      ...(matrixValues && { matrixValues }),
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
 * Register an invoke gate as a pending (needs-gated) job: store its invoke
 * parameters on the pending job context and push a synthetic needs-pending row
 * tagged `job_kind='gate'`. The gate never reaches an agent — it is released
 * through `dispatchReadyJob` (whose gate branch runs the summon executor). A root
 * gate is nudged by `invokeRootGates` after registration; a needs-gated one is
 * released by the scheduler when its upstreams complete.
 */
async function registerPendingInvokeGate(args: {
  ctx: WorkflowDispatchContext;
  mat: MaterializedJob;
  jobInput: QueuedJobInput;
  invokeParams: InvokeGateParams;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, mat, jobInput, invokeParams, dispatchedJobs } = args;
  const { deps, runId, workflow } = ctx;
  await storePendingJobContext(deps.db, runId, mat.expandedName, {
    jobInput,
    runsOnLabels: [],
    invoke: invokeParams,
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
 * Release every root (no-needs) invoke gate once the run, its jobs, and its needs
 * edges are all registered. A root gate has no upstream to fire the scheduler, so
 * it is nudged through the same `dispatchReadyJob` release path a needs-gated gate
 * uses when its upstreams complete. Needs-gated gates are left for the scheduler.
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
 * Register a generated (dynamic) invoke gate. Generated jobs are dispatched after
 * the run is already registered, so a gate is added as a synthetic needs-pending
 * `gate` row plus its pending invoke context; when `release` is true (a root
 * generated gate) it is immediately released through `dispatchReadyJob`, while a
 * needs-gated generated gate waits for the scheduler (its cross-domain needs
 * edges are inserted by the caller).
 */
async function registerGeneratedInvokeGate(args: {
  ctx: WorkflowDispatchContext;
  jobName: string;
  matrixValues?: Record<string, unknown>;
  jobInput: QueuedJobInput;
  invokeParams: InvokeGateParams;
  release: boolean;
}): Promise<void> {
  const { ctx, jobName, matrixValues, jobInput, invokeParams, release } = args;
  const { deps, runId, workflow } = ctx;
  await storePendingJobContext(deps.db, runId, jobName, {
    jobInput,
    runsOnLabels: [],
    invoke: invokeParams,
  });
  const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${jobName}-${randomUUID()}`;
  if (deps.executionTracker) {
    await deps.executionTracker.addJobsToRun(runId, [
      {
        jobId: syntheticId,
        jobName,
        jobKind: JobKind.Gate,
        runsOnLabels: [],
        ...(matrixValues && { matrixValues }),
        ...(invokeParams.timeoutMs !== undefined && { timeoutMs: invokeParams.timeoutMs }),
      },
    ]);
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
 * Record every job a context protection rule rejected as a synthetic
 * `rejected-*` job on the run, carrying the rule's own reason.
 *
 * **Why the job cannot just be skipped.** A rejection used to end at a
 * `logger.info` and a `continue`: the job never entered `rejectedJobs`, so no
 * row, no init-failure signal and no reason reached the run, and the reason
 * survived only in the orchestrator's log. Two things followed, both of them
 * wrong for a reader of the run. A run whose every job was gated fell through
 * to the all-rejected guard as `no_agent` / 'No jobs were dispatched for this
 * run' — telling the reader no agent was available for a run that had agents
 * and was deliberately gated. And a partial rejection recorded nothing at all,
 * leaving a downstream `needs` edge pointing at a job that never terminalizes.
 *
 * Recording it as a synthetic `rejected-*` job is the same shape a dispatcher
 * rejection already takes, and `context_rules` is a job-scoped init-failure
 * category by definition — so the run carries the reason per gated job, the
 * dashboard and `kici runs show` can name the context and rule, and the
 * downstream `when` sets get a terminal upstream to evaluate.
 *
 * Called once for both dispatch paths (the cluster branch filters rejected jobs
 * out of routing, the single-orchestrator loop `continue`s past them), so a
 * rejection is recorded exactly once regardless of which path runs.
 *
 * A `pendingInit` job is deliberately skipped: its context is only named once
 * the agent's init round returns, so its verdict is not final here and the
 * flow-back records it instead ({@link recordContextRuleRejectionAfterInit}).
 * That split is what keeps the record exactly-once — a job cannot be recorded
 * by both, whichever order the two rejection sites are reached in.
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
 * The deferred-init sibling of {@link recordContextRuleRejections}: record a
 * job the context rules rejected during the agent's init round.
 *
 * A dynamically-bound context (`context: (e) => …`) is only named once the
 * agent has run the workflow module, so its gates are evaluated in the
 * flow-back — long after the static collector ran, and long after the run row
 * was written. The reason therefore has no array to land in and is recorded
 * directly on the tracker, the same way the sibling `init-failed-*` row in this
 * file's catch block is.
 *
 * Without this record the run finished GREEN. `__init__` is itself a tracked
 * execution job — the agent reports it `running` then `success`, and the
 * orchestrator forwards every agent job status to the tracker with no init-job
 * filter — so a run whose only real job was gated here still held one terminal
 * job, `isRunComplete` was satisfied, and the last `releasePendingJobsHold`
 * finalized it successfully. That is the same silent-green outcome the static
 * path used to produce, except that this path did not even reach the no-jobs
 * guard: that guard requires `deferredInitJobs.length === 0`, which a deferred
 * job contradicts by definition, so it produced no failed job and not even the
 * misleading `no_agent`.
 *
 * Registration must therefore complete BEFORE the LAST pending-jobs token is
 * dropped, which is why both calls `await` inside the spawned task's own `try`
 * — the release runs in a `.finally()` on that promise. A row added after the
 * run finalized would attach a non-terminal job to a completed run.
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
    .addJobsToRun(runId, [
      {
        jobId,
        jobName: mat.expandedName,
        ...(mat.variantValues && { matrixValues: mat.variantValues }),
        ...variantTrackingFields(mat),
        runsOnLabels: runsOnSelectorsForLockJob(mat.lockJob).runsOnLabels,
        ...(jobEnvData.contextNames?.length && { contexts: jobEnvData.contextNames }),
      },
    ])
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
  /** The wave-policy fields persisted on a bounded-wave child's execution_jobs row. */
  const wavePolicyFields = (name: string): { waveMaxParallel?: number; waveFailFast?: boolean } => {
    const p = wavePlan.policy.get(name);
    return p ? { waveMaxParallel: p.maxParallel, waveFailFast: p.failFast } : {};
  };
  for (const mat of buildPrep.materializedJobs) {
    const lockJob = mat.lockJob;
    const matrixValues = mat.variantValues;
    const envData = jobContextData.get(mat.expandedName);
    // A rejected job never dispatches. A non-`pendingInit` rejection was already
    // recorded by `recordContextRuleRejections`, which runs once for both
    // dispatch paths; a `pendingInit` one is recorded by the flow-back
    // (`recordContextRuleRejectionAfterInit`) instead, because its context is
    // only named by the init round. Either way this branch only has to skip the
    // dispatch.
    if (envData?.rejected) continue;
    // `pendingInit` is checked BEFORE `held`, and the order is load-bearing.
    // A job can now be both: its approval is known from the lock file, but its
    // dynamic values are not. Holding it here would call `buildExecutionJobInput`
    // on unresolved values and store THAT as the pending dispatch context — so
    // the release path would dispatch a job whose dynamic env, contexts,
    // concurrency group or matrix were never resolved. The flow-back owns the
    // hold for such a job (`holdExecutionAfterInit`), because only it has the
    // resolved values to store.
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

    // An invoke gate never reaches an agent: register it as a pending gate
    // (root gates are nudged post-registration by invokeRootGates; needs-gated
    // gates are released by the scheduler). Applies to both root and non-root.
    const invokeParams = invokeParamsFromLockJob(lockJob);
    if (invokeParams) {
      await registerPendingInvokeGate({ ctx, mat, jobInput, invokeParams, dispatchedJobs });
      continue;
    }

    if (!isRootJob(lockJob)) {
      await storePendingJobContext(deps.db, runId, mat.expandedName, { jobInput, runsOnLabels });
      const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        runsOnLabels,
      });
      logger.info('Job gated by needs scheduler (not dispatched yet)', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
      });
      continue;
    }

    // Rolling-wave gate: a fan-out child beyond the maxParallel sliding window
    // is held (not enqueued) until the wave-scheduler releases it on a sibling
    // terminal. Reuses the same pending-context + synthetic-id pattern as the
    // needs gate; the wave_gated=true flag (persisted via onExecutionStarted)
    // keeps the dispatch loop from picking it up and is cleared on release.
    if (wavePlan.held.has(mat.expandedName)) {
      await storePendingJobContext(deps.db, runId, mat.expandedName, { jobInput, runsOnLabels });
      // Use the SAME `needs-pending-` synthetic-id prefix as the needs gate: the
      // release path (dispatchReadyJob → findSyntheticJobId → addJobsToRun) only
      // cleans up rows with that prefix, so a divergent prefix would leave a
      // duplicate pending row that the wave-scheduler miscounts as in-flight.
      const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${mat.expandedName}-${randomUUID()}`;
      dispatchedJobs.push({
        jobId: syntheticId,
        jobName: mat.expandedName,
        ...(matrixValues && { matrixValues }),
        ...variantTrackingFields(mat),
        ...wavePolicyFields(mat.expandedName),
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

    // Fresh-box convergence: an `includeUninitialized` child pinned to a
    // declared-but-un-agented host gets a synthetic `__bringup__` job dispatched
    // to an ssh-transport ops agent FIRST. That brings up a temporary init-runner
    // (it enrolls under `mat.pinnedAgentId`), and the child below — queued with
    // the same pin by `dispatchPinned` — drains onto it via `onAgentAvailable`.
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
        runsOnLabels,
      });
      rejectedJobs.push({ jobId: syntheticId, jobName: mat.expandedName, reason: result.reason });
    } else {
      // `queued-no-backend` is tracked exactly like `queued`. The job IS in the
      // dispatch queue under `result.jobId`, so leaving it untracked made a run
      // whose `runsOn` matched no agent finish GREEN: `isRunComplete` iterates
      // the REGISTERED jobs, and an unregistered one is invisible to it. Tracked,
      // it holds the run open until an agent appears (scale-from-zero still
      // works) or the queue window expires and terminalizes it `unroutable`.
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
 * Phase E+F+G orchestrator — pick cluster vs single-orch path. Returns the
 * dispatched + rejected job lists (the build job, if any, is appended to
 * `dispatchedJobs` upstream).
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
    // A held job is excluded from routing above and nothing else in this branch
    // would touch it — so under a coordinator it used to vanish outright: no
    // `held_runs` row, no pending context, no placeholder, and a run that could
    // report success without it. The single-orchestrator path holds these in its
    // dispatch loop; this is the same call for the cluster path.
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
    // Invoke gates never route to a peer — the gate summons + tracks proxies on
    // the ingesting orchestrator. Register them locally as pending gates; root
    // gates are released by invokeRootGates after registration.
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
      await registerPendingInvokeGate({ ctx, mat, jobInput, invokeParams, dispatchedJobs });
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
 * Register the run BEFORE the first job is handed to an agent, and hold it open
 * for the whole dispatch window.
 *
 * **The race this closes.** Root jobs are dispatched to agents inside the
 * dispatch loop, and the run's own `execution_runs` row is written afterwards,
 * by `recordRunStart`. An agent that reports a job terminal in that window
 * misses in `ExecutionTracker`'s memory, `recoverRunFromDb` finds no row, and
 * the status update is **discarded** — `Run not found in DB, skipping job
 * status update`. The upstream never becomes terminal, so no downstream is ever
 * released and the run hangs with nothing logged as wrong. The `execution_jobs`
 * foreign-key violation logged at error level is the same race a few
 * microseconds later, once the row insert is attempted against a run that does
 * not exist yet.
 *
 * The window is single-digit milliseconds, and entirely reachable in production
 * by any job that terminates on arrival: a rejected dispatch, an init failure, a
 * capability mismatch. It was invisible for as long as the direct-ingress
 * webhook route answered only after the whole pipeline had run, because no
 * caller could learn a job had been dispatched until every row was committed.
 *
 * A workflow with a source-pack build never hits it: `prepareCacheAndBuild`
 * registers the run with the build job alone before dispatching anything else.
 * This is that same early start, generalized to every workflow.
 *
 * **The token is not optional.** Starting the run early is not sufficient on its
 * own: without a pending-jobs token, the first job to go terminal satisfies
 * `isRunComplete` while jobs 2..N are still being dispatched, and the run is
 * finalized mid-flight — a terminal run status written, the provider check
 * posted, and the status forwarded to the Platform before the rest of the run
 * has done anything. The token is released by `dispatchMatchedWorkflow`'s
 * `finally`, once `recordRunStart` has registered every dispatched job.
 *
 * Returns true when this call registered the run, which is what tells
 * `recordRunStart` to take its `addJobsToRun` branch.
 */
async function startRunBeforeDispatch(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
}): Promise<boolean> {
  const { ctx, setup, buildPrep, declaredContexts } = args;
  const {
    deps,
    workflow,
    repoIdentifier,
    credentials,
    event,
    ref,
    runId,
    decision,
    localWorkingTree,
    triggeredBy,
    triggeredByAgentLabel,
  } = ctx;
  const tracker = deps.executionTracker;
  if (!tracker) return false;
  // The source-pack build path already registered the run with the build job
  // alone and took its own token over the same window.
  if (buildPrep.buildJobTrackedEarly) return false;
  // Nothing will be handed to an agent, so there is no window to close — and a
  // row inserted here would hold zero jobs forever. `isRunComplete` ends
  // `run.jobs.size > 0` and no sweeper reaps such a row (the stale-run detector
  // scans from `execution_jobs` / `dispatch_queue`, orphan recovery needs
  // `running`, cold-store archival needs a terminal status), so it would sit
  // `pending` while the deadline detector re-fired against it every tick. The
  // all-deferred workflows that land here keep their own bootstrap,
  // `ensureExecutionRunForDeferred`.
  if (buildPrep.buildFailed || buildPrep.materializedJobs.length === 0) return false;

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
    [],
    setup.info.routingKey,
    declaredContexts.length > 0 ? [...declaredContexts] : undefined,
    dispatchTriggerEvent(ctx),
    extractCommitMessage(setup.info.event, setup.info.payload),
    undefined, // parentRunId
    triggeredBy,
    undefined, // originalRunId
    setup.workflowConcurrency,
    setup.workflowTimeoutMs,
    setup.checkMode,
    localWorkingTree,
    event.senderUsername ?? undefined,
    event.senderUserId ?? undefined,
    triggeredByAgentLabel,
    event.prNumber ?? null,
  );
  await stampChainDepth(ctx);
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

async function recordRunStart(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
  runContextName: string | undefined;
  runContextId: string | undefined;
  dispatchedJobs: DispatchedJob[];
  /**
   * True when the run row was already inserted before the dispatch loop — by
   * `startRunBeforeDispatch`, or by the source-pack build path registering the
   * build job alone. The run then only needs its jobs added, never a second
   * `onExecutionStarted` (which would reset the in-memory job map).
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
  const {
    deps,
    workflow,
    repoIdentifier,
    credentials,
    event,
    ref,
    runId,
    decision,
    trustResolution,
    lockFileSource,
    localWorkingTree,
    testRun,
    triggeredBy,
    triggeredByAgentLabel,
  } = ctx;
  if (!deps.executionTracker) return;
  // Without an early start there is no row yet, so a run that dispatched
  // nothing gets none here — the all-rejected / deferred paths below record it
  // instead. With an early start the row already exists, so the per-run context
  // and trust updates still have something to write to.
  if (!runTrackedEarly && dispatchedJobs.length === 0) return;
  if (runTrackedEarly) {
    // The build job was registered on its own by the build path, so it is
    // already in the run's job map; a general early start registered no jobs at
    // all and every dispatched job is new.
    const executionJobs =
      buildPrep.buildJobTrackedEarly && buildPrep.buildJobId
        ? dispatchedJobs.filter((j) => j.jobId !== buildPrep.buildJobId)
        : dispatchedJobs;
    if (executionJobs.length > 0) {
      await deps.executionTracker.addJobsToRun(
        runId,
        executionJobs,
        declaredContexts.length > 0 ? [...declaredContexts] : undefined,
      );
    }
  } else {
    await deps.executionTracker.onExecutionStarted(
      runId,
      workflow.name,
      setup.info.provider,
      repoIdentifier,
      event.targetBranch,
      ref,
      setup.effectiveDeliveryId,
      credentials as Record<string, unknown>,
      dispatchTriggerDecision(ctx, decision),
      dispatchedJobs,
      setup.info.routingKey,
      declaredContexts.length > 0 ? [...declaredContexts] : undefined,
      dispatchTriggerEvent(ctx),
      extractCommitMessage(setup.info.event, setup.info.payload),
      undefined, // parentRunId
      triggeredBy,
      undefined, // originalRunId
      setup.workflowConcurrency,
      setup.workflowTimeoutMs,
      setup.checkMode,
      localWorkingTree,
      event.senderUsername ?? undefined,
      event.senderUserId ?? undefined,
      triggeredByAgentLabel, // triggeredByAgentLabel
      event.prNumber ?? null,
    );
    await stampChainDepth(ctx);
  }
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
    // The same two values the row below records, mirrored onto the in-memory
    // run so a job's completion check can name the reduced-privilege posture.
    // Stamped from here rather than passed to `onExecutionStarted`, because
    // trust resolves on its own path and this is the one site that owns both
    // columns.
    //
    // Guarded like the `.catch()` on each sibling write below, and for the same
    // reason: every post-start write here is best-effort, and none of them may
    // abort `recordRunStart` — the remaining ones (the trust columns, the
    // test-run stamp) would be silently skipped. A tracker that does not
    // implement the method loses only the note.
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
      .set({
        trust_tier: trustResolution.tier,
        lock_file_source: lockFileSource,
        contributor_username: trustResolution.contributorUsername,
      })
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
 * Open the needs gate for any job whose upstreams already reached terminal
 * before this run's edges existed.
 *
 * **The race this closes.** Root jobs are dispatched to agents inside the
 * dispatch loop, but `execution_job_needs` is only written afterwards, here. An
 * agent that reports a root job terminal in that window drives
 * `evaluateDownstreams`, which reads zero edges, returns an empty result, and
 * the gate never fires again — the downstream stays `pending` forever and the
 * run hangs with no error anywhere. Nothing re-evaluates on its own: the
 * scheduler is purely event-driven off job completion, and that event has
 * already been consumed.
 *
 * The window is small (single-digit milliseconds) but entirely reachable: a job
 * that fails immediately on arrival — a rejected dispatch, an init failure, a
 * capability mismatch — reports terminal in about the time one DB write takes.
 * It was invisible for as long as the webhook route answered only after the
 * whole pipeline had run, because the caller could not learn a job had been
 * dispatched until every edge was already committed.
 *
 * Recomputing here is the same guard the deferred result-aware eval registration
 * already applies for its own edges, and it is safe to run unconditionally: the
 * claim inside `recomputeNeedsSatisfied` is a conditional UPDATE, so a job the
 * normal completion path already claimed is skipped rather than dispatched
 * twice.
 *
 * Wave-held jobs share the synthetic-id prefix but are gated by the rolling-wave
 * scheduler, not by needs, so they are excluded — opening their gate here would
 * bypass the `maxParallel` window.
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

  // Only a job whose gate is already expressible may be recomputed. A job
  // gated on a dynamic group has NO row here yet — `insertEdgesForRun` cannot
  // name members that the eval job has not generated, so `resolveGroupEdges`
  // writes those edges later. `checkAllUpstreamsSatisfied` reads "no edges" as
  // "no needs, dispatch now", so handing it such a job releases a downstream
  // before its group has run at all — which is the opposite of the stall this
  // catch-up exists to fix.
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
      // A skipped synthetic job (intentionally narrowed-to-empty fan-out) carries
      // no init-failure; a failed one does.
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
 * After init finishes, resolve the new context and update jobEnvData with
 * the resolved context + vars + secrets.
 *
 * Returns the {@link ContextGateHandle} the delegated
 * `applyContextRulesAndSecrets` produced, so a dynamic-matrix fan-out can
 * re-gate each resolved child against the same effective context without
 * re-resolving its scoped secrets.
 */
async function applyInitResultContext(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  /** The materialized job's expanded name — `held_runs.job_id` for any hold. */
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
  // Which names to apply. When the job binds a DYNAMIC context the agent
  // resolves the whole ordered list and reports it. When every binding is
  // STATIC the agent reports nothing — `init-runner` only fills `contextNames`
  // under `flags.dynamicContext` — but the orchestrator has had those names all
  // along, in the lock file.
  //
  // Falling back to them is what stops a static context being ignored merely
  // because some OTHER field on the job is dynamic. Without it such a job ran
  // with no `enabled` check, no branch restriction, no minimum-trust check, no
  // concurrency limit, no required reviewers, no wait timer — and none of the
  // context's vars or secrets.
  const resolvedNames = anyDynamic
    ? (initResult?.contextNames ?? [])
    : resolveJobContextNames(lockJob).names;
  if (resolvedNames.length > 0 && deps.contextStore) {
    // Overwrite the dispatch-time placeholder list with the agent-resolved one.
    // `applyContextRulesAndSecrets` does not maintain this list, and
    // `dispatchExecutionAfterInit` persists it on the job row.
    jobEnvData.contextNames = [...resolvedNames];
    // Delegate to the SAME function the synchronous path uses, rather than
    // re-implementing a subset of it. This path previously matched the contexts
    // and resolved their secrets itself while re-applying exactly one gate (the
    // test-run `allowLocalExecution` fail-safe) — so a job whose contexts
    // resolve at init time was never checked against `enabled`, branch
    // restrictions, minimum trust, the concurrency limit, required reviewers or
    // a wait timer. Those gates are not optional for a dynamically-bound
    // context; they are simply evaluable only once the name is known, which is
    // here.
    gate = await applyContextRulesAndSecrets({
      ctx,
      lockJob,
      expandedName,
      contextNames: resolvedNames,
      // The agent resolves a `dynamicConcurrencyGroup` and reports it here. It
      // used to be dropped on the floor — the parameter type did not even name
      // it — so such a job was gated under the CONTEXT name instead of its own
      // group, silently sharing a limit with everything else bound to it.
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
  /** The workflow's own `filter` decided the workflow does not apply. */
  Filter = 'filter',
  /** The job is already rejected by a context rule, or held for approval. */
  Gated = 'gated',
}

/**
 * Decide whether an arrived init result may dispatch its job.
 *
 * `Filter` requires the workflow to actually declare a filter as well as the
 * agent to have reported `false`: a buggy or rogue agent must not be able to
 * suppress a filter-less workflow by inventing the field, and an agent that
 * predates the filter reports no verdict at all — reading that absence as
 * "suppress" would silently stop every dispatch it handles.
 *
 * `Gated` covers a job that is already rejected or held. Its two halves now have
 * very different reachability, and saying so is the point of this paragraph:
 *
 * - **rejected** is live and load-bearing. The flow-back consumes it (that is
 *   the `suppression === Gated && jobEnvData.rejected` branch) to stop a job its
 *   context rules rejected from dispatching.
 * - **held** is NOT consumed here any more. A held job deliberately DOES get an
 *   init job — nothing else can resolve a dynamic value, so suppressing the
 *   round would make the job undispatchable rather than merely gated. The
 *   flow-back handles it after resolution instead, routing it to
 *   `holdExecutionAfterInit` so the hold and its resolved dispatch context are
 *   stored together.
 *
 * So do not read this as a guarantee that a held job cannot dispatch: that
 * guarantee lives at the call site's `jobEnvData.held` branch, and — for the
 * needs-scheduler and cluster paths, which reach a job by other routes — in
 * `dispatchReadyJob`'s pending-hold check and the cluster path's own
 * `holdJobForApproval` call.
 *
 * Exported for its own test: inline, the second branch could not be exercised at
 * all, and an untestable security check is one nobody can prove still works.
 */
export function initDispatchSuppression(
  workflow: Pick<LockWorkflow, 'hasFilter'>,
  initResult: { filterPassed?: boolean },
  jobEnvData: Pick<JobEnvData, 'rejected' | 'held'>,
): InitDispatchSuppression | null {
  if (workflow.hasFilter === true && initResult.filterPassed === false) {
    return InitDispatchSuppression.Filter;
  }
  if (jobEnvData.rejected || jobEnvData.held) return InitDispatchSuppression.Gated;
  return null;
}

/**
 * After init resolution, HOLD the job for approval instead of dispatching it.
 *
 * The sibling of {@link dispatchExecutionAfterInit} for a job whose approval
 * was decided from the lock file (`applyStaticApprovalHolds`) while its dynamic
 * fields still needed an init round. The dispatch loop deliberately skips such
 * a job — see the `pendingInit` guard there — because holding it at dispatch
 * time would have stored an input built from unresolved values.
 *
 * Both halves of the hold happen here, in this order:
 *   1. `holdJobForApproval` creates the `held_runs` row, audits it, and stores
 *      the pending dispatch context built from the NOW-RESOLVED `jobEnvData`.
 *   2. The synthetic placeholder it produced is registered on the run, so the
 *      run is not considered complete while the job awaits approval.
 *
 * Step 2 is why this cannot simply call `holdJobForApproval` inline: the
 * dispatch loop registers its placeholders in one `addJobsToRun` after the
 * loop, and this path runs long after that call has already happened.
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
    // NOT swallowed: this placeholder is the only thing keeping the run open
    // while the approval is pending. If it never lands, the run can complete
    // while the hold sits pending forever — so let the error propagate to the
    // flow-back's catch, which records an init-failure the operator can see.
    try {
      await deps.executionTracker.addJobsToRun(runId, heldJobs);
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

/**
 * After init resolution, dispatch the actual execution job — through the
 * coordinator if peers are connected, else direct dispatch.
 */
async function dispatchExecutionAfterInit(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  /** Agent-resolved ordered bound-context names, persisted on the real job row. */
  contexts?: string[];
  /** Test-run warning for context(s) skipped as unavailable — persisted for the dashboard. */
  envWarning?: string;
  /** Names of the contexts skipped for the test run. */
  skippedContexts?: string[];
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, contexts, envWarning, skippedContexts } =
    args;
  const envFields = {
    ...(contexts?.length ? { contexts } : {}),
    ...(envWarning ? { envWarning } : {}),
    ...(skippedContexts?.length ? { skippedContexts } : {}),
  };
  const lockJob = mat.lockJob;
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
      jobConfig: buildJobConfig(mat),
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      sourceTarUrl: buildPrep.sourceTarUrl,
      sourceTarHash: buildPrep.sourceTarHash,
      depsUrl: buildPrep.depsUrl,
      depsHash: buildPrep.depsHash,
      excludeLabels,
      ...(lockJob.resources && { resources: lockJob.resources }),
    };
    const cloneToken = await mintCloneTokenForReroute({
      bundle,
      repoIdentifier,
      credentials,
      runId,
      workflowName: workflow.name,
    });
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
      ...(cloneToken && { cloneToken }),
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
          .addJobsToRun(runId, [
            {
              jobId: local.jobId,
              jobName: local.jobName,
              runsOnLabels: jobInput.runsOnLabels,
              ...envFields,
            },
          ])
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
      await deps.executionTracker.addJobsToRun(runId, [
        {
          jobId: syntheticId,
          jobName: mat.expandedName,
          ...(matrixValues && { matrixValues }),
          runsOnLabels: jobInput.runsOnLabels,
          ...envFields,
        },
      ]);
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
        .addJobsToRun(runId, [
          {
            jobId: result.jobId,
            jobName: mat.expandedName,
            ...(matrixValues && { matrixValues }),
            runsOnLabels: jobInput.runsOnLabels,
            ...envFields,
          },
        ])
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
 * After the agent eval resolves a dynamic matrix to N combinations, materialize
 * the children and dispatch one execution job per combination — the dynamic-
 * matrix equivalent of the static-matrix dispatch path. Needs edges for the
 * children are inserted from the freshly-built expansion map.
 */
async function dispatchResolvedDynamicMatrix(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  mat: MaterializedJob;
  combos: Array<Record<string, string | undefined>>;
  jobContextData: Map<string, JobEnvData>;
  /**
   * The base job's gate handle, from `applyInitResultContext`. Undefined when
   * the job binds no context, in which case there is nothing to re-gate.
   */
  gate: ContextGateHandle | undefined;
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, combos, jobContextData, gate } = args;
  const { deps, workflow, runId } = ctx;

  let result: ReturnType<typeof materializeResolvedMatrix>;
  try {
    result = materializeResolvedMatrix(mat.lockJob, combos);
  } catch (err) {
    // The placeholder is never dispatched on any exit from here, so its
    // reserved slot goes back before every one of them. Releasing only on the
    // success path leaked a slot for the rest of the pass whenever a matrix
    // failed to expand, which under-admits every later job in the same group.
    if (gate?.admitted) releaseAdmission(ctx, gate.admissionKey);
    if (err instanceof FanoutError && deps.executionTracker) {
      const jobId = `matrix-failed-${randomUUID()}`;
      await deps.executionTracker
        .addJobsToRun(runId, [{ jobId, jobName: mat.baseName, runsOnLabels: [] }])
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

  // Each child inherits the base job's resolved env data (env/secrets resolved
  // during init), keyed by its expanded name so makeBuildJobConfig finds it.
  const baseEnvData = jobContextData.get(mat.expandedName) ?? {};
  // The placeholder never dispatches — the children replace it — so give back
  // the in-pass slot its own gate reserved. Without this a fan-out of N
  // children would consume N+1 slots.
  if (gate?.admitted) releaseAdmission(ctx, gate.admissionKey);
  for (const child of result.jobs) {
    const childEnvData: JobEnvData = { ...baseEnvData };
    jobContextData.set(child.expandedName, childEnvData);
    // Gate each child on its own — the same shape a STATIC matrix produces,
    // where `evaluateJobContexts` iterates the already expanded jobs and gates
    // each one. Gating only the placeholder admitted all N combinations against
    // a single checked slot. Skipped when the base already rejected or held:
    // that verdict fans out to every child unchanged, and re-running the gate
    // would spend a slot on a job that is not dispatching.
    if (gate && !childEnvData.rejected && !childEnvData.held) {
      await applyContextProtectionGates({
        ctx,
        lockJob: mat.lockJob,
        gate: { ...gate, dispatchCtx: { ...gate.dispatchCtx, jobId: child.expandedName } },
        jobEnvData: childEnvData,
      });
    }
    // Defensive rather than reachable today: the base's own gate rejects before
    // the fan-out is reached (`startDeferredInitDispatch` returns on
    // `jobEnvData.rejected`), and the remaining reject gates are deterministic
    // over the same effective context. Recorded rather than dropped, because a
    // child that silently neither dispatched nor held would leave the run
    // waiting on a job nothing ever reports.
    if (childEnvData.rejected) {
      await recordContextRuleRejectionAfterInit({ ctx, mat: child, jobEnvData: childEnvData });
      continue;
    }
    // A held base job holds every child, one hold each — the same shape a
    // STATIC matrix produces, where `evaluateJobContexts` iterates the already
    // expanded jobs and mints a hold per child. Holding only the placeholder
    // would resume a single un-expanded job instead of the N combinations.
    // `holdJobForApproval` keys `held_runs.job_id` on the expanded name, so the
    // children's holds stay distinguishable.
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

  // Insert needs edges for the resolved children so downstream jobs that need
  // this base name wait for all of them.
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
    // Each init job registers its execution jobs from a task that outlives this
    // call, so it holds its own token. Taken synchronously here — before
    // dispatchMatchedWorkflow's finally drops the build-window token — so the
    // run is never momentarily un-held between the two.
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
        if (dispatchResult.status !== 'dispatched' && dispatchResult.status !== 'queued') {
          throw new Error(`Init job dispatch rejected: ${dispatchResult.status}`);
        }
        const initResult = await pendingInits.track(dispatchResult.jobId);
        const jobEnvData = jobContextData.get(mat.expandedName) ?? {};
        jobEnvData.pendingInit = false;
        const suppression = initDispatchSuppression(workflow, initResult, jobEnvData);
        if (suppression === InitDispatchSuppression.Filter) {
          logger.info('Workflow filter suppressed dispatch', {
            runId,
            workflow: workflow.name,
            job: mat.expandedName,
          });
          jobContextData.set(mat.expandedName, jobEnvData);
          return;
        }
        // A REJECTED job stops here: it is not dispatching, and nothing needs
        // its resolved values. A HELD one does not — its approval was decided
        // from the lock file before this round ran, and the release path
        // dispatches the STORED pending context verbatim, so the values must be
        // resolved and stored now or the job resumes unresolved.
        if (suppression === InitDispatchSuppression.Gated && jobEnvData.rejected) {
          // Defensive rather than reachable today: a job is deferred either
          // before its context rules run (a dynamic field) or only when it is
          // not already rejected (the workflow-filter deferral), so nothing
          // sets `rejected` between the deferral and this check. It records the
          // rejection anyway, because the static collector skips every
          // `pendingInit` job — leaving this branch silent would recreate the
          // very gap the flow-back recorder exists to close.
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
        // A context-unavailable warning is decided here, after the agent init
        // round — long after the blocking `kici run remote` test run received
        // its accept response. Surface it on the run's log stream (the same
        // channel the init job's own lines take) so the CLI prints it, matching
        // the synchronous path's accept-response warning.
        if (jobEnvData.envWarning && deps.logWriter) {
          await deps.logWriter.appendChunk(
            runId,
            mat.expandedName,
            0,
            [jobEnvData.envWarning],
            Date.now(),
          );
        }
        // Now that the context rules have run (and resolved this job's vars and
        // secrets), mint the holds the lock file decides. Same order as the
        // synchronous path, so a context-driven hold still wins — it unions the
        // job's own clauses, and on a root job the workflow's, into itself, and
        // is the stronger requirement.
        await applyStaticApprovalHolds({ ctx, lockJob, jobEnvData });
        jobContextData.set(mat.expandedName, jobEnvData);
        // Re-checked AFTER resolution, not only before it: a dynamically-bound
        // context's gates are evaluable only once the init round has named it,
        // so `applyInitResultContext` is what sets `rejected` on this path. The
        // pre-resolution check above cannot see it.
        if (jobEnvData.rejected) {
          await recordContextRuleRejectionAfterInit({ ctx, mat, jobEnvData });
          return;
        }
        // The matrix branch is checked BEFORE the single-job hold: a held
        // dynamic-matrix job must fan its hold out across the children the
        // round just resolved, not sit on the un-expanded placeholder, so the
        // hold decision is made per child inside `dispatchResolvedDynamicMatrix`.
        if (mat.pendingDynamicMatrix && initResult.matrixValues) {
          // The agent resolved the dynamic matrix to N combinations — materialize
          // them and dispatch one child per combination, just like a static matrix.
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
          // Approval, not the init round, is this job's gate. The hold row and
          // the pending dispatch context are created together HERE so the
          // stored input carries the values this round just resolved —
          // `storePendingJobContext` upserts, so a context written earlier is
          // overwritten rather than duplicated.
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
            .addJobsToRun(runId, [
              {
                jobId,
                jobName: mat.expandedName,
                ...(mat.variantValues && { matrixValues: mat.variantValues }),
                runsOnLabels: runsOnSelectorsForLockJob(lockJob).runsOnLabels,
              },
            ])
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
    // Released via `.finally()` on the spawned promise rather than a
    // try/finally inside it: the body returns early on several paths above its
    // own try, and running after its catch is what lets the synthetic
    // `init-failed-*` row land while the token is still held.
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
        void executionTracker?.releasePendingJobsHold(runId).catch((err: unknown) => {
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
   * The generated lock job with its `name` and `needs` rewritten to expanded
   * matrix-child names (identical to the base job for non-matrix generated
   * jobs). Downstream dispatch / needs-edge / tracking code keys on this name.
   */
  genJob: LockJob;
  genJobConfig: Record<string, unknown>;
  runsOnLabels: string[];
  /** Regex matchers the agent's labels must satisfy (JS post-filter). */
  runsOnPatterns: LabelMatcher[];
  /** Exact labels the dispatched agent must NOT have. */
  excludeLabels: string[];
  /** Regex matchers that disqualify an agent (JS post-filter). */
  excludePatterns: LabelMatcher[];
  /** Host-fanout pin: when runsOn resolved to a roster host, route only to it. */
  pinnedAgentId?: string;
  /** The host's current coordinator (cross-cluster reroute hint); null = not connected. */
  connectedInstanceId?: string | null;
  /** The matrix combination for this child; absent for non-matrix generated jobs. */
  matrixValues?: Record<string, unknown>;
}

/**
 * Split generated configs into pinned (host-pin dispatch) and unpinned (normal
 * label routing). A pinned config always rides the dispatcher pin path because
 * the coordinator's `JobToRoute` shape carries no pin field — routing it via the
 * coordinator would silently drop the pin.
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
  /** Frozen upstream snapshot for a result-aware generator (absent for event-only). */
  upstreamSnapshot?: UpstreamSnapshot;
}): Promise<{
  evalJobId: string;
  evalJobLabels: string[];
  evalJobName: string;
  /** Synthetic deferred-eval row to swap for the real eval id (result-aware only). */
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
  const evalJobInput: QueuedJobInput = {
    runId,
    workflowName: workflow.name,
    jobName: evalJobName,
    runsOnLabels: [
      INIT_RUNNER_ROLE_LABEL,
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig: {
      dynamicJobFn: true,
      workflowName: workflow.name,
      source: dynamicEntry.source,
      event,
      timeoutMs: 120_000,
      // The workflow's `filter` gates the generator as well as the static jobs'
      // init round — the agent runs it first and generates nothing on a `false`
      // verdict. Without this a generator-only workflow would keep the filter
      // inert, and a mixed one would half-dispatch. Omitted (never `false`) when
      // the workflow declares none, matching how the lock file records it.
      ...(workflow.hasFilter === true && { hasFilter: true }),
      ...(workflow.contentHash && !ctx.testRun && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
      // Result-aware generators carry their declared needs + the frozen upstream
      // snapshot so the agent can build ctx.needs at eval time.
      ...(upstreamSnapshot && {
        resultAware: true,
        declaredNeeds: dynamicEntry.needs ?? [],
        upstreamSnapshot,
      }),
    },
    repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    provider: setup.info.provider,
    providerContext: credentials as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    requestId: getRequestContext().requestId,
    sourceTarUrl: buildPrep.sourceTarUrl,
    sourceTarHash: buildPrep.contentHash || undefined,
    depsUrl: buildPrep.depsUrl,
    depsHash: buildPrep.depsHash,
  };
  // For a result-aware (deferred) eval, registerDeferredEvalJob inserted a
  // synthetic pending row under the same job name; look it up BEFORE dispatch so
  // the swap that follows carries no further await between the WS dispatch and
  // the caller's pendingDynamics.track() registration (a late await there races
  // a fast eval-complete reply and drops the resolve).
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
 * Resolve env/secrets per generated job and build their job configs.
 * Skips jobs that fail individual secret resolution.
 */
/**
 * Records a dropped generated-job matrix as a `matrix_expansion` init failure so
 * the run's dashboard surfaces it, mirroring the static / top-level dynamic-matrix
 * paths. A no-op when the run has no execution tracker.
 */
async function recordGeneratedMatrixFailure(
  deps: WorkflowDispatchContext['deps'],
  runId: string,
  err: FanoutError,
): Promise<void> {
  if (!deps.executionTracker) return;
  const jobId = `matrix-failed-${randomUUID()}`;
  await deps.executionTracker
    .addJobsToRun(runId, [{ jobId, jobName: err.jobName, runsOnLabels: [] }])
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

async function resolveGeneratedJobConfigs(args: {
  ctx: WorkflowDispatchContext;
  workflow: LockWorkflow;
  fullLockFile: WorkflowDispatchContext['fullLockFile'];
  resolvedSecrets: Record<string, string> | undefined;
  resolvedNamespacedSecrets: Record<string, Record<string, string>> | undefined;
  runPublicKeyBase64: string | undefined;
  npmRegistries: NpmRegistrySpec[] | undefined;
  installEnvSecrets: Record<string, string> | undefined;
  generatedJobs: LockJob[];
  dynamicEntry: BuildPrepResult['dynamicEntries'][number];
  /** Frozen upstream snapshot threaded into each generated job's dynamicSource for re-eval. */
  upstreamSnapshot?: UpstreamSnapshot;
}): Promise<GeneratedJobConfig[]> {
  const {
    ctx,
    workflow,
    fullLockFile,
    resolvedSecrets,
    resolvedNamespacedSecrets,
    runPublicKeyBase64,
    npmRegistries,
    installEnvSecrets,
    generatedJobs,
    dynamicEntry,
    upstreamSnapshot,
  } = args;
  const { deps, runId, resolvedOrgId, event } = ctx;
  const out: GeneratedJobConfig[] = [];

  // Materialize each generated job's matrix into N children at dispatch time —
  // the agent's dynamic serializer already resolved any dynamic matrix fn into a
  // static LockMatrix, so a generated job with a matrix fans out here exactly
  // like a lock-level static-matrix job. Non-matrix generated jobs pass through
  // 1:1. The expansion map rewrites needs edges across the generated set, and
  // the agent's expected-jobs tracking sees the expanded child names.
  // Each generated job whose matrix fails to materialize is recorded as a
  // matrix_expansion init failure and dropped, so one bad matrix does not poison
  // the rest of the generated set. The loop handles multiple bad matrices.
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
      await recordGeneratedMatrixFailure(deps, runId, err);
      const before = remaining.length;
      const idx = remaining.findIndex((j) => j.name === err.jobName);
      if (idx >= 0) remaining.splice(idx, 1);
      if (remaining.length === before) throw err; // safety: avoid an infinite loop
    }
  }
  // The agent re-evaluates the DynamicJobFn and compares its output against
  // these names for determinism. The factory produces BASE job names (matrix
  // expansion is an orchestrator dispatch concern), so expectedJobNames carries
  // base names, de-duplicated across a fanned job's children.
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
    const genJob = mat.lockJob;
    try {
      let genContextName: string | undefined;
      let genContextVars: Record<string, string> | undefined;
      let genSecrets: Record<string, string> = { ...resolvedSecrets };
      let genNamespacedSecrets: Record<string, Record<string, string>> = {
        ...resolvedNamespacedSecrets,
      };
      const genEnvNames = (genJob.contexts ?? [])
        .filter((e) => !e.dynamic && typeof e.value === 'string')
        .map((e) => e.value as string);
      if (genEnvNames.length > 0 && deps.contextStore) {
        const present: Array<{ name: string; env: EngineContext }> = [];
        for (const name of genEnvNames) {
          const cfg = await deps.contextStore.matchContext(resolvedOrgId, name);
          if (cfg) {
            const env = toContext(cfg);
            present.push({ name: env.name, env });
          }
        }
        if (present.length > 0) {
          genContextName = present[0].name;
          try {
            const merged = await resolveMultiEnvMergedData({
              deps: { variableStore: deps.variableStore, secretResolver: deps.secretResolver },
              orgId: resolvedOrgId,
              entries: present,
              hostCtx: hostCtxFromMat(mat),
              routingKey: ctx.info.routingKey,
            });
            if (merged.contextVars) genContextVars = merged.contextVars;
            if (merged.jobSecrets) genSecrets = { ...genSecrets, ...merged.jobSecrets };
            if (merged.jobNamespacedSecrets) {
              genNamespacedSecrets = { ...genNamespacedSecrets, ...merged.jobNamespacedSecrets };
            }
          } catch (err) {
            logger.error('Dynamic job: secret resolution failed', {
              runId,
              job: mat.expandedName,
              error: toErrorMessage(err),
            });
          }
        }
      }
      // Run-wide CLI flat secrets win on collision + reach env-less dynamic jobs.
      if (ctx.runWideFlatSecrets) {
        genSecrets = { ...genSecrets, ...ctx.runWideFlatSecrets };
      }
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
        // Raw matrix/include/exclude are consumed at dispatch time, not shipped:
        // the child instead carries baseJobName + matrixValues (exposed to the
        // agent as ctx.job.name + ctx.matrix).
        ...(envelope.matrixValues && {
          baseJobName: envelope.baseJobName,
          matrixValues: envelope.matrixValues,
        }),
        ...(workflow.contentHash && !ctx.testRun && { contentHash: workflow.contentHash }),
        ...(hasSecrets && { secrets: genSecrets }),
        ...(hasNamespaced && { namespacedSecrets: genNamespacedSecrets }),
        ...(runPublicKeyBase64 && { runPublicKey: runPublicKeyBase64 }),
        ...(npmRegistries && npmRegistries.length > 0 && { npmRegistries }),
        ...(installEnvSecrets &&
          Object.keys(installEnvSecrets).length > 0 && { installEnvSecrets }),
        ...(genContextName && { context: genContextName }),
        ...(genContextVars && { contextVars: genContextVars }),
        ...(genJob.env &&
          typeof genJob.env === 'object' && {
            jobEnv: genJob.env as Record<string, string>,
          }),
        dynamicSource: {
          index: dynamicEntry.source.index,
          event,
          expectedJobNames,
          // Result-aware generators re-eval against the same frozen snapshot the
          // eval saw, plus the declared needs that shape ctx.needs.
          ...(upstreamSnapshot && {
            upstreamSnapshot,
            declaredNeeds: dynamicEntry.needs ?? [],
          }),
        },
      };
      const genSel = runsOnSelectorsForLockJob(genJob);
      const pin = await resolveRosterAgentPin({
        runsOnLabels: genSel.runsOnLabels,
        runsOnPatterns: genSel.runsOnPatterns,
        hostRosterStore: deps.hostRosterStore,
      });
      out.push({
        genJob: { ...genJob, name: envelope.name, needs: expandedNeeds },
        genJobConfig,
        // A pin targets the agent directly — clear routing labels (parity with
        // runsOnAll children, which carry no routing). A miss keeps normal routing.
        runsOnLabels: pin ? [] : genSel.runsOnLabels,
        runsOnPatterns: pin ? [] : genSel.runsOnPatterns,
        excludeLabels: genSel.excludeLabels,
        excludePatterns: genSel.excludePatterns,
        ...(pin && {
          pinnedAgentId: pin.pinnedAgentId,
          connectedInstanceId: pin.connectedInstanceId,
        }),
        ...(envelope.matrixValues && { matrixValues: envelope.matrixValues }),
      });
    } catch (err) {
      logger.error('Failed to resolve secrets for dynamic generated job', {
        runId,
        job: mat.expandedName,
        error: toErrorMessage(err),
      });
    }
  }
  return out;
}

async function gateAndStoreNonRootGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  gatedGeneratedConfigs: GeneratedJobConfig[];
}): Promise<void> {
  const { ctx, setup, buildPrep, gatedGeneratedConfigs } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  if (gatedGeneratedConfigs.length === 0 || !deps.db) return;
  const gatedEdgeRows: Array<{
    run_id: string;
    job_name: string;
    upstream_name: string;
    run_on: string;
  }> = [];
  for (const { genJob } of gatedGeneratedConfigs) {
    for (const need of genJob.needs) {
      if (typeof need === 'string') {
        gatedEdgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: need,
          run_on: SUCCESS_ONLY_RUN_ON_JSON,
        });
      } else if (typeof need === 'object' && 'name' in need && !('group' in need)) {
        gatedEdgeRows.push({
          run_id: runId,
          job_name: genJob.name,
          upstream_name: (need as { name: string }).name,
          run_on: needsRunOnJson(need as { runOn?: ExecutionJobStatus[] }),
        });
      }
    }
  }
  if (gatedEdgeRows.length > 0) {
    await deps.db
      .insertInto('execution_job_needs')
      .values(gatedEdgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  for (const {
    genJob,
    genJobConfig,
    runsOnLabels,
    runsOnPatterns,
    excludeLabels,
    excludePatterns,
    matrixValues,
  } of gatedGeneratedConfigs) {
    const gatedJobInput: QueuedJobInput = {
      runId,
      workflowName: workflow.name,
      jobName: genJob.name,
      runsOnLabels,
      runsOnPatterns,
      excludeLabels,
      excludePatterns,
      jobConfig: genJobConfig,
      repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      provider: setup.info.provider,
      providerContext: credentials as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      sourceTarUrl: buildPrep.sourceTarUrl,
      sourceTarHash: buildPrep.contentHash || undefined,
      depsUrl: buildPrep.depsUrl,
      depsHash: buildPrep.depsHash,
      requestId: getRequestContext().requestId,
    };
    // A generated invoke gate never reaches an agent: register it as a pending
    // gate (its cross-domain needs edges were inserted above) and let the
    // scheduler release it when its upstreams complete.
    const gateInvokeParams = invokeParamsFromLockJob(genJob);
    if (gateInvokeParams) {
      await registerGeneratedInvokeGate({
        ctx,
        jobName: genJob.name,
        matrixValues,
        jobInput: gatedJobInput,
        invokeParams: gateInvokeParams,
        release: false,
      });
      continue;
    }
    await storePendingJobContext(deps.db, runId, genJob.name, {
      jobInput: gatedJobInput,
      runsOnLabels,
    });
    const syntheticId = `${NEEDS_PENDING_JOB_ID_PREFIX}${genJob.name}-${randomUUID()}`;
    if (deps.executionTracker) {
      await deps.executionTracker.addJobsToRun(runId, [
        {
          jobId: syntheticId,
          jobName: genJob.name,
          runsOnLabels,
          ...(matrixValues && { matrixValues }),
        },
      ]);
    }
    logger.info('Generated job gated by cross-domain needs', {
      runId,
      workflow: workflow.name,
      job: genJob.name,
      needs: genJob.needs,
    });
  }
}

async function directDispatchGeneratedJobs(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  configs: GeneratedJobConfig[];
}): Promise<void> {
  const { ctx, setup, buildPrep, configs } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, bundle } = ctx;
  for (const {
    genJob,
    genJobConfig,
    runsOnLabels,
    runsOnPatterns,
    excludeLabels,
    excludePatterns,
    matrixValues,
    pinnedAgentId,
    connectedInstanceId,
  } of configs) {
    try {
      const genJobInput: QueuedJobInput = {
        runId,
        workflowName: workflow.name,
        jobName: genJob.name,
        runsOnLabels,
        runsOnPatterns,
        excludeLabels,
        excludePatterns,
        jobConfig: genJobConfig,
        repoUrl: bundle?.repoUrlBuilder?.buildCloneUrl(repoIdentifier) ?? '',
        ref: event.sourceBranch ?? event.targetBranch,
        sha: ref,
        deliveryId: setup.effectiveDeliveryId,
        provider: setup.info.provider,
        providerContext: credentials as Record<string, unknown>,
        routingKey: setup.info.routingKey,
        sourceTarUrl: buildPrep.sourceTarUrl,
        sourceTarHash: buildPrep.contentHash || undefined,
        depsUrl: buildPrep.depsUrl,
        depsHash: buildPrep.depsHash,
        requestId: getRequestContext().requestId,
        ...(pinnedAgentId && { pinnedAgentId }),
        ...(connectedInstanceId !== undefined && { connectedInstanceId }),
      };
      // A root generated invoke gate never reaches an agent: register it as a
      // gate and release it immediately (the run is already tracked).
      const gateInvokeParams = invokeParamsFromLockJob(genJob);
      if (gateInvokeParams) {
        await registerGeneratedInvokeGate({
          ctx,
          jobName: genJob.name,
          matrixValues,
          jobInput: genJobInput,
          invokeParams: gateInvokeParams,
          release: true,
        });
        continue;
      }
      const genResult = await setup.dispatcher.dispatch(genJobInput);
      if (genResult.status !== 'rejected' && deps.executionTracker) {
        await deps.executionTracker.addJobsToRun(runId, [
          {
            jobId: genResult.jobId,
            jobName: genJob.name,
            runsOnLabels,
            ...(matrixValues && { matrixValues }),
          },
        ]);
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

  // Invoke gates never route to a peer — the gate summons + tracks proxies on
  // the ingesting orchestrator. Dispatch them locally (directDispatch registers
  // and releases each gate), then partition the rest for cluster routing.
  const gateConfigs = rootGeneratedConfigs.filter((c) => isInvokeGate(c.genJob));
  if (gateConfigs.length > 0) {
    await directDispatchGeneratedJobs({ ctx, setup, buildPrep, configs: gateConfigs });
  }
  const nonGateConfigs = rootGeneratedConfigs.filter((c) => !isInvokeGate(c.genJob));
  if (nonGateConfigs.length === 0) return;

  const { pinnedConfigs, unpinnedConfigs } = partitionGeneratedConfigsByPin(nonGateConfigs);

  // Pinned generated jobs always go through the dispatcher pin path: JobToRoute
  // (the coordinator label-routing shape) carries no pin field, so routing a
  // pinned job through it would lose the pin. The dispatcher's dispatchPinned
  // handles local dispatch / queue-with-pin and the cross-cluster reroute the
  // same way runsOnAll children are dispatched.
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
      sourceTarHash: buildPrep.contentHash || undefined,
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
  const genCloneToken = await mintCloneTokenForReroute({
    bundle,
    repoIdentifier,
    credentials,
    runId,
    workflowName: workflow.name,
  });
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
    ...(genCloneToken && { cloneToken: genCloneToken }),
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
        .addJobsToRun(runId, [
          {
            jobId: local.jobId,
            jobName: local.jobName,
            runsOnLabels: matchingConfig?.runsOnLabels ?? [],
            ...(matchingConfig?.matrixValues && { matrixValues: matchingConfig.matrixValues }),
          },
        ])
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

/**
 * Eval-time topological sort across the fully-resolved graph. Marks all cycle
 * participants as failed and signals abort upstream.
 */
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
 * Recompute the needs gate for `jobNames` and act on whatever became ready:
 * open the gate for a satisfied job, terminalize a job an upstream's status
 * excluded.
 *
 * `recomputeNeedsSatisfied` claims each job with a conditional
 * `needs_satisfied = false → true` UPDATE, so a job a concurrent
 * `evaluateDownstreams` already claimed is not returned here and cannot be
 * dispatched twice.
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

/**
 * Split a result-aware generator's declared needs into static/named upstream job
 * names and dynamic-group names. Reuses the same normalized lock edge shapes the
 * static-job `needs` serializer produces.
 */
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
 * Register a result-aware generator's eval job as a deferred, needs-gated DAG
 * job: insert a synthetic pending execution_jobs row plus its execution_job_needs
 * edges, so the existing scheduler gates the eval exactly like any other job.
 * Group needs expand to their member job names (members already carry group_name
 * from setGroupNameAndResolveEdges on the group's own eval completion).
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

  // Expand group needs to concrete member job names recorded for this run.
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

  // Synthetic pending eval-job row so the scheduler can gate + the run-complete
  // check waits on it. Replaced by the real eval job id when the gate opens.
  const syntheticId = `dynamic-eval-pending-${evalJobName}-${randomUUID()}`;
  if (deps.executionTracker) {
    await deps.executionTracker.addJobsToRun(runId, [
      { jobId: syntheticId, jobName: evalJobName, runsOnLabels: [] },
    ]);
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

  // Race guard: an upstream may already be terminal (evaluateDownstreams ran for
  // it before our edges existed), so the gate would never fire from a future
  // completion. Recompute now; if already satisfied, fire the ready callback so
  // the gate opens. recomputeNeedsSatisfied returns 'skip' too — for an upstream
  // whose terminal status is not in the eval edge's run_on set, surface it as a
  // skipped eval below.
  const results = await recomputeNeedsSatisfied(deps.db, runId, [evalJobName]);
  for (const result of results) {
    if (result.action === 'dispatch' && deps.executionTracker?.onJobReadyCallback) {
      await deps.executionTracker.onJobReadyCallback(runId, evalJobName);
    } else if (result.action === 'skip') {
      // An upstream's terminal status is not in the eval edge's run_on set: the
      // generator produces nothing. Open the gate anyway so the awaiting task
      // proceeds with an empty snapshot (the generator decides what an
      // empty/failed upstream means via a wider `when` set).
      if (deps.executionTracker?.onJobReadyCallback) {
        await deps.executionTracker.onJobReadyCallback(runId, evalJobName);
      }
    }
  }
}

// `gatherInvokeResults` now lives in `orchestrator-core.ts` alongside its
// sibling upstream-outputs helpers (`mergeUpstreamOutputs`,
// `buildUpstreamOutputsByBase`, `parseOutputsCell`), so the standard-job
// dispatch path can reuse it without a reverse import cycle. Re-exported here
// for the existing consumers/tests that import it from this module.
export { gatherInvokeResults };

/**
 * Gather the frozen upstream snapshot for a result-aware eval: each declared
 * job/group-member's stored outputs (the same plain outputs map that backs
 * jobRef.result), plus group → ordered member names, plus per-gate invoke
 * results. Captured once, at eval dispatch, and replayed unchanged on
 * agent-side re-eval.
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

  // An upstream single-job need that names an invoke gate resolves to its per-run
  // results (one entry per proxy child), exposed downstream as
  // `ctx.needs['<gate>'].result`. Populate it before the plain jobs/groups read.
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
      // outputs is a JSONB column — Kysely returns it already-parsed (object),
      // though a string is tolerated too (parseOutputsCell handles both). A
      // null/empty/unparseable cell simply yields no outputs for that upstream.
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
    // Result-aware generators defer their eval until declared upstreams complete.
    // Register the eval as a needs-gated DAG job and wait for the scheduler to
    // open its gate, then snapshot the now-terminal upstreams' outputs.
    let upstreamSnapshot: UpstreamSnapshot | undefined;
    if (dynamicEntry.resultAware) {
      // Register the gate promise BEFORE registering edges so the race guard in
      // registerDeferredEvalJob (which may fire onJobReadyCallback synchronously
      // when an upstream is already terminal) finds a gate to open.
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
    // Register the completion tracker BEFORE any further await so a fast
    // eval-complete reply can't resolve before we're listening.
    const generatedJobsPromise = deps.pendingDynamics.track(evalJobId);
    // Record the eval job in the tracker. For a result-aware (deferred) eval,
    // replaceSyntheticId swaps the synthetic pending row registerDeferredEvalJob
    // inserted; for an event-only eval there is no synthetic row to replace.
    if (deps.executionTracker) {
      await deps.executionTracker.addJobsToRun(
        runId,
        [{ jobId: evalJobId, jobName: evalJobName, runsOnLabels }],
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

    const generatedJobConfigs = await resolveGeneratedJobConfigs({
      ctx,
      workflow,
      fullLockFile,
      resolvedSecrets: secrets.resolvedSecrets,
      resolvedNamespacedSecrets: secrets.resolvedNamespacedSecrets,
      runPublicKeyBase64: secrets.runPublicKeyBase64,
      npmRegistries: secrets.npmRegistries,
      installEnvSecrets: secrets.installEnvSecrets,
      generatedJobs,
      dynamicEntry,
      upstreamSnapshot,
    });
    const rootGeneratedConfigs = generatedJobConfigs.filter((c) => isRootJob(c.genJob));
    const gatedGeneratedConfigs = generatedJobConfigs.filter((c) => !isRootJob(c.genJob));

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
        .addJobsToRun(runId, [{ jobId, jobName, runsOnLabels: [] }])
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
    // Each entry registers its jobs from a task that outlives this call, so it
    // holds its own token. Taken synchronously here — before
    // dispatchMatchedWorkflow's finally drops the build-window token — so the
    // run is never momentarily un-held between the two.
    const held = executionTracker?.holdRunForPendingJobs(ctx.runId) ?? false;
    const spawned = processDynamicEntry({ ctx, setup, buildPrep, secrets, dynamicEntry });
    // Released via `.finally()` on the spawned promise rather than a
    // try/finally inside processDynamicEntry: it returns early above its own
    // try, and running after its catch is what lets the synthetic
    // `dynamic-eval-failed-*` row land while the token is still held.
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
        void executionTracker?.releasePendingJobsHold(ctx.runId).catch((err: unknown) => {
          logger.error('Failed to release pending-jobs hold', {
            runId: ctx.runId,
            error: toErrorMessage(err),
          });
        });
      });
  }
}

/**
 * When ALL jobs are deferred (no static dispatched, no init dispatched yet),
 * we must create the execution_runs row BEFORE dispatching deferred-init or
 * deferred-dynamic jobs. Otherwise a fast init/dyn completion triggers
 * onJobStatus → execution_jobs INSERT against a non-existent run (FK
 * violation).
 */
async function ensureExecutionRunForDeferred(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  declaredContexts: readonly string[];
  dispatchedJobs: DispatchedJob[];
  deferredInitCount: number;
  reason: 'init' | 'dynamic';
  /** True when the run row already exists (see `recordRunStart`). */
  runTrackedEarly: boolean;
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
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, decision } = ctx;
  const { triggeredBy, triggeredByAgentLabel } = ctx;
  // A second `onExecutionStarted` would reset the in-memory job map, so the row
  // is only bootstrapped here when nothing has registered the run yet.
  if (!deps.executionTracker || runTrackedEarly) return;
  if (dispatchedJobs.length !== 0) return;
  if (reason === 'dynamic' && deferredInitCount > 0) return;
  await deps.executionTracker.onExecutionStarted(
    runId,
    workflow.name,
    setup.info.provider,
    repoIdentifier,
    event.targetBranch,
    ref,
    setup.effectiveDeliveryId,
    credentials as Record<string, unknown>,
    dispatchTriggerDecision(ctx, decision),
    [],
    setup.info.routingKey,
    declaredContexts.length > 0 ? [...declaredContexts] : undefined,
    dispatchTriggerEvent(ctx),
    extractCommitMessage(setup.info.event, setup.info.payload),
    undefined, // parentRunId
    triggeredBy,
    undefined, // originalRunId
    setup.workflowConcurrency,
    setup.workflowTimeoutMs,
    setup.checkMode,
    undefined, // localWorkingTree
    event.senderUsername ?? undefined,
    event.senderUserId ?? undefined,
    triggeredByAgentLabel, // triggeredByAgentLabel
    event.prNumber ?? null,
  );
  await stampChainDepth(ctx);
}

/**
 * Complete the check runs `setupDispatchContext` posted, for a dispatch that
 * ends without any job.
 *
 * Every early exit below that phase inherits the same defect: the queued
 * `kici/<workflow>` and per-job checks are already on the commit, and the row
 * each exit writes (`recordInitFailureRun`, `onBuildFailed`) fires
 * `onExecutionStatusChange` only — never `onExecutionComplete`, which is the
 * one callback wired to `updateWorkflowStatus`. Left alone the checks stay
 * `queued` forever and block branch protection.
 *
 * The names come from `ctx` + `setup`, matching the `setPendingAwait` call in
 * `setupDispatchContext` field for field. Never throws: a provider error must
 * not turn a recorded failure into a dispatch error.
 *
 * `setup` is optional so the top-level catch can call this with `ctx` alone. A
 * throw can land before `dispatchMatchedWorkflowInner` returns its `setup` to
 * anyone, but the two fields read off it — the effective provider and routing
 * key — are `setupDispatchContext`'s own overlay of values `ctx` already
 * carries, so the fallback reproduces them rather than approximating them.
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
      // No `workflowRepoIdentifier`: `setupDispatchContext` passes none, so the
      // checks on the commit carry the unqualified name.
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
 * Persist a failed `execution_runs` row for a pre-dispatch early-exit so the
 * dashboard's Runs view surfaces secret_resolution / install_secrets /
 * context_rules rejections instead of leaving the run with zero trace, and
 * complete the check runs that exit strands.
 *
 * Called from every early-exit site in `dispatchMatchedWorkflow` that ends the
 * dispatch with an init failure — the approval-misconfig gate, workflow
 * secrets, install secrets, both sandbox denials, and the no-jobs guard. The
 * helper is a no-op when no `executionTracker` is wired into deps (test /
 * minimal deployments).
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
    // The run row's `ref` is the branch the run PRESENTS — the same value
    // `onExecutionStarted` writes on the ordinary path, and the one the context
    // branch gate evaluates. Not `sourceBranch`: a job's checkout ref is the PR
    // head branch, which a fork contributor names freely, and this row is read
    // back as a branch claim by the internal-event branch inheritance.
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
  });

  // The run is terminal and no job will ever run, so the queued checks have to
  // be closed here. Outside the tracker guard above: the check runs come from a
  // different dependency, so a deployment without a tracker can still have them
  // on the commit.
  await completeChecksForUndispatchedRun({
    ctx,
    setup,
    conclusion: CheckRunConclusion.enum.failure,
    summary: `This run failed before any job started (${category}). ${reason}`,
  });
}

/**
 * Fail the run loud when the lock file's always-mode approval config carries an
 * invalid `timeoutSeconds` (non-positive / non-finite). Runs before any job
 * dispatches so an invalid value can never reach the hold builders (no past
 * `expires_at`, no `new Date(Infinity)` crash). Returns true when it recorded an
 * `approval_misconfig` init-failure (the caller must then short-circuit).
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
 * Pause the workflow dispatch at the install gate: write a `held` execution_runs
 * row (reused on resume), create the workflow-scoped held_runs row, and persist
 * the pending workflow context so the release path can rebuild + resume the
 * dispatch. No jobs are queued.
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
      // The run row's `ref` is the branch the run PRESENTS — the same value
      // `onExecutionStarted` writes on the ordinary path, and the one the context
      // branch gate evaluates. Not `sourceBranch`: a job's checkout ref is the PR
      // head branch, which a fork contributor names freely, and this row is read
      // back as a branch claim by the internal-event branch inheritance.
      ref: event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      providerContext: (credentials ?? {}) as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      contextName: hold.envName,
      reason: hold.requirement.reason,
      triggerEvent: dispatchTriggerEvent(ctx),
      commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
      ...preDispatchRunProvenance(ctx),
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

  await storePendingWorkflowContext(deps.db, toSerializableInputs(ctx));
}

/**
 * How long the security hold raised by `decision` stays approvable.
 *
 * The window rides on the decision itself, from the same policy read that
 * produced the verdict — no second DB read, so no TOCTOU and no divergence
 * between deciding and sizing. A decision carrying no window falls back to the
 * documented default.
 */
function securityHoldExpiryMs(decision: Extract<TrustPolicyOutcome, { action: 'hold' }>): number {
  const seconds = decision.approvalExpirySeconds ?? DEFAULT_APPROVAL_EXPIRY_SECONDS;
  return seconds * 1_000;
}

/**
 * Hold a run in the security queue because the org trust policy said so. The
 * reason travels from the policy gate, so one helper covers every arm.
 *
 * Mirrors the install-gate hold, including its resume context: the hold fires
 * before any job is materialized, so there is no job to re-dispatch and the
 * whole workflow dispatch is stored and replayed instead. `/kici approve`
 * releases the workflow-scoped hold through `resumeWorkflow`, which re-runs this
 * dispatch with `reuseRunId` set — so `applyTrustPolicyGate` short-circuits and
 * the run continues into the gates it never reached, still carrying the
 * `trustResolution` this dispatch resolved. `/kici reject` cancels the run and
 * drops the context; stale-detector expiry fails it.
 *
 * The held `execution_runs` row carries the PR number so the PR-scoped
 * `/kici approve|reject` comment path (which joins on `pr_number`) can attribute
 * and release the hold — a NULL would leave it fail-closed unreachable.
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
      // The run row's `ref` is the branch the run PRESENTS — the same value
      // `onExecutionStarted` writes on the ordinary path, and the one the context
      // branch gate evaluates. Not `sourceBranch`: a job's checkout ref is the PR
      // head branch, which a fork contributor names freely, and this row is read
      // back as a branch claim by the internal-event branch inheritance.
      ref: event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      providerContext: (credentials ?? {}) as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      reason: decision.reason,
      triggerEvent: dispatchTriggerEvent(ctx),
      commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
      prNumber: event.prNumber ?? null,
      ...preDispatchRunProvenance(ctx),
    });
  }

  let heldRow: HeldRun | undefined;
  if (deps.heldRunStore) {
    const holdData = {
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
    // The row and the context it resumes from are written TOGETHER, the same
    // pairing `holdJobForApproval` makes and for the same reason: the context
    // is the only thing that can replay this dispatch, so a row that outlived a
    // failed context write would be a hold nothing can release. That run then
    // reaches `failRunResumeLost`, which by its own comment cannot complete the
    // queued `kici/…` checks — so the commit keeps them forever too.
    //
    // Inside the store guard, not around it: the hold row is the only thing
    // that can release this context, so a store-less orchestrator writing one
    // would leave a context nothing can ever reference or clean up.
    const writeHoldAndContext = async (exec?: Transaction<Database>): Promise<HeldRun> => {
      const row = await deps.heldRunStore!.create(ctx.resolvedOrgId, holdData, exec);
      await storePendingWorkflowContext(exec ?? deps.db, toSerializableInputs(ctx));
      return row;
    };
    // A local test run (`kici run`) has no database at all: the context lives
    // only in memory, so there is nothing to make atomic and nothing to enrol.
    heldRow = deps.db
      ? await deps.db.transaction().execute(writeHoldAndContext)
      : await writeHoldAndContext();
  }

  // Gated on the store as well as the poster, and for the same reason the row
  // write is: every route that terminalizes a `KiCI Security` check reaches it
  // through the `held_runs` row this branch writes. A post with no row behind it
  // is a pending check nothing can ever settle.
  if (deps.heldRunStore && heldRow && ctx.bundle?.checkStatusPoster) {
    // The reduced-privilege note belongs here: this hold stores a resume context
    // above, so `/kici approve` replays this dispatch and the run really does
    // execute under the posture the note names. The replay reuses this run id,
    // which short-circuits the trust gate rather than re-resolving trust, so the
    // tier the note is built from is the tier the resumed run carries.
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
 * Answer an `ignore` verdict before the dispatch does anything observable.
 *
 * `ignore` withholds every artifact the event would otherwise leave behind, and
 * setup is already observable: it creates the queued check runs on the commit,
 * and no path from here completes them, so a check left queued sits on the pull
 * request as a branch-protection blocker. Deciding first is what makes the
 * withholding real.
 *
 * The other verdicts are decided after setup by `applyTrustPolicyGate`, because
 * a hold and a rejection both record a run row and post a check that need the
 * setup bag — and because deciding them earlier would change when the
 * approval-misconfig check runs relative to the policy.
 *
 * Returns the terminal dispatch result on `ignore`, or `null` to continue.
 */
function declineIgnoredDispatch(
  ctx: WorkflowDispatchContext,
  opts: DispatchMatchedWorkflowOptions,
): DispatchMatchedWorkflowResult | null {
  // The same resume guard the gate applies: a re-entry re-dispatches a run
  // whose hold was already released, so the verdict must not act a second time.
  if (opts.reuseRunId) return null;
  if (ctx.securityDecision.action !== 'ignore') return null;
  return ignoredDispatchResult();
}

/**
 * PR-wide trust-policy gate: the org policy decides whether a non-trusted
 * contributor's PR runs, is held for approval, or is rejected outright.
 *
 * Runs before any job dispatch and short-circuits the context gate, so a PR
 * that trips both never produces two competing holds. Skipped on a resume
 * re-entry (a released hold re-running this dispatch).
 *
 * Returns the terminal dispatch result when the gate acted, or `null` to let
 * dispatch continue.
 */
async function applyTrustPolicyGate(
  ctx: WorkflowDispatchContext,
  setup: DispatchSetup,
  opts: { reuseRunId?: string | false },
): Promise<DispatchMatchedWorkflowResult | null> {
  // A resume re-entry re-dispatches a run whose hold was already released, so
  // the gate must not act a second time.
  if (opts.reuseRunId) return null;

  const decision = ctx.securityDecision;
  switch (decision.action) {
    case 'pass':
      return null;
    case 'ignore':
      // Redundant with `declineIgnoredDispatch`, which answers this verdict
      // before setup can post a check run — kept so the switch stays total over
      // the outcome union. Without the arm an `ignore` reaching here would fall
      // to `default` and be rejected, writing exactly the visible failed run
      // the verdict exists to withhold.
      return ignoredDispatchResult();
    case 'hold':
      await holdRunForSecurityPolicy({ ctx, setup, decision });
      return { dispatchedJobCount: 0, dispatchedJobIds: [], held: true };
    case 'reject':
      await rejectRunForSecurityPolicy({ ctx, setup, decision });
      return { dispatchedJobCount: 0, dispatchedJobIds: [] };
    default: {
      // An action this build does not recognise denies. Falling through would
      // dispatch untrusted code.
      //
      // No producer reaches this arm today. Every `securityDecision` comes from
      // `evaluateTrustPolicy`, which returns only `pass` / `hold` / `ignore` —
      // an unrecognised `forkPolicy` value hits ITS default and becomes a
      // `hold`, so a newer Platform writing an unknown value into the plain-TEXT
      // policy column is absorbed there rather than arriving here. This arm is
      // the fail-closed answer held ready for a producer that returns an action
      // the switch above does not name, one step stricter than the evaluator's
      // own "a verdict I do not understand holds" stance because by here the run
      // is about to start.
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
 * Fail a run before any job starts because the org trust policy rejected it.
 *
 * Uses the run-scoped init-failure path so the rejection is visible in the run
 * list and the audit trail rather than vanishing, and posts the failure through
 * the same check poster the hold path uses so a policy tightened from hold to
 * reject updates that check in place. It also completes the queued check runs
 * `setupDispatchContext` posted, which nothing else on this path would.
 *
 * Both call sites are in `applyTrustPolicyGate`, and neither is reachable
 * through today's producers — see the `default` arm there for why. The function
 * is the terminal shape a `reject` verdict would take, kept whole so an action
 * that does arrive is denied completely rather than half-recorded.
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
    // The run row's `ref` is the branch the run PRESENTS — the same value
    // `onExecutionStarted` writes on the ordinary path, and the one the context
    // branch gate evaluates. Not `sourceBranch`: a job's checkout ref is the PR
    // head branch, which a fork contributor names freely, and this row is read
    // back as a branch claim by the internal-event branch inheritance.
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

  // `setupDispatchContext` already posted the queued `kici/<workflow>` and
  // per-job checks, and this rejection dispatches nothing — so nothing else
  // ever completes them. The security check above is a different check run
  // (`KiCI Security`), so posting it leaves these untouched.
  //
  // Same summary on both. Branch protection usually requires
  // `kici/<workflow>`, so that check is often the only one a contributor reads
  // — and the half that matters is the last line, which says the run cannot be
  // approved and names what an org owner has to change.
  await completeChecksForUndispatchedRun({
    ctx,
    setup,
    conclusion: CheckRunConclusion.enum.failure,
    summary: rejectionSummary,
  });
}

/**
 * Phases I + J — hand the deferred work off to its fire-and-forget tasks.
 *
 * A workflow whose jobs are ALL deferred dispatched nothing in the static loop,
 * so nothing has registered the run yet; `ensureExecutionRunForDeferred`
 * bootstraps the row first so the first `onJobStatus` from an init / dynamic
 * agent has a parent run to attach to. Each task then takes its own
 * pending-jobs token, since its jobs are registered after this call returns.
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
  });
  startDeferredDynamicDispatch({ ctx, setup, buildPrep, secrets });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Dispatch a single matched workflow.
 *
 * Narrative orchestrator: each phase is a typed helper that returns a typed
 * result the next phase consumes. The function reads top-to-bottom as the
 * pipeline:
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
  // Belt-and-braces against a stale flag arriving on a reused context: this
  // call has not taken a token yet, so it owes no release, and it has not
  // registered a run yet, so it owes no terminalization.
  ctx.dispatchWindowTokenHeld = false;
  ctx.runRegisteredBeforeDispatch = false;
  ctx.pendingChecksPosted = false;
  try {
    return await dispatchMatchedWorkflowInner(ctx, opts);
  } catch (err) {
    // The run row exists but may hold zero jobs — a throw on the first dispatch,
    // or one from the registration itself. Nothing reaps that row: the
    // stale-run detector scans from `execution_jobs` / `dispatch_queue`, orphan
    // recovery needs `status = 'running'`, cold-store archival needs a terminal
    // status, and cancel cannot terminalize it either (completion requires at
    // least one job). It would sit `pending` forever, uncancellable, while the
    // deadline detector re-fired against it every tick. `failRun` writes the
    // terminal row and evicts the in-memory run without needing a job to hang
    // it off.
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
    // The queued checks `setupDispatchContext` posted are on the commit and no
    // job will ever conclude them. The named early exits each complete their
    // own; a throw reaches none of those, and `failRun` above writes the run row
    // without touching a check run — so this is the only place a thrown dispatch
    // can close them.
    //
    // Enumerated by the shape rather than by the throw site: every exit after
    // the checks are posted owes them a conclusion, so the flag is the
    // condition. The hold transaction rolling back is one such throw; it is not
    // a special case, and closing only that one would leave the rest.
    //
    // `setup` is unavailable here — the throw may have escaped before the inner
    // function had one — which is why the helper falls back to `ctx` for the two
    // fields it reads off it.
    //
    // Unconditional once the checks are up, including on a throw that escaped
    // after a resumable hold landed: answering that hold re-enters
    // `dispatchMatchedWorkflow`, whose `setupDispatchContext` posts the queued
    // checks again, so the resume's pending post lands after this conclusion and
    // wins. A permanently `queued` check has no such recovery.
    if (ctx.pendingChecksPosted) {
      await completeChecksForUndispatchedRun({
        ctx,
        conclusion: CheckRunConclusion.enum.failure,
        summary: `The workflow could not be dispatched, so no job started. ${toErrorMessage(err)}`,
      });
    }
    // Still propagated: an infrastructure fault must fail the delivery rather
    // than be swallowed.
    throw err;
  } finally {
    // The build-window token (taken before the build job can go terminal) must
    // never outlive this call. A `finally` covers every early return and every
    // throw — a token left behind would wedge the run in `running` until the
    // stale detector reaps it.
    //
    // This token covers the paths that register the run's post-build jobs
    // before returning: `recordRunStart` for the static set, and the synthetic
    // `needs-pending-*` / `rejected-*` rows for gated and rejected jobs. Jobs
    // whose registration outlives dispatch hold their own token instead:
    // `startDeferredInitDispatch` and `startDeferredDynamicDispatch` each take
    // one synchronously — before this `finally` drops its own — and release it
    // when their fire-and-forget task settles.
    //
    // Releasing can finalize the run (DB writes + Platform forwarding), so it
    // can throw. Swallow-and-log: a throw from a `finally` replaces whatever
    // dispatch was about to return or raise, turning a completed dispatch into
    // a dispatch error and hiding the original build failure.
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
    // The build either failed or was rejected, and this workflow has no dynamic
    // entries to recover through — so no job will ever run. `onBuildFailed`
    // wrote the terminal run row but reaches no check run, and the build's own
    // `kici/<workflow>/setup` check is not one of these.
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

  // Resume path: flip the reused held run row off `held` so the resumed
  // dispatch can proceed into job dispatch. recordRunStart later reuses the row.
  if (opts.reuseRunId && ctx.deps.executionTracker) {
    await ctx.deps.executionTracker.resumeHeldRun(opts.reuseRunId);
  }

  const evalResult = await evaluateJobContexts({ ctx, setup, buildPrep });

  // Resolve the per-job sandbox escape-hatch requests against the org allow-list
  // (the single enforcement point). A denied request fails the whole run loudly
  // before any job is queued; an absent reader defaults to deny-all (safe).
  const sandboxAllowList: SandboxAllowList = ctx.deps.sandboxAllowListReader
    ? await ctx.deps.sandboxAllowListReader.read(ctx.resolvedOrgId)
    : { capabilities: [], allowHostNetwork: false };
  // Same enforcement point, same loud-and-total shape: a Dockerfile build is an
  // escape from the job sandbox, so an untrusted ref is refused here rather than
  // anywhere the agent could be asked to judge it. `sandbox_denied` is the
  // category because that is exactly what this is.
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
    // Record a queryable failed run (this deny is BEFORE recordRunStart, so a
    // plain failRun would leave no trace) so the author sees the denial + reason
    // in the dashboard and the runs API — deny is loud, not silent.
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
    resolvedSecrets: secrets.resolvedSecrets,
    resolvedNamespacedSecrets: secrets.resolvedNamespacedSecrets,
    runPublicKeyBase64: secrets.runPublicKeyBase64,
    npmRegistries: secrets.npmRegistries,
    installEnvSecrets: secrets.installEnvSecrets,
    event: envelopeEvent(ctx.event, ctx.eventWithFiles),
    eventEnvelopeOverride: ctx.eventEnvelopeOverride,
    cacheOrgId: ctx.resolvedOrgId,
    cacheRepoId: ctx.repoIdentifier,
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

  // Register the run BEFORE the first job reaches an agent, so a job that
  // reports terminal on arrival has a run to attach to. See
  // `startRunBeforeDispatch` for the race, and why the token it takes is not
  // optional.
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
  // Jobs whose fan-out could not be materialized (cap / zero-combination /
  // unreachable hosts) get a synthetic terminal row so the run is not considered
  // complete-with-no-jobs and downstreams keep a real needs edge. A genuine
  // failure is recorded as failed with the matrix_expansion category; a
  // narrowed-to-empty runsOnAll is recorded as skipped (its terminalStatus).
  for (const failure of buildPrep.matrixFailures) {
    dispatchedJobs.push({ jobId: failure.jobId, jobName: failure.jobName });
    rejectedJobs.push(
      failure.terminalStatus === ExecutionJobStatus.enum.skipped
        ? failure
        : { ...failure, category: InitFailureCategory.enum.matrix_expansion },
    );
  }
  // Stamp each dispatched job with its ordered bound-context list so the
  // job row persists it for the dashboard (keyed by expanded job name). Test-run
  // skipped contexts + their warning ride along the same map and are also
  // aggregated for the accepted trigger response (the CLI surface).
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

  // Release root invoke gates now that the run, its jobs, and its needs edges
  // all exist. A root gate has no upstream to fire the scheduler, so it is
  // nudged through the same release path; needs-gated gates wait for their
  // upstreams. Runs before the deferred phases so a gate's proxies are in flight
  // by the time downstream jobs are evaluated.
  await invokeRootGates({ ctx, buildPrep });

  // No-jobs guard: nothing registered a job AND there is no deferred recovery
  // path (no deferred-init jobs, no dynamic entries). Without a row the run is
  // either invisible (no early start, hence no row at all) or stuck `pending`
  // forever (an early-started row with zero jobs, which `isRunComplete` can
  // never satisfy and no sweeper reaps). Write a failed run row so the
  // dashboard surfaces it either way — `recordInitFailureRun` overwrites a
  // non-terminal row rather than conflicting with one.
  //
  // A job a context rule rejected does not reach this guard: it registers its
  // own synthetic `rejected-*` row carrying a job-scoped `context_rules` init
  // failure and the rule's reason, so the reader sees which context gated it
  // rather than a run-wide "no agent". The `rejectedJobs` branch below is the
  // fail-safe for a future rejection recorded without a job row, and it takes
  // the recorded category rather than assuming one.
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
