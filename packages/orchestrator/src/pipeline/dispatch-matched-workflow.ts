/**
 * Per-workflow dispatch pipeline.
 *
 * Handles everything that happens AFTER a workflow has been matched against an
 * incoming webhook: payload storage, cache + build coordination, secret
 * resolution, per-job environment evaluation, static job dispatch (cluster +
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
import type { Kysely } from 'kysely';
import {
  isLockStaticJob,
  isLockDynamicJobFn,
  isLockInlineValue,
  ExecutionJobStatus,
  InitFailureCategory,
  CacheRefScope,
  HoldScope,
  TriggerSource,
  materializeFanout,
  materializeResolvedMatrix,
  materializeResolvedHosts,
  matrixEnvelopeFields,
  FanoutError,
  FanoutCause,
  VariantKind,
  partitionMatchers,
  hostSatisfiesTarget,
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
} from '@kici-dev/engine';
import { HostStatus, type MatchedHost, type HostRosterStore } from '../agent/host-roster.js';
import type { Database } from '../db/types.js';
import { parseOutputsCell } from '../orchestrator-core.js';
import { AgentJobFailedError } from '../cache/agent-job-failed-error.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RunContext, JobToRoute } from '../cluster/coordinator.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { CreateHeldRunData } from '../environments/held-runs.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../environments/protection/pipeline.js';
import { toEnvironment } from '../environments/environment-store.js';
import { resolveInstallSecrets, type NpmRegistrySpec } from './install-secrets-resolver.js';
import { storePendingWorkflowContext, toSerializableInputs } from './pending-workflow-context.js';
import { generateRunKeyPair, encryptPrivateKey } from '../secrets/ephemeral-keys.js';
import { evaluateInlineFields } from './inline-eval.js';
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
  buildSecurityHoldSummary,
  buildTriggerEvent,
  extractCommitMessage,
  isRootJob,
  trackEvalGate,
  type ProcessingDeps,
} from './processor.js';

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
  workflow: LockWorkflow;
  decision: WorkflowDecision;
  runId: string;
  trustResolution: TrustResolution | undefined;
  lockFileSource: string | undefined;
  /** True only when invoked from the cross-source dispatch shell. */
  crossSource: boolean;
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
   * declares an `environment:`. Merged UNDER the per-job env-resolved secrets so
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
}

export interface DispatchMatchedWorkflowResult {
  /** Number of jobs successfully dispatched (non-rejected). */
  dispatchedJobCount: number;
  /** Execution job ids of every dispatched/tracked job (root, gated, synthetic). */
  dispatchedJobIds: string[];
  /** True when the workflow install gate paused the dispatch (held run). */
  held?: boolean;
}

/** Options controlling a (re-)dispatch of a matched workflow. */
export interface DispatchMatchedWorkflowOptions {
  /**
   * Resume path: skip the workflow install protection gate (already satisfied)
   * so secrets resolve directly and the dispatch flows into job dispatch.
   */
  skipInstallProtectionGate?: boolean;
  /** The released held-run id being resumed (for logging / correlation). */
  reuseHeldRunId?: string;
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
  environmentName?: string;
  environmentVars?: Record<string, string>;
  jobEnv?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
  held?: boolean;
  /**
   * Pending approval hold for this job, set when an environment policy or
   * explicit lock `approval` requires human sign-off. The dispatch loop turns
   * this into a `held_runs` row + a stored pending job context so `release()`
   * can re-dispatch after approval.
   */
  approvalHold?: PendingApprovalHold;
  rejected?: boolean;
  rejectReason?: string;
  pendingInit?: boolean;
}

/** A resolved approval requirement awaiting hold creation in the dispatch loop. */
interface PendingApprovalHold {
  scope: HoldScope;
  triggerSource: TriggerSource;
  requirement: ApprovalRequirement;
  environmentId: string | null;
  queueType: 'environment' | 'security';
}

interface DeferredInitJob {
  mat: MaterializedJob;
  initJobInput: QueuedJobInput;
}

interface JobEnvEvalResult {
  jobEnvironmentData: Map<string, JobEnvData>;
  deferredInitJobs: DeferredInitJob[];
  runEnvironmentName: string | undefined;
}

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

  if (deps.logStorage) {
    const payloadPath = `executions/${runId}/webhook-payload.json`;
    const payloadBytes = JSON.stringify(info.payload);
    const backend = deps.logStorage.constructor.name;
    try {
      await deps.logStorage.append(payloadPath, payloadBytes);
      logger.info('Stored webhook payload for run', {
        runId,
        payloadPath,
        bytes: payloadBytes.length,
        logStorageBackend: backend,
      });
    } catch (err) {
      logger.error('Failed to store webhook payload', {
        runId,
        payloadPath,
        bytes: payloadBytes.length,
        logStorageBackend: backend,
        error: toErrorMessage(err),
      });
    }
  }

  const workflowConcurrency = workflow.concurrency
    ? {
        cancelInProgress: workflow.concurrency.cancelInProgress,
        max: workflow.concurrency.max,
      }
    : undefined;

  const workflowTimeoutMs = workflow.timeout;

  if (deps.onSourceLocationsExtracted) {
    for (const job of workflow.jobs.filter(isLockStaticJob)) {
      const locs = job.steps.map((s) => s.sourceLocation);
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
  }

  return { dispatcher, info, effectiveDeliveryId, workflowConcurrency, workflowTimeoutMs };
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
  // not a cacheable provider build — skip the source/dep cache probe entirely so
  // a stale cached tarball never shadows the overlay.
  if (!ctx.bundle) {
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
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, decision } = ctx;
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
            summarizeDecision(decision),
            [
              {
                jobId: syntheticId,
                jobName: buildJobName,
                runsOnLabels: buildJobInput.runsOnLabels,
              },
            ],
            setup.info.routingKey,
            undefined,
            buildTriggerEvent(event.type, event.action),
            extractCommitMessage(setup.info.event, setup.info.payload),
            undefined,
            undefined,
            undefined,
            setup.workflowConcurrency,
            setup.workflowTimeoutMs,
          );
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
          summarizeDecision(decision),
          [{ jobId: buildJobId, jobName: buildJobName, runsOnLabels: buildJobLabels }],
          setup.info.routingKey,
          undefined,
          buildTriggerEvent(event.type, event.action),
          extractCommitMessage(setup.info.event, setup.info.payload),
          undefined,
          undefined,
          undefined,
          setup.workflowConcurrency,
          setup.workflowTimeoutMs,
        );
        buildJobTrackedEarly = true;
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
          buildTriggerEvent(event.type, event.action),
          extractCommitMessage(setup.info.event, setup.info.payload),
          buildFailureReason,
          buildInitFailure,
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
  const matched = await deps.hostRosterStore.findMatching(
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
  const unreachableDurable: MatchedHost[] = [];
  for (const h of candidates) {
    if (h.status === HostStatus.ready) {
      targets.push(h);
    } else if (h.lifecycleClass === 'ephemeral') {
      continue; // stale ephemeral (scaled down) → skip, never policy-controlled
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

  return targets.map((h) => ({
    agentId: h.agentId,
    host: h.host,
    labels: h.labels,
    platform: h.platform ?? undefined,
    arch: h.arch ?? undefined,
    connectedInstanceId: h.connectedInstanceId,
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
 * child, children are ordered deterministically by `variant_label` (the matrix
 * suffix / hostname, via `expandedName`) and every child at index `>=
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
    const ordered = [...children].sort((a, b) => a.expandedName.localeCompare(b.expandedName));
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
      const result = lockJob.runsOnAll
        ? materializeResolvedHosts(
            lockJob,
            await resolveHostFanoutTargets(lockJob, deps, target),
            deps.maxFanoutHosts ?? 1024,
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
  const { deps, workflow, fullLockFile, crossSource } = ctx;
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
  const cacheInfraAvailable =
    !crossSource && !!ctx.bundle && deps.buildCoordinator && (deps.sourceCache || deps.depCache);
  const buildNeeded = cacheInfraAvailable && !sourceHit && !!contentHash;

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
 * per-dispatch fields. Fires per-environment protection rules, looks up
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
  environmentId: string;
  holdType: string;
  queueType: 'environment' | 'security';
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
    jobId: `__install__${workflow.name}`,
  };

  const result = await resolveInstallSecrets({
    registries: workflow.registries,
    installEnv: workflow.installEnv,
    allowHttpNpmRegistries: allowHttp,
    resolvedOrgId,
    trustResolution,
    environmentStore: deps.environmentStore,
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
        environmentId: result.environmentId,
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
// Phase D — per-job environment evaluation
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
      `kici:role:init-runner`,
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig: {
      initOnly: true,
      // The init job resolves dynamic fields against the BASE job definition in
      // source; for a dynamic matrix the base name is what findJobByName needs.
      targetJobName: mat.baseName,
      workflowName: workflow.name,
      source: workflow.source?.file ?? fullLockFile.source.file,
      dynamicEnvironment: lockJob.dynamicEnvironment ?? false,
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
 * Union the explicit lock approval clauses with the environment reviewer
 * clauses into a single AND list (deduped). Both sets must be satisfied.
 */
function unionApprovalClauses(
  lockApproval: LockApproval | undefined,
  envClauses: ApproverClause[] | undefined,
): ApproverClause[] {
  const all = [...(envClauses ?? []), ...(lockApproval?.clauses ?? [])];
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
    environmentId: null,
    queueType: 'environment',
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
    environmentId: null,
    queueType: 'environment',
    requirement: {
      clauses: approval.clauses,
      expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      reason: approval.reason ?? 'Held for workflow approval',
    },
  };
}

/**
 * Apply per-job environment data: protection rules, hold creation, environment
 * variables, and per-job secret resolution. Mutates `jobEnvData` in place.
 */
async function applyEnvironmentRulesAndSecrets(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  environmentName: string;
  concurrencyGroup: string | undefined;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, lockJob, environmentName, concurrencyGroup, jobEnvData } = args;
  const { deps, repoIdentifier, credentials, event, ref, runId, workflow, resolvedOrgId, bundle } =
    ctx;
  const { trustResolution } = ctx;
  if (!deps.environmentStore) return;
  const envConfig = await deps.environmentStore.matchEnvironment(resolvedOrgId, environmentName);
  if (!envConfig) return;
  const env = toEnvironment(envConfig);
  const jobId = randomUUID();
  const dispatchCtx: JobDispatchContext = {
    branch: event.targetBranch,
    triggerType: event.type,
    repository: repoIdentifier,
    runId,
    jobId,
  };
  const effectiveConcurrencyGroup = concurrencyGroup ?? environmentName;
  let runningCount = 0;
  if (deps.db) {
    const result = await deps.db
      .selectFrom('execution_jobs')
      .select(deps.db.fn.countAll<number>().as('count'))
      .where('execution_jobs.status', '=', ExecutionJobStatus.enum.running)
      .innerJoin('execution_runs', 'execution_runs.run_id', 'execution_jobs.run_id')
      .where('execution_runs.environment', '=', effectiveConcurrencyGroup)
      .executeTakeFirst();
    runningCount = Number(result?.count ?? 0);
  }
  const gateResult = await evaluateProtectionRules(
    env,
    dispatchCtx,
    runningCount,
    effectiveConcurrencyGroup,
    trustResolution?.tier as TrustTier | undefined,
  );
  if (gateResult.action === 'reject') {
    jobEnvData.rejected = true;
    jobEnvData.rejectReason = gateResult.reason ?? 'Rejected by protection rules';
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
    const holdExpiryMs = (env.holdExpirySeconds ?? 3600) * 1000;
    const expiresAt = (
      gateResult.holdUntil ? new Date(gateResult.holdUntil) : new Date(Date.now() + holdExpiryMs)
    ).toISOString();
    const isApprovalHold =
      gateResult.action === 'hold' && (gateResult.holdType ?? 'reviewer') === 'reviewer';
    // An approval hold (reviewer gate) defers hold creation to the dispatch
    // loop so the resume path can store the job's dispatch context. Security /
    // wait / queue holds keep the legacy immediate-create behaviour.
    if (deps.heldRunStore && isApprovalHold) {
      const explicit = unionApprovalClauses(lockJob.approval, gateResult.clauses);
      jobEnvData.approvalHold = {
        scope: HoldScope.enum.job,
        triggerSource: TriggerSource.enum.environment,
        environmentId: env.id,
        queueType: 'environment',
        requirement: {
          clauses: explicit,
          expiresAt,
          reason: gateResult.reason ?? 'Held for approval',
        },
      };
    } else if (deps.heldRunStore) {
      const heldRunData: CreateHeldRunData = {
        runId,
        jobId,
        environmentId: env.id,
        holdType: gateResult.holdType ?? 'reviewer',
        queueType: gateResult.holdType === 'security' ? 'security' : 'environment',
        reason: gateResult.reason ?? `Held by ${gateResult.action} gate`,
        expiresAt: new Date(expiresAt),
      };
      await deps.heldRunStore.create(resolvedOrgId, heldRunData);
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
    if (gateResult.holdType === 'security' && bundle?.checkStatusPoster) {
      const holdSummary = buildSecurityHoldSummary(
        'environment_trust',
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
            runId,
            job: lockJob.name,
            error: toErrorMessage(err),
          });
        });
    }
  }

  if (deps.variableStore && !jobEnvData.rejected && !jobEnvData.held) {
    const envVars = await deps.variableStore.getResolvedVars(
      resolvedOrgId,
      env.id,
      ctx.info.routingKey,
    );
    if (Object.keys(envVars).length > 0) {
      jobEnvData.environmentVars = envVars;
    }
  }
  if (deps.secretResolver && !jobEnvData.rejected && !jobEnvData.held) {
    try {
      const envSecrets = await deps.secretResolver.resolveForJob(resolvedOrgId, environmentName);
      if (Object.keys(envSecrets).length > 0) {
        jobEnvData.jobSecrets = envSecrets;
        jobEnvData.jobNamespacedSecrets = { [environmentName]: envSecrets };
      }
    } catch (err) {
      logger.error('Per-job secret resolution failed', {
        runId,
        workflow: workflow.name,
        job: lockJob.name,
        environment: environmentName,
        error: toErrorMessage(err),
      });
    }
  }
}

/**
 * Phase D — evaluate static jobs' environment data, queue deferred-init jobs
 * for jobs with dynamic fields, and pick the first `runEnvironmentName` for
 * the run.
 */
async function evaluateJobEnvironments(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
}): Promise<JobEnvEvalResult> {
  const { ctx, setup, buildPrep } = args;
  const { deps } = ctx;
  // Dynamic functions receive the normalized event envelope (same shape as
  // rules' ctx.event); the raw provider payload stays at event.payload.
  const inlineEvent: object = ctx.event;
  const jobEnvironmentData = new Map<string, JobEnvData>();
  const deferredInitJobs: DeferredInitJob[] = [];
  let runEnvironmentName: string | undefined;

  for (const mat of buildPrep.materializedJobs) {
    const lockJob = mat.lockJob;
    const jobEnvData: JobEnvData = {};
    const { inlineEnvironmentName, inlineEnv, inlineConcurrencyGroup } = evaluateInlineFields(
      lockJob,
      inlineEvent,
    );
    if (inlineEnvironmentName || inlineEnv || inlineConcurrencyGroup) {
      logger.debug('Inline evaluation resolved dynamic fields', {
        job: mat.expandedName,
        environment: !!inlineEnvironmentName,
        env: !!inlineEnv,
        concurrencyGroup: !!inlineConcurrencyGroup,
      });
    }
    const needsInit =
      (lockJob.dynamicEnvironment && !isLockInlineValue(lockJob.environment)) ||
      (lockJob.dynamicEnv && !isLockInlineValue(lockJob.env)) ||
      (lockJob.dynamicConcurrencyGroup && !isLockInlineValue(lockJob.concurrencyGroup)) ||
      // A dynamic matrix is resolved by the same agent-eval init flow: the agent
      // runs the matrix fn, returns the combinations, and the init-result path
      // re-materializes N children at dispatch.
      mat.pendingDynamicMatrix === true;

    if (needsInit && deps.pendingInits) {
      jobEnvData.pendingInit = true;
      deferredInitJobs.push(buildDeferredInitJob({ ctx, setup, buildPrep, mat }));
      jobEnvironmentData.set(mat.expandedName, jobEnvData);
      continue;
    }

    const environmentName: string | undefined =
      inlineEnvironmentName ??
      (lockJob.dynamicEnvironment
        ? undefined
        : typeof lockJob.environment === 'string'
          ? lockJob.environment
          : undefined);
    const jobEnv: Record<string, string> | undefined =
      inlineEnv ??
      (lockJob.dynamicEnv ? undefined : !isLockInlineValue(lockJob.env) ? lockJob.env : undefined);
    const concurrencyGroup: string | undefined =
      inlineConcurrencyGroup ??
      (lockJob.dynamicConcurrencyGroup
        ? undefined
        : typeof lockJob.concurrencyGroup === 'string'
          ? lockJob.concurrencyGroup
          : undefined);

    if (jobEnv) jobEnvData.jobEnv = jobEnv;
    if (environmentName) {
      jobEnvData.environmentName = environmentName;
      if (!runEnvironmentName) runEnvironmentName = environmentName;
      await applyEnvironmentRulesAndSecrets({
        ctx,
        lockJob,
        environmentName,
        concurrencyGroup,
        jobEnvData,
      });
    }
    // Explicit SDK requireApproval on a job with no environment-driven hold:
    // hold the job with trigger_source='explicit'.
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
    jobEnvironmentData.set(mat.expandedName, jobEnvData);
  }
  return { jobEnvironmentData, deferredInitJobs, runEnvironmentName };
}

// ---------------------------------------------------------------------------
// Build job config factory
// ---------------------------------------------------------------------------

function makeBuildJobConfig(args: {
  workflow: LockWorkflow;
  fullLockFile: WorkflowDispatchContext['fullLockFile'];
  jobEnvironmentData: Map<string, JobEnvData>;
  resolvedSecrets: Record<string, string> | undefined;
  resolvedNamespacedSecrets: Record<string, Record<string, string>> | undefined;
  runPublicKeyBase64: string | undefined;
  npmRegistries: NpmRegistrySpec[] | undefined;
  installEnvSecrets: Record<string, string> | undefined;
  event: SimulatedEvent;
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
}): BuildJobConfigFn {
  const {
    workflow,
    fullLockFile,
    jobEnvironmentData,
    resolvedSecrets,
    resolvedNamespacedSecrets,
    runPublicKeyBase64,
    npmRegistries,
    installEnvSecrets,
    event,
    cacheOrgId,
    cacheRepoId,
    cacheRefScope,
    omitContentHash,
    runWideFlatSecrets,
  } = args;
  return (mat: MaterializedJob): Record<string, unknown> => {
    const lockJob = mat.lockJob;
    const envData = jobEnvironmentData.get(mat.expandedName);
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
      steps: lockJob.steps,
      needs: lockJob.needs,
      rules: lockJob.rules,
      ...(workflow.contentHash && !omitContentHash && { contentHash: workflow.contentHash }),
      ...(workflow.resolvedHashFiles?.length && {
        resolvedHashFiles: workflow.resolvedHashFiles,
      }),
      ...(hasSecrets && { secrets: mergedSecrets }),
      ...(hasNamespaced && { namespacedSecrets: mergedNamespaced }),
      ...(runPublicKeyBase64 && { runPublicKey: runPublicKeyBase64 }),
      ...(npmRegistries && npmRegistries.length > 0 && { npmRegistries }),
      ...(installEnvSecrets && Object.keys(installEnvSecrets).length > 0 && { installEnvSecrets }),
      ...(envData?.environmentName && { environment: envData.environmentName }),
      ...(envData?.environmentVars && { environmentVars: envData.environmentVars }),
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
      event,
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
  if (!hold || !deps.heldRunStore || !deps.db) {
    logger.info('Job held by protection rules', {
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
  const heldRow = await deps.heldRunStore.createHold(ctx.resolvedOrgId, {
    runId,
    jobId: mat.expandedName,
    scope: hold.scope,
    triggerSource: hold.triggerSource,
    requirement: hold.requirement,
    environmentId: hold.environmentId,
    queueType: hold.queueType,
  });
  // Audit the hold creation. The orchestrator's dispatch subsystem creates the
  // hold automatically in response to a webhook (no Keycloak user context), so
  // the actor is the dispatcher system component.
  void deps.accessLogWriter?.record({
    orgId: ctx.resolvedOrgId,
    routingKey: ctx.effectiveRoutingKey ?? ctx.info.routingKey ?? null,
    actor: { type: 'system', component: 'dispatcher' },
    action: 'held_run.request',
    target: { type: 'held_run', id: heldRow.id },
    requestId: null,
    source: 'platform_proxy',
    outcome: 'allowed',
    meta: {
      runId,
      jobId: mat.expandedName,
      holdScope: hold.scope,
      triggerSource: hold.triggerSource,
    },
  });
  await storePendingJobContext(deps.db, runId, mat.expandedName, { jobInput, runsOnLabels });

  // Register a synthetic placeholder so the run is not considered complete
  // while the job awaits approval. Uses the same `needs-pending-` prefix as the
  // needs scheduler so release() can resume through dispatchReadyJob, which
  // swaps this placeholder for the real dispatched job id.
  const syntheticId = `needs-pending-${mat.expandedName}-${randomUUID()}`;
  dispatchedJobs.push({
    jobId: syntheticId,
    jobName: mat.expandedName,
    ...(mat.variantValues && { matrixValues: mat.variantValues }),
    runsOnLabels,
  });

  logger.info('Job held for approval', {
    runId,
    workflow: workflow.name,
    job: mat.expandedName,
    scope: hold.scope,
    triggerSource: hold.triggerSource,
    clauses: hold.requirement.clauses.length,
  });

  // Surface the pending approval on the provider's commit check, naming the
  // clauses an approver must satisfy. Step-level holds run inside the agent, so
  // this stays at job granularity. Fire-and-forget: a failed check post must
  // not block the dispatch loop.
  if (ctx.bundle?.checkStatusPoster) {
    const description = summarizeApprovalClauses(hold.requirement.clauses);
    ctx.bundle.checkStatusPoster
      .postCheckStatus(
        ctx.repoIdentifier,
        ctx.ref,
        'pending',
        'Held for approval',
        description,
        ctx.credentials,
      )
      .catch((err) => {
        logger.warn('Failed to post approval hold check', {
          runId,
          job: mat.expandedName,
          error: toErrorMessage(err),
        });
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
    const syntheticId = `needs-pending-${gated.expandedName}-${randomUUID()}`;
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
      } else if (result.status === 'queued-no-backend') {
        logger.warn('Job has no matching backend (cluster fallback), skipping', {
          runId,
          workflow: workflow.name,
          job: jtr.jobName,
          labels: flatLabels,
          excludeLabels: jtr.excludeLabels,
        });
      } else {
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

/** Single-orchestrator path: needs-aware direct dispatch. */
async function dispatchSingleOrchPath(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  buildJobConfig: BuildJobConfigFn;
  jobEnvironmentData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const {
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobEnvironmentData,
    dispatchedJobs,
    rejectedJobs,
  } = args;
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
    const envData = jobEnvironmentData.get(mat.expandedName);
    if (envData?.rejected) {
      logger.info('Job skipped (rejected by protection rules)', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
        reason: envData.rejectReason,
      });
      continue;
    }
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
    if (envData?.pendingInit) continue;

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

    if (!isRootJob(lockJob)) {
      await storePendingJobContext(deps.db, runId, mat.expandedName, { jobInput, runsOnLabels });
      const syntheticId = `needs-pending-${mat.expandedName}-${randomUUID()}`;
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
      const syntheticId = `needs-pending-${mat.expandedName}-${randomUUID()}`;
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
    } else if (result.status === 'queued-no-backend') {
      logger.warn('Job has no matching backend, skipping execution tracking', {
        runId,
        workflow: workflow.name,
        job: mat.expandedName,
        labels: runsOnLabels,
        excludeLabels,
      });
    } else {
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
      environment: envData?.environmentName,
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
  jobEnvironmentData: Map<string, JobEnvData>;
  dispatchedJobs: DispatchedJob[];
  rejectedJobs: RejectedJob[];
}): Promise<void> {
  const {
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobEnvironmentData,
    dispatchedJobs,
    rejectedJobs,
  } = args;
  const { deps, workflow, runId } = ctx;
  if (buildPrep.buildFailed) {
    logger.info('Skipping static job dispatch due to build failure', {
      runId,
      workflow: workflow.name,
      staticJobCount: buildPrep.staticJobs.length,
    });
    return;
  }
  if (deps.coordinator && deps.coordinator.hasConnectedPeers()) {
    const dispatchableJobs = buildPrep.materializedJobs.filter((mj) => {
      const envData = jobEnvironmentData.get(mj.expandedName);
      return !envData?.rejected && !envData?.held && !envData?.pendingInit;
    });
    const rootDispatchableJobs = dispatchableJobs.filter((mj) => isRootJob(mj.lockJob));
    const needsGatedJobs = dispatchableJobs.filter((mj) => !isRootJob(mj.lockJob));
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
    jobEnvironmentData,
    dispatchedJobs,
    rejectedJobs,
  });
}

// ---------------------------------------------------------------------------
// Phase H — execution-tracker registration + edge insertion + rejected mark
// ---------------------------------------------------------------------------

async function recordRunStart(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
  runEnvironmentName: string | undefined;
  dispatchedJobs: DispatchedJob[];
}): Promise<void> {
  const { ctx, setup, buildPrep, declaredContexts, runEnvironmentName, dispatchedJobs } = args;
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
    testRun,
  } = ctx;
  if (!deps.executionTracker || dispatchedJobs.length === 0) return;
  if (buildPrep.buildJobTrackedEarly) {
    const executionJobs = buildPrep.buildJobId
      ? dispatchedJobs.filter((j) => j.jobId !== buildPrep.buildJobId)
      : dispatchedJobs;
    await deps.executionTracker.addJobsToRun(
      runId,
      executionJobs,
      declaredContexts.length > 0 ? [...declaredContexts] : undefined,
    );
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
      summarizeDecision(decision),
      dispatchedJobs,
      setup.info.routingKey,
      declaredContexts.length > 0 ? [...declaredContexts] : undefined,
      buildTriggerEvent(event.type, event.action),
      extractCommitMessage(setup.info.event, setup.info.payload),
      undefined,
      undefined,
      undefined,
      setup.workflowConcurrency,
      setup.workflowTimeoutMs,
    );
  }
  if (runEnvironmentName && deps.db) {
    deps.db
      .updateTable('execution_runs')
      .set({ environment: runEnvironmentName })
      .where('run_id', '=', runId)
      .execute()
      .catch((err) => {
        logger.error('Failed to set environment on execution run', {
          runId,
          environment: runEnvironmentName,
          error: toErrorMessage(err),
        });
      });
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
}

function categorizeRejectReason(reason: string): InitFailureCategory {
  const lower = reason.toLowerCase();
  if (/no\s+agent|no\s+matching\s+backend/.test(lower)) return InitFailureCategory.enum.no_agent;
  return InitFailureCategory.enum.environment_rules;
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
 * After init finishes, resolve the new environment and update jobEnvData with
 * the resolved environment + vars + secrets.
 */
async function applyInitResultEnvironment(args: {
  ctx: WorkflowDispatchContext;
  lockJob: LockJob;
  initResult: { environmentName?: string; env?: Record<string, string> } | undefined;
  jobEnvData: JobEnvData;
}): Promise<void> {
  const { ctx, lockJob, initResult, jobEnvData } = args;
  const { deps, runId, resolvedOrgId } = ctx;
  if (lockJob.dynamicEnvironment && initResult?.environmentName !== undefined) {
    jobEnvData.environmentName = initResult.environmentName;
    if (deps.environmentStore) {
      const env = await deps.environmentStore.matchEnvironment(
        resolvedOrgId,
        initResult.environmentName,
      );
      if (env) {
        jobEnvData.environmentName = env.name;
        if (deps.variableStore) {
          const envVars = await deps.variableStore.getResolvedVars(
            resolvedOrgId,
            env.id,
            ctx.info.routingKey,
          );
          if (Object.keys(envVars).length > 0) {
            jobEnvData.environmentVars = envVars;
          }
        }
        if (deps.secretResolver) {
          try {
            const envSecrets = await deps.secretResolver.resolveForJob(
              resolvedOrgId,
              initResult.environmentName,
            );
            if (Object.keys(envSecrets).length > 0) {
              jobEnvData.jobSecrets = envSecrets;
              jobEnvData.jobNamespacedSecrets = {
                [initResult.environmentName]: envSecrets,
              };
            }
          } catch (err) {
            logger.error('Deferred init: secret resolution failed', {
              runId,
              job: lockJob.name,
              error: toErrorMessage(err),
            });
          }
        }
      }
    }
  }
  if (lockJob.dynamicEnv && initResult?.env !== undefined) {
    jobEnvData.jobEnv = initResult.env;
  }
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
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat } = args;
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
            { jobId: local.jobId, jobName: local.jobName, runsOnLabels: jobInput.runsOnLabels },
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
  jobEnvironmentData: Map<string, JobEnvData>;
}): Promise<void> {
  const { ctx, setup, buildPrep, buildJobConfig, mat, combos, jobEnvironmentData } = args;
  const { deps, workflow, runId } = ctx;

  let result: ReturnType<typeof materializeResolvedMatrix>;
  try {
    result = materializeResolvedMatrix(mat.lockJob, combos);
  } catch (err) {
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
  const baseEnvData = jobEnvironmentData.get(mat.expandedName) ?? {};
  for (const child of result.jobs) {
    jobEnvironmentData.set(child.expandedName, { ...baseEnvData });
    await dispatchExecutionAfterInit({ ctx, setup, buildPrep, buildJobConfig, mat: child });
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
  jobEnvironmentData: Map<string, JobEnvData>;
  deferredInitJobs: DeferredInitJob[];
}): void {
  const { ctx, setup, buildPrep, buildJobConfig, jobEnvironmentData, deferredInitJobs } = args;
  const { deps, workflow, runId } = ctx;
  if (deferredInitJobs.length === 0 || !deps.pendingInits) return;
  logger.info('Starting deferred init dispatch', { runId, count: deferredInitJobs.length });
  const pendingInits = deps.pendingInits;
  for (const { mat, initJobInput } of deferredInitJobs) {
    const lockJob = mat.lockJob;
    void (async () => {
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
        const jobEnvData = jobEnvironmentData.get(mat.expandedName) ?? {};
        jobEnvData.pendingInit = false;
        await applyInitResultEnvironment({ ctx, lockJob, initResult, jobEnvData });
        jobEnvironmentData.set(mat.expandedName, jobEnvData);
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
            jobEnvironmentData,
          });
        } else {
          await dispatchExecutionAfterInit({ ctx, setup, buildPrep, buildJobConfig, mat });
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
      'kici:role:init-runner',
      `kici:os:${buildPrep.targetPlatform}`,
      `kici:arch:${buildPrep.targetArch}`,
    ],
    jobConfig: {
      dynamicJobFn: true,
      workflowName: workflow.name,
      source: dynamicEntry.source,
      event,
      timeoutMs: 120_000,
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
      let genEnvironmentName: string | undefined;
      let genEnvironmentVars: Record<string, string> | undefined;
      let genSecrets: Record<string, string> = { ...resolvedSecrets };
      let genNamespacedSecrets: Record<string, Record<string, string>> = {
        ...resolvedNamespacedSecrets,
      };
      if (typeof genJob.environment === 'string' && deps.environmentStore) {
        genEnvironmentName = genJob.environment;
        const env = await deps.environmentStore.matchEnvironment(resolvedOrgId, genJob.environment);
        if (env) {
          genEnvironmentName = env.name;
          if (deps.variableStore) {
            const envVars = await deps.variableStore.getResolvedVars(
              resolvedOrgId,
              env.id,
              ctx.info.routingKey,
            );
            if (Object.keys(envVars).length > 0) {
              genEnvironmentVars = envVars;
            }
          }
          if (deps.secretResolver) {
            try {
              const envSecrets = await deps.secretResolver.resolveForJob(
                resolvedOrgId,
                genJob.environment,
              );
              if (Object.keys(envSecrets).length > 0) {
                genSecrets = { ...genSecrets, ...envSecrets };
                genNamespacedSecrets = {
                  ...genNamespacedSecrets,
                  [genJob.environment]: envSecrets,
                };
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
        ...(genEnvironmentName && { environment: genEnvironmentName }),
        ...(genEnvironmentVars && { environmentVars: genEnvironmentVars }),
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
    await storePendingJobContext(deps.db, runId, genJob.name, {
      jobInput: gatedJobInput,
      runsOnLabels,
    });
    const syntheticId = `needs-pending-${genJob.name}-${randomUUID()}`;
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

  const { pinnedConfigs, unpinnedConfigs } = partitionGeneratedConfigsByPin(rootGeneratedConfigs);

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
  const { deps, runId } = ctx;
  if (!deps.db) return;
  const affectedJobNames = [
    ...memberJobNames,
    ...staticJobs
      .filter((j) => j.dependsOnGroups && groupName && j.dependsOnGroups.includes(groupName))
      .map((j) => j.name),
  ];
  if (affectedJobNames.length === 0) return;
  const schedulerResults = await recomputeNeedsSatisfied(deps.db, runId, affectedJobNames);
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

/**
 * Gather the frozen upstream snapshot for a result-aware eval: each declared
 * job/group-member's stored outputs (the same plain outputs map that backs
 * jobRef.result), plus group → ordered member names. Captured once, at eval
 * dispatch, and replayed unchanged on agent-side re-eval.
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
  for (const dynamicEntry of buildPrep.dynamicEntries) {
    void processDynamicEntry({ ctx, setup, buildPrep, secrets, dynamicEntry });
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
  buildPrep: BuildPrepResult;
  declaredContexts: readonly string[];
  dispatchedJobs: DispatchedJob[];
  deferredInitCount: number;
  reason: 'init' | 'dynamic';
}): Promise<void> {
  const { ctx, setup, buildPrep, declaredContexts, dispatchedJobs, deferredInitCount, reason } =
    args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId, decision } = ctx;
  if (!deps.executionTracker || buildPrep.buildJobTrackedEarly) return;
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
    summarizeDecision(decision),
    [],
    setup.info.routingKey,
    declaredContexts.length > 0 ? [...declaredContexts] : undefined,
    buildTriggerEvent(event.type, event.action),
    extractCommitMessage(setup.info.event, setup.info.payload),
    undefined,
    undefined,
    undefined,
    setup.workflowConcurrency,
    setup.workflowTimeoutMs,
  );
}

/**
 * Persist a failed `execution_runs` row for a pre-dispatch early-exit so the
 * dashboard's Runs view surfaces secret_resolution / install_secrets /
 * environment_rules rejections instead of leaving the run with zero trace.
 *
 * Called from each of the three early-exit sites in `dispatchMatchedWorkflow`
 * (workflow secrets, install secrets, all-jobs-rejected). The helper is a
 * no-op when no `executionTracker` is wired into deps (test / minimal
 * deployments).
 */
async function recordInitFailureFromSkip(args: {
  ctx: WorkflowDispatchContext;
  setup: DispatchSetup;
  category: InitFailureCategory;
  reason: string;
}): Promise<void> {
  const { ctx, setup, category, reason } = args;
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId } = ctx;
  if (!deps.executionTracker) return;
  await deps.executionTracker.recordInitFailureRun({
    runId,
    workflowName: workflow.name,
    provider: setup.info.provider,
    repoIdentifier,
    ref: event.sourceBranch ?? event.targetBranch,
    sha: ref,
    deliveryId: setup.effectiveDeliveryId,
    providerContext: (credentials ?? {}) as Record<string, unknown>,
    routingKey: setup.info.routingKey,
    initFailure: {
      scope: 'run',
      category,
      message: reason,
    },
    triggerEvent: buildTriggerEvent(event.type, event.action),
    commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
  });
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
  const { deps, workflow, repoIdentifier, credentials, event, ref, runId } = ctx;

  if (deps.executionTracker) {
    await deps.executionTracker.recordRunHeld({
      runId,
      workflowName: workflow.name,
      provider: setup.info.provider,
      repoIdentifier,
      ref: event.sourceBranch ?? event.targetBranch,
      sha: ref,
      deliveryId: setup.effectiveDeliveryId,
      providerContext: (credentials ?? {}) as Record<string, unknown>,
      routingKey: setup.info.routingKey,
      environmentName: hold.envName,
      reason: hold.requirement.reason,
      triggerEvent: buildTriggerEvent(event.type, event.action),
      commitMessage: extractCommitMessage(setup.info.event, setup.info.payload),
    });
  }

  if (deps.heldRunStore) {
    await deps.heldRunStore.createHold(ctx.resolvedOrgId, {
      runId,
      jobId: `__install__${workflow.name}`,
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.environment,
      environmentId: hold.environmentId,
      queueType: hold.queueType,
      holdType: hold.holdType,
      requirement: hold.requirement,
    });
  }

  await storePendingWorkflowContext(deps.db, toSerializableInputs(ctx));
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
  const setup = await setupDispatchContext(ctx);
  const buildPrep = await prepareCacheAndBuild(ctx, setup);
  if (buildPrep.abort) {
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

  const evalResult = await evaluateJobEnvironments({ ctx, setup, buildPrep });
  const buildJobConfig = makeBuildJobConfig({
    workflow: ctx.workflow,
    fullLockFile: ctx.fullLockFile,
    jobEnvironmentData: evalResult.jobEnvironmentData,
    resolvedSecrets: secrets.resolvedSecrets,
    resolvedNamespacedSecrets: secrets.resolvedNamespacedSecrets,
    runPublicKeyBase64: secrets.runPublicKeyBase64,
    npmRegistries: secrets.npmRegistries,
    installEnvSecrets: secrets.installEnvSecrets,
    event: ctx.event,
    cacheOrgId: ctx.resolvedOrgId,
    cacheRepoId: ctx.repoIdentifier,
    cacheRefScope: deriveCacheRefScope(ctx.trustResolution),
    omitContentHash: !!ctx.testRun,
    runWideFlatSecrets: ctx.runWideFlatSecrets,
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

  await dispatchStaticJobs({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobEnvironmentData: evalResult.jobEnvironmentData,
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
  await recordRunStart({
    ctx,
    setup,
    buildPrep,
    declaredContexts: secrets.declaredContexts,
    runEnvironmentName: evalResult.runEnvironmentName,
    dispatchedJobs,
  });
  await insertEdgesAndMarkRejected({
    ctx,
    buildPrep,
    dispatchedJobs,
    rejectedJobs,
  });

  // All-rejected guard: every static job was rejected by per-job environment
  // rules AND there is no deferred recovery path (no deferred-init jobs, no
  // dynamic entries). recordRunStart short-circuits in this case
  // (dispatchedJobs.length === 0), so without this branch the run leaves no
  // trace. Insert a failed run row tagged environment_rules so the dashboard
  // surfaces it.
  if (
    dispatchedJobs.length === 0 &&
    evalResult.deferredInitJobs.length === 0 &&
    buildPrep.dynamicEntries.length === 0 &&
    rejectedJobs.length > 0
  ) {
    await recordInitFailureFromSkip({
      ctx,
      setup,
      category: InitFailureCategory.enum.environment_rules,
      reason: rejectedJobs[0].reason,
    });
  }

  // Deferred phases: bootstrap a run row when ALL jobs are deferred so the
  // first onJobStatus from an init/dynamic agent has a parent run to attach to.
  if (evalResult.deferredInitJobs.length > 0) {
    await ensureExecutionRunForDeferred({
      ctx,
      setup,
      buildPrep,
      declaredContexts: secrets.declaredContexts,
      dispatchedJobs,
      deferredInitCount: evalResult.deferredInitJobs.length,
      reason: 'init',
    });
  }
  startDeferredInitDispatch({
    ctx,
    setup,
    buildPrep,
    buildJobConfig,
    jobEnvironmentData: evalResult.jobEnvironmentData,
    deferredInitJobs: evalResult.deferredInitJobs,
  });

  if (buildPrep.dynamicEntries.length > 0 && ctx.deps.pendingDynamics) {
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
      buildPrep,
      declaredContexts: secrets.declaredContexts,
      dispatchedJobs,
      deferredInitCount: evalResult.deferredInitJobs.length,
      reason: 'dynamic',
    });
    startDeferredDynamicDispatch({ ctx, setup, buildPrep, secrets });
  }

  return {
    dispatchedJobCount: dispatchedJobs.length,
    dispatchedJobIds: dispatchedJobs.map((j) => j.jobId),
  };
}
