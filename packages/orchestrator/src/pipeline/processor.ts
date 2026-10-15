/**
 * Core webhook processing pipeline: dedup -> normalize event -> fetch lock file ->
 * get changed files -> match triggers -> cache check -> dispatch jobs.
 *
 * Provider-agnostic: every provider-specific operation goes through the ProviderRegistry.
 *
 * Decision traces go to the Platform via platformClient.send(), which buffers while
 * disconnected, so the caller does NOT check connection state.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  JobSecretsUnsealError,
  sealJobConfig,
  unsealJobConfig,
} from '../secrets/job-secret-seal.js';
import { HeldRunStatus } from '../contexts/held-runs.js';
import { sql, type Kysely } from 'kysely';
import { githubDisplayMessage } from '../providers/github/commit-message.js';
import type { Database } from '../db/types.js';
import type { SandboxAllowListReader } from './sandbox-allowlist-reader.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { DedupCache } from '../webhook/dedup.js';
import type { ProviderRegistry, ProviderBundle } from '../provider-registry.js';
import type { LockFileCache } from '../lockfile-cache.js';
import type { ContentRequirementsCache } from '../content-requirements-cache.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { PlatformClient } from '../ws/platform-client.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { SourceCache } from '../cache/index.js';
import type { BuildCoordinator } from '../cache/index.js';
import type { DepCache } from '../cache/index.js';
import type { PendingBuildTracker } from '../cache/index.js';
import type { PendingInitTracker } from '../cache/pending-inits.js';
import type { PendingDynamicTracker } from '../cache/pending-dynamics.js';
import type { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import type { GlobalEvalRoundCache } from '../cache/global-eval-round-cache.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { HostRosterStore } from '../agent/host-roster.js';
import type { RunCoordinator } from '../cluster/coordinator.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { LogWriter } from '../reporting/log-writer.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type {
  LockFile as FullLockFile,
  LockWorkflow,
  LockTrigger,
  SimulatedEvent,
  WebhookNormalizer,
} from '@kici-dev/engine';
import { canonicalizeLabels, LockFileParseError } from '@kici-dev/engine';
import type { EventRouter } from '../events/event-router.js';
import type { InvokeGateDeps, InvokeGateParams } from './invoke-gate.js';
import { releaseInvokeGate } from './invoke-gate.js';
import { checkAllUpstreamsSatisfied } from './needs-scheduler.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { CronScheduler } from '../cron/cron-scheduler.js';
import type { GlobalWorkflowPolicy } from '../security/global-workflow-policy.js';
import type { EventLogWriter } from '../webhook/event-log.js';

/** The one event-log method the pipeline calls; a per-delivery wrapper can stand in for the writer. */
export type EventLogRecorder = Pick<EventLogWriter, 'record'>;
import { EventLogSource } from '@kici-dev/engine';
import { ExecutionJobStatus, TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { LockJob } from '@kici-dev/engine';
import type { ContextStore } from '../contexts/context-store.js';
import type { VariableStore } from '../contexts/variable-store.js';
import type { IdentityLink, PermissionLevel } from '../security/identity-link.js';
import { SecurityHoldReason, type HeldRunStore } from '../contexts/held-runs.js';
import { countOccupyingJobs } from '../contexts/release-queued-holds.js';
import { evaluateConcurrencyGate } from '../contexts/protection/concurrency-gate.js';
import {
  DEFAULT_CONCURRENCY_STRATEGY,
  DEFAULT_HOLD_EXPIRY_SECONDS,
  HoldType,
  type Context as EngineContext,
} from '@kici-dev/engine';
import type { OrchestratorMode, WorkflowDecision } from '@kici-dev/engine';
import { truncateDecisionsToByteBudget } from '@kici-dev/engine';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import type { TrustDirectoryStore } from '../security/trust-directory-store.js';
import {
  logReleaseResolutionFailure,
  resolveReleasedJobInput,
  type ContextDataDeps,
  type DeferredContextResolution,
} from './held-context-data.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'pipeline' });

/**
 * Pending dispatch context for a job gated by the needs scheduler, keyed by
 * `${runId}:${jobName}`. Stored at processWebhook time for every non-root static
 * job; consumed by onJobReady once its upstreams are satisfied; cleaned up after
 * dispatch or on run completion.
 */
interface PendingJobContext {
  jobInput: QueuedJobInput;
  runsOnLabels: string[];
  /**
   * When set, this pending job is an invoke gate: on release it summons the
   * source repo's subscribers (`runInvokeGate`) instead of dispatching `jobInput`
   * to an agent.
   */
  invoke?: InvokeGateParams;
  /**
   * Set for a job bound to a context: `dispatchReadyJob` resolves the context
   * variables and secrets from it, since `jobInput` is stored without them.
   * Absent when no context is bound; the stored input dispatches unchanged.
   */
  contextResolution?: DeferredContextResolution;
  /**
   * Set when the stored row's sealed secret fields could not be decrypted:
   * `dispatchReadyJob` fails the job with this reason instead of dispatching
   * it without them.
   */
  secretsUnavailable?: string;
}

/**
 * A stored job input, and the `sealed_secrets` column value that holds its
 * secret fields encrypted. See {@link sealJobConfig}.
 */
function sealedJobInputColumns(
  runId: string,
  jobInput: QueuedJobInput,
): {
  job_input: string;
  sealed_secrets: string | null;
} {
  // Sealed under the row's own `run_id`, the value unseal and rotation bind the AAD to.
  const { jobConfig, sealed } = sealJobConfig(runId, jobInput.jobConfig);
  return { job_input: JSON.stringify({ ...jobInput, jobConfig }), sealed_secrets: sealed };
}

/**
 * A stored job input with its sealed secret fields merged back. A seal that
 * cannot be opened leaves the plain fields and names the failure.
 */
function unsealedJobInput(row: {
  run_id: string;
  job_name: string;
  job_input: unknown;
  sealed_secrets?: string | null;
}): Pick<PendingJobContext, 'jobInput' | 'secretsUnavailable'> {
  const jobInput = row.job_input as unknown as QueuedJobInput;
  try {
    const jobConfig = unsealJobConfig(row.run_id, jobInput.jobConfig, row.sealed_secrets);
    return { jobInput: { ...jobInput, jobConfig } };
  } catch (err) {
    if (!(err instanceof JobSecretsUnsealError)) throw err;
    logger.error('Pending job secrets cannot be decrypted', {
      runId: row.run_id,
      jobName: row.job_name,
      error: err.message,
    });
    return { jobInput, secretsUnavailable: err.message };
  }
}

const pendingJobContexts = new Map<string, PendingJobContext>();

/**
 * Eval-gate registry for result-aware dynamic generators, keyed by
 * `${runId}:${evalJobName}`. A deferred `processDynamicEntry` task registers a
 * gate and awaits it; the needs scheduler opens it when the eval job's upstream
 * `needs` reach a terminal state.
 *
 * Only the in-process wake-up signal lives here; the gating itself stays in the
 * DB-backed `execution_job_needs` scheduler. A module-level singleton because
 * producer and consumer share one process for the awaiting task's lifetime.
 */
const pendingEvalGates = new Map<string, () => void>();

function evalGateKey(runId: string, evalJobName: string): string {
  return `${runId}:${evalJobName}`;
}

/** Register an eval gate; resolves when the scheduler opens it. */
export function trackEvalGate(runId: string, evalJobName: string): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingEvalGates.set(evalGateKey(runId, evalJobName), resolve);
  });
}

/**
 * Open a registered eval gate. Returns true when one existed, so the scheduler
 * must not also run the normal dispatch path.
 */
export function openEvalGate(runId: string, evalJobName: string): boolean {
  const key = evalGateKey(runId, evalJobName);
  const resolve = pendingEvalGates.get(key);
  if (!resolve) return false;
  pendingEvalGates.delete(key);
  resolve();
  return true;
}

/** True when a job name is a result-aware dynamic eval job awaiting its gate. */
export function isEvalGatePending(runId: string, evalJobName: string): boolean {
  return pendingEvalGates.has(evalGateKey(runId, evalJobName));
}

/** Clear all eval gates for a run (called on run completion / cleanup). */
export function clearEvalGatesForRun(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of pendingEvalGates.keys()) {
    if (key.startsWith(prefix)) pendingEvalGates.delete(key);
  }
}

/**
 * Store a pending dispatch context in memory and in the DB (for crash recovery).
 * @internal Exported for testing
 */
export async function storePendingJobContext(
  db: Kysely<Database> | undefined,
  runId: string,
  jobName: string,
  ctx: PendingJobContext,
): Promise<void> {
  pendingJobContexts.set(`${runId}:${jobName}`, ctx);
  if (db) {
    const invokeConfig = ctx.invoke ? JSON.stringify(ctx.invoke) : null;
    const contextResolution = ctx.contextResolution ? JSON.stringify(ctx.contextResolution) : null;
    const stored = sealedJobInputColumns(runId, ctx.jobInput);
    await db
      .insertInto('pending_job_contexts')
      .values({
        run_id: runId,
        job_name: jobName,
        ...stored,
        runs_on_labels: JSON.stringify(ctx.runsOnLabels),
        invoke_config: invokeConfig,
        context_resolution: contextResolution,
      })
      .onConflict((oc) =>
        oc.columns(['run_id', 'job_name']).doUpdateSet({
          ...stored,
          runs_on_labels: JSON.stringify(ctx.runsOnLabels),
          invoke_config: invokeConfig,
          context_resolution: contextResolution,
        }),
      )
      .execute();
  }
}

/**
 * Consume a pending dispatch context from memory and the DB; undefined when none
 * is stored (e.g. the job already dispatched).
 *
 * Cluster correctness: `onJobReady` fires on whichever peer tracked the upstream's
 * completion, which for a rerouted upstream is not the ingesting peer, so its Map
 * is empty. The atomic `DELETE ... RETURNING` fallback lets exactly one peer claim it.
 * @internal Exported for testing
 */
export async function consumePendingJobContext(
  db: Kysely<Database> | undefined,
  runId: string,
  jobName: string,
): Promise<PendingJobContext | undefined> {
  const key = `${runId}:${jobName}`;
  const memCtx = pendingJobContexts.get(key);
  if (memCtx) {
    pendingJobContexts.delete(key);
    if (db) {
      await db
        .deleteFrom('pending_job_contexts')
        .where('run_id', '=', runId)
        .where('job_name', '=', jobName)
        .execute();
    }
    return memCtx;
  }

  if (!db) return undefined;

  const claimed = await db
    .deleteFrom('pending_job_contexts')
    .where('run_id', '=', runId)
    .where('job_name', '=', jobName)
    .returning([
      'job_input',
      'runs_on_labels',
      'invoke_config',
      'context_resolution',
      'sealed_secrets',
    ])
    .execute();

  if (claimed.length === 0) return undefined;

  const row = claimed[0];
  return {
    ...unsealedJobInput({ ...row, run_id: runId, job_name: jobName }),
    // A context stored before labels were canonicalized keeps the author's case,
    // so fold on read. Routing uses `jobInput`; this value feeds the
    // `runs_on_labels` reporting column, so the dashboard shows one case per label.
    runsOnLabels: canonicalizeLabels(row.runs_on_labels as unknown as string[]),
    ...(row.invoke_config != null && {
      invoke: JSON.parse(row.invoke_config) as InvokeGateParams,
    }),
    ...(row.context_resolution != null && { contextResolution: row.context_resolution }),
  };
}

/**
 * Is the pending context for this (run, job) an invoke gate? Reads WITHOUT
 * consuming: the ready-dispatch concurrency re-gate runs before
 * `consumePendingJobContext`, and consuming there would delete the resume path of
 * a job it goes on to re-hold. A missing context is handled by the later consume.
 */
async function pendingJobContextIsInvokeGate(
  db: Kysely<Database> | undefined,
  runId: string,
  jobName: string,
): Promise<boolean> {
  const memCtx = pendingJobContexts.get(`${runId}:${jobName}`);
  if (memCtx) return !!memCtx.invoke;
  if (!db) return false;
  const row = await db
    .selectFrom('pending_job_contexts')
    .select('invoke_config')
    .where('run_id', '=', runId)
    .where('job_name', '=', jobName)
    .executeTakeFirst();
  return row?.invoke_config != null;
}

/** Drop a run's pending dispatch contexts from memory and the DB on run completion. */
export async function cleanupPendingJobContexts(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<void> {
  const prefix = `${runId}:`;
  for (const key of pendingJobContexts.keys()) {
    if (key.startsWith(prefix)) {
      pendingJobContexts.delete(key);
    }
  }
  if (db) {
    await db.deleteFrom('pending_job_contexts').where('run_id', '=', runId).execute();
  }
}

/**
 * Restore pending job contexts from the DB into memory. Runs on startup before
 * the needs scheduler recovery loop, so dispatchReadyJob has them for recovered jobs.
 */
export async function restorePendingJobContexts(db: Kysely<Database>): Promise<number> {
  // Rows of terminal runs linger when a crash beat the fire-and-forget
  // cleanupPendingJobContexts delete.
  await db
    .deleteFrom('pending_job_contexts')
    .where(
      'run_id',
      'in',
      db
        .selectFrom('execution_runs')
        .select(sql<string>`run_id::text`.as('run_id'))
        .where('status', 'in', [...TERMINAL_RUN_STATES]),
    )
    .execute();

  const rows = await db.selectFrom('pending_job_contexts').selectAll().execute();
  for (const row of rows) {
    const key = `${row.run_id}:${row.job_name}`;
    pendingJobContexts.set(key, {
      ...unsealedJobInput(row),
      // Same label fold as the consume path.
      runsOnLabels: canonicalizeLabels(row.runs_on_labels as unknown as string[]),
      ...(row.invoke_config != null && {
        invoke: JSON.parse(row.invoke_config) as InvokeGateParams,
      }),
      ...(row.context_resolution != null && { contextResolution: row.context_resolution }),
    });
  }
  return rows.length;
}

/**
 * Clear the in-memory pending job contexts.
 * @internal Exported for testing only.
 */
export function clearPendingJobContextsMap(): void {
  pendingJobContexts.clear();
}

/**
 * A root job (no concrete needs, no dependsOnGroups) dispatches immediately;
 * others wait for the scheduler.
 */
export function isRootJob(lockJob: LockJob): boolean {
  // A concrete need is a string or a NeedsEntry with 'name'. A directly-registered
  // global entry may omit `needs` (the compiler always emits `needs: []`); missing
  // means no upstreams.
  const hasConcreteNeeds = (lockJob.needs ?? []).some(
    (n) => typeof n === 'string' || (typeof n === 'object' && 'name' in n),
  );
  const hasDependsOnGroups =
    'dependsOnGroups' in lockJob &&
    Array.isArray(lockJob.dependsOnGroups) &&
    lockJob.dependsOnGroups.length > 0;
  return !hasConcreteNeeds && !hasDependsOnGroups;
}

/**
 * Attempt to resolve a lock file for (repoIdentifier, ref) using the inbound
 * webhook's provider bundle first, then falling back to other provider bundles
 * registered against the SAME customer's registrations for the SAME repo.
 *
 * Why: `lockFileFetcher` is bound to the inbound provider bundle. A local-sourced
 * webhook (e.g. a failover-dispatch push through the internal ingress) for a repo
 * whose lock file only another provider (e.g. github) can read gets null, and
 * trigger matching silently drops the webhook.
 *
 * Tenant boundary (security-critical): the fallback iterates ONLY
 * `registrationIndex.getByOrgAndRepo(customerId, repoIdentifier)`, keyed by
 * `${customerId}|${repoIdentifier}`, so cross-customer leakage is structurally
 * impossible. It skips the inbound routing key (no self-recursion) and dedupes by
 * routing key, so many workflows from one source trigger one fallback fetch.
 *
 * Ordering: index order (createdAt ascending); the first non-null lock file wins.
 * All null returns null, and the caller falls through to the `Lock file not found`
 * global-workflow-matching path.
 *
 * Credentials: each fallback fetcher gets the REGISTRATION'S `providerContext`,
 * NOT the inbound credentials. Load-bearing: LocalWebhookNormalizer returns `{}`,
 * which never satisfies a github fetcher needing `installationId`.
 */
export async function resolveLockFileWithFallback(args: {
  inboundBundle: ProviderBundle;
  inboundRoutingKey: string;
  repoIdentifier: string;
  ref: string;
  inboundCredentials: unknown;
  customerId: string;
  providerRegistry: ProviderRegistry;
  registrationIndex: RegistrationIndex | undefined;
  lockFileCache: LockFileCache;
  deliveryId: string;
  /**
   * False when cross-source repo mode already evaluated this delivery's
   * other-source registrations for the repo, which the fallback would re-read.
   * Defaults to true.
   */
  allowRegistrationFallback?: boolean;
}): Promise<{
  lockFile: FullLockFile | null;
  resolvedVia: 'inbound' | 'fallback' | 'miss' | 'corrupt';
  fallbackRoutingKey?: string;
  /** Set on 'fallback': the dispatch site swaps in its repoUrlBuilder and cloneTokenProvider. */
  fallbackBundle?: ProviderBundle;
  /** Set on 'fallback': the registration's providerContext (installationId etc.) for clone tokens. */
  fallbackCredentials?: Record<string, unknown>;
  /** Set on 'corrupt': the parse error. A valid fallback beats a corrupt inbound,
   *  so this surfaces only when NOTHING resolved. */
  corruptError?: LockFileParseError;
}> {
  const {
    inboundBundle,
    inboundRoutingKey,
    repoIdentifier,
    ref,
    inboundCredentials,
    customerId,
    providerRegistry,
    registrationIndex,
    lockFileCache,
    deliveryId,
  } = args;

  // A present-but-unparseable lock file turns the final 'miss' into 'corrupt', so
  // the pipeline records a lock_resolution init-failure run. Any valid lock wins.
  let parseError: LockFileParseError | undefined;
  const missOrCorrupt = (): {
    lockFile: FullLockFile | null;
    resolvedVia: 'miss' | 'corrupt';
    corruptError?: LockFileParseError;
  } =>
    parseError
      ? { lockFile: null, resolvedVia: 'corrupt', corruptError: parseError }
      : { lockFile: null, resolvedVia: 'miss' };

  // 1. Inbound bundle first.
  if (inboundBundle.lockFileFetcher) {
    try {
      const lockFile = (await lockFileCache.get(
        inboundBundle.lockFileFetcher,
        repoIdentifier,
        ref,
        inboundCredentials,
      )) as FullLockFile | null;
      if (lockFile) {
        return { lockFile, resolvedVia: 'inbound' };
      }
    } catch (err) {
      if (err instanceof LockFileParseError) {
        parseError = err;
      } else {
        throw err;
      }
    }
  }

  if (args.allowRegistrationFallback === false) return missOrCorrupt();

  // 2. Fallback only within a real tenant: never for the global default customerId.
  if (!registrationIndex || customerId === '__default__') {
    return missOrCorrupt();
  }

  // 3. Same-customer registrations only (tenant boundary: see JSDoc).
  const sameTenantRegistrations = registrationIndex.getByOrgAndRepo(customerId, repoIdentifier);
  if (sameTenantRegistrations.length === 0) {
    logger.info('Multi-provider fallback: no same-customer registrations for repo', {
      deliveryId,
      inboundRoutingKey,
      customerId,
      repoIdentifier,
      attemptedFallbacks: 0,
      reason: 'no same-customer registrations',
    });
    return missOrCorrupt();
  }

  // Dedupe by routingKey, excluding the inbound routing key (no self-recursion).
  const seen = new Set<string>([inboundRoutingKey]);
  const fallbackRoutingKeys: string[] = [];
  for (const reg of sameTenantRegistrations) {
    if (seen.has(reg.routingKey)) continue;
    seen.add(reg.routingKey);
    fallbackRoutingKeys.push(reg.routingKey);
  }

  if (fallbackRoutingKeys.length === 0) {
    logger.info(
      'Multi-provider fallback: all same-customer registrations share the inbound routingKey',
      {
        deliveryId,
        inboundRoutingKey,
        customerId,
        repoIdentifier,
        attemptedFallbacks: 0,
      },
    );
    return missOrCorrupt();
  }

  // 4. Try each distinct fallback routing key's bundle.
  for (const fallbackRoutingKey of fallbackRoutingKeys) {
    const fallbackBundle = providerRegistry.getByRoutingKey(fallbackRoutingKey);
    if (!fallbackBundle?.lockFileFetcher) continue;

    // The registration's own credentials, never the inbound ones (see JSDoc).
    const registration = sameTenantRegistrations.find((r) => r.routingKey === fallbackRoutingKey);
    if (!registration) continue;
    const fallbackCredentials = registration.providerContext;

    let lockFile: FullLockFile | null;
    try {
      lockFile = (await lockFileCache.get(
        fallbackBundle.lockFileFetcher,
        repoIdentifier,
        ref,
        fallbackCredentials,
      )) as FullLockFile | null;
    } catch (err) {
      if (err instanceof LockFileParseError) {
        parseError = err;
      }
      logger.warn('Multi-provider fallback: fetcher threw, continuing', {
        deliveryId,
        inboundRoutingKey,
        fallbackRoutingKey,
        repoIdentifier,
        error: toErrorMessage(err),
      });
      continue;
    }

    if (lockFile) {
      logger.info('Lock file resolved via fallback provider bundle', {
        deliveryId,
        inboundRoutingKey,
        fallbackRoutingKey,
        repoIdentifier,
        ref,
        attemptedFallbacks: fallbackRoutingKeys.indexOf(fallbackRoutingKey) + 1,
      });
      return {
        lockFile,
        resolvedVia: 'fallback',
        fallbackRoutingKey,
        fallbackBundle,
        fallbackCredentials: fallbackCredentials as Record<string, unknown>,
      };
    }
  }

  logger.info('Multi-provider fallback exhausted without resolving lock file', {
    deliveryId,
    inboundRoutingKey,
    customerId,
    repoIdentifier,
    attemptedFallbacks: fallbackRoutingKeys.length,
  });
  return missOrCorrupt();
}

/**
 * Resolve the customer/org ID for a routing key from `sources` (GitHub App), then
 * `generic_webhook_sources`, then `remote_sources` (the auto-provisioned anchor for
 * Platform-relayed `kici run remote`, routing key `remote:<orgId>`); '__default__'
 * when none has it.
 */
export async function resolveOrgId(db: Kysely<Database>, routingKey: string): Promise<string> {
  const source = await db
    .selectFrom('sources')
    .select('customer_id')
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (source?.customer_id) {
    return source.customer_id;
  }

  const genericSource = await db
    .selectFrom('generic_webhook_sources')
    .select('customer_id')
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (genericSource?.customer_id) {
    return genericSource.customer_id;
  }

  const remoteSource = await db
    .selectFrom('remote_sources')
    .select('customer_id')
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (remoteSource?.customer_id) {
    return remoteSource.customer_id;
  }

  logger.warn('No customer_id found for routing key, falling back to __default__', { routingKey });
  return '__default__';
}

/** Map a GitHub event type to its lock file trigger type, for RegistrationIndex.getGlobalByTriggerType(). */
export function eventTypeToTriggerType(eventType: string): string {
  const map: Record<string, string> = {
    push: 'push',
    pull_request: 'pr',
    pull_request_review: 'review',
    pull_request_review_comment: 'review_comment',
    issue_comment: 'comment',
    release: 'release',
    repository_dispatch: 'dispatch',
    create: 'create',
    delete: 'delete',
    status: 'status',
    workflow_run: 'workflow_run',
    fork: 'fork',
    star: 'star',
    watch: 'watch',
  };
  return map[eventType] ?? eventType;
}

/** Trigger event string: event plus action, e.g. "push", "pull_request:opened". */
export function buildTriggerEvent(event: string, action: string | null | undefined): string {
  if (action) return `${event}:${action}`;
  return event;
}

/**
 * Best-effort repo identifier from a generic webhook payload, for cross-source
 * dispatch. Generic webhooks have no canonical repo shape, so this probes:
 *
 *   1. GitHub-style `repository.full_name` (`owner/repo`)
 *   2. GitHub-style `repository.owner.login` + `repository.name`
 *   3. Flat `repository` string (e.g. `{"repository": "owner/repo"}`)
 *
 * Null skips the cross-source repo lookup; event-name fan-out still runs.
 */
export function extractInboundRepoIdentifier(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const repository = p.repository;

  if (typeof repository === 'string' && repository.includes('/')) {
    return repository;
  }

  if (repository && typeof repository === 'object') {
    const r = repository as {
      full_name?: unknown;
      owner?: { login?: unknown } | null;
      name?: unknown;
    };
    if (typeof r.full_name === 'string' && r.full_name.includes('/')) {
      return r.full_name;
    }
    const login = r.owner?.login;
    if (typeof login === 'string' && typeof r.name === 'string') {
      return `${login}/${r.name}`;
    }
  }

  return null;
}

/**
 * First line of the commit message for run display: push (head_commit.message),
 * PR (pull_request.title), issue_comment (issue.title).
 *
 * The Tier-0 `commitMessage` trigger filter deliberately reads a DIFFERENT text
 * (the full message, and PR title + body) — see `githubFilterText`.
 */
export function extractCommitMessage(event: string, payload: unknown): string | undefined {
  return githubDisplayMessage(event, payload);
}

/**
 * Summary for a security hold check.
 *
 * `tier` is undefined when trust never resolved (displayed as `unknown`). The
 * caller never forges `unknown`, so this and `buildReducedPrivilegeNote`
 * (`../security/reduced-privilege-note.ts`) cannot disagree about a run's case.
 *
 * The reduced-privilege note is the call site's job: a trust-policy HOLD stores a
 * resume context that `/kici approve` replays, so `holdRunForSecurityPolicy`
 * appends it; a trust-policy REJECTION never runs, so its call site appends nothing.
 */
export function buildSecurityHoldSummary(
  reason: string,
  tier: string | undefined,
  contributorUsername?: string,
): string {
  const parts: string[] = [];

  if (reason === SecurityHoldReason.enum.workflow_modification) {
    parts.push(
      'This PR modifies workflow files (.kici/) and was submitted by a non-trusted contributor.',
    );
    parts.push('Workflow changes require approval from a user with ci_trust:write or higher.');
  } else if (reason === SecurityHoldReason.enum.unknown_contributor) {
    parts.push('Unknown contributor. Requires approval from a user with ci_trust:write or higher.');
  } else if (reason === SecurityHoldReason.enum.fork_pr) {
    parts.push(
      'Fork PR requires approval. Requires approval from a user with ci_trust:write or higher.',
    );
  } else if (reason === SecurityHoldReason.enum.context_trust) {
    parts.push('Context requires a higher trust level than the contributor has.');
    parts.push('Requires approval from a user with ci_trust:write or higher.');
  } else {
    parts.push(`Held for security review: ${reason}`);
  }

  if (contributorUsername) {
    parts.push(`\n**Contributor:** ${contributorUsername} (tier: ${tier ?? 'unknown'})`);
  }

  return parts.join('\n');
}

/**
 * Failure check-run description for a run the org trust policy REJECTED.
 *
 * Not `buildSecurityHoldSummary`: a rejected run has no `held_runs` row, so
 * "approval from a user with ci_trust:write" points at a queue it never joins;
 * only an org policy change unblocks it. No reduced-privilege note either: beside
 * "cannot be approved" it would read as the cause of failure for a run that never
 * dispatched.
 */
export function buildSecurityRejectionSummary(
  reason: string,
  message: string,
  tier: string | undefined,
  contributorUsername?: string,
): string {
  const parts: string[] = [
    `**Rejected by the org trust policy** (${reason}).`,
    message,
    'This run was not held for approval and cannot be approved. An org owner must ' +
      'change the trust policy under Settings > CI trust, after which a new push ' +
      'or a re-opened pull request will be evaluated again.',
  ];
  if (contributorUsername) {
    parts.push(`\n**Contributor:** ${contributorUsername} (tier: ${tier ?? 'unknown'})`);
  }
  return parts.join('\n');
}

/**
 * Pending check-run description for a job/workflow approval hold, naming the
 * clauses ("team X", "user Y"). An empty list (any eligible reviewer) gets a
 * generic message.
 */
export function summarizeApprovalClauses(
  clauses: ReadonlyArray<{ team: string } | { user: string }>,
): string {
  if (clauses.length === 0) {
    return 'Awaiting approval from an eligible reviewer';
  }
  const named = clauses.map((clause) =>
    'team' in clause ? `team ${clause.team}` : `user ${clause.user}`,
  );
  return `Awaiting approval: ${named.join(', ')}`;
}

/**
 * Appended to an approval hold's check description when a security trust hold
 * gates the SAME job. Both holds must clear and the check carries one description;
 * without this line the named approver approves, nothing runs, and nothing says
 * what is outstanding or that a different permission clears it.
 */
export const SECURITY_HOLD_ALSO_GATES_NOTE =
  'A security trust hold also gates this job, and both must be released before it runs. ' +
  'That one is cleared by a `ci_trust:write` approver, or by commenting `/kici approve` on this pull request.';

/**
 * Dependencies for the processing pipeline, all injected for testability.
 * Optional caches keep tests and cache-less deployments working.
 */
export interface ProcessingDeps {
  dedup: DedupCache;
  providerRegistry: ProviderRegistry;
  /**
   * Re-register the provider bundle for a generic routing key from server
   * truth; true when a bundle is now present.
   *
   * The registry is an in-memory CACHE of `generic_webhook_sources`, filled by
   * startup enumeration, the admin write handler and the LISTEN/NOTIFY drain;
   * none guarantees the entry exists when a delivery arrives. A miss is not
   * benign: an unrelated `generic:` bundle would report "no repository" and the
   * delivery would be discarded with nothing above `debug`.
   *
   * Optional: without it a miss stays a miss, reported loudly.
   */
  ensureProviderBundle?: (routingKey: string) => Promise<boolean>;
  lockFileCache: LockFileCache;
  /**
   * Cache for the Tier-1 `requires` static content filter (file bytes keyed by
   * (repo, sha, path)). When absent, a candidate carrying `requires` is dropped
   * fail-visible rather than dispatched unfiltered (see content-filter.ts).
   */
  contentRequirementsCache?: ContentRequirementsCache;
  dispatcher: Dispatcher;
  /** Null/undefined in Independent mode. send() buffers when disconnected. */
  platformClient?: PlatformClient;
  /** If set, raw payloads go to {dir}/{repo}/{deliveryId}/payload.json. */
  webhookPayloadDir?: string;
  /** Compiled workflow bundle cache; absent bypasses the cache. */
  sourceCache?: SourceCache;
  /** Deduplicates concurrent builds; absent bypasses the cache. */
  buildCoordinator?: BuildCoordinator;
  /** Dependency tarball cache; absent bypasses dep caching. */
  depCache?: DepCache;
  /** Waits for build agents before dispatching execution jobs. */
  pendingBuilds?: PendingBuildTracker;
  /** Waits for init agents to resolve dynamic fields before static dispatch. */
  pendingInits?: PendingInitTracker;
  /** Waits for agents to evaluate DynamicJobFn into generated LockJob[]. */
  pendingDynamics?: PendingDynamicTracker;
  /** Waits for the pre-run round that decides which global workflows apply. */
  pendingGlobalEvals?: PendingGlobalEvalTracker;
  /** Pre-run global eval round result cache; absent re-runs every round. */
  globalEvalCache?: GlobalEvalRoundCache;
  /** Cluster default whole-round eval-agent budget (ms); live override
   *  `cluster_settings.global_eval_round_timeout_ms`. */
  globalEvalRoundTimeoutMs?: number;
  /** Cluster default per-candidate eval-agent budget (ms); live override
   *  `cluster_settings.global_eval_candidate_timeout_ms`. */
  globalEvalCandidateTimeoutMs?: number;
  /** Cluster default orchestrator-side ceiling on awaiting a round (ms). Enforced
   *  here, not by the agent, so it also bounds a round no agent picked up. Live
   *  override `cluster_settings.global_eval_wait_timeout_ms`. */
  globalEvalWaitTimeoutMs?: number;
  /** Sets pending/success/failure/error commit statuses. */
  checkRunReporter?: CheckRunReporter;
  /** DB persistence of executions; absent skips tracking. */
  executionTracker?: ExecutionTracker;
  /** Picks the execution target platform/arch; absent defaults to linux/x64. */
  agentRegistry?: AgentRegistry;
  /** Multi-orchestrator job routing; absent dispatches every job locally. */
  coordinator?: RunCoordinator;
  /** Dispatch-time secret resolution; absent leaves secrets unresolved. */
  secretResolver?: SecretResolverApi;
  /**
   * Cached per-org container-sandbox escape-hatch allow-list. When absent, dispatch
   * uses the deny-all allow-list, so no workflow can escalate capabilities / host
   * networking.
   */
  sandboxAllowListReader?: SandboxAllowListReader;
  onSourceLocationsExtracted?: (
    workflowName: string,
    jobName: string,
    sourceLocations: Array<{ file: string; line: number; column: number } | undefined>,
  ) => void;
  /** Lock file event subscriptions; absent leaves event routing inactive. */
  eventRouter?: EventRouter;
  /**
   * Summon callback + chain-depth bound, built at the composition root. When
   * absent an invoke gate fails loudly rather than silently reaching an agent.
   */
  invokeGateDeps?: InvokeGateDeps;
  /** Absent skips registration. */
  registrationStore?: RegistrationStore;
  /** In-memory registration lookup; absent skips registration. */
  registrationIndex?: RegistrationIndex;
  /** Refreshes the cron cache after registration changes; absent skips it. */
  cronScheduler?: CronScheduler;
  /** Ephemeral key storage; absent disables cross-job secret outputs. */
  db?: Kysely<Database>;
  /** KICI_SECRET_KEY, encrypts ephemeral private keys. Required when db is set. */
  secretKey?: string;
  /** Persists webhook payloads; absent skips payload storage. */
  logStorage?: LogStorage;
  /**
   * Durable step-log writer. The deferred-init path writes a post-init env
   * warning to the run's log stream, so a blocking `kici run remote` prints it
   * (the accept response has already returned when the init round resolves).
   */
  logWriter?: Pick<LogWriter, 'appendChunk' | 'drain'>;
  /** Deployment contexts; absent disables context features. */
  contextStore?: ContextStore;
  /** Context variables; absent merges none. */
  variableStore?: VariableStore;
  /** Persists protection rule holds; absent persists none. */
  heldRunStore?: HeldRunStore;
  /** Cache of the Platform-owned org trust policy, read per PR event by the trust-policy gate. */
  trustPolicyStore?: TrustPolicyStore;
  /**
   * Decides what an absent trust policy means: Platform-attached modes fail closed
   * (a push is imminent); independent mode has no upstream authority and keeps
   * legacy behavior. The read site defaults to `'platform'` (fail-closed), so a
   * hand-built deps object never opens the gate.
   */
  orchestratorMode?: OrchestratorMode;
  /** Platform-pushed identity links for the comment-approval path; defaults to empty. */
  identityLinks?: IdentityLink[];
  /** Platform-pushed ci_trust levels per user ID; defaults to empty. */
  orgMemberPermissions?: Map<string, PermissionLevel>;
  /**
   * Persisted approval directory, read at `/kici approve` time when neither
   * `identityLinks` nor `orgMemberPermissions` was supplied.
   *
   * `server.ts` (the Platform-push path) always supplies both, so it never reads
   * this. The direct-ingress pipeline in `app.ts` — the ONLY one an independent
   * orchestrator has — supplies neither; without this store it would resolve an
   * empty directory and refuse every commenter forever. Absent skips the read.
   */
  trustDirectoryStore?: TrustDirectoryStore;
  /** Org-level global workflow permissions; absent leaves global workflows unrestricted. */
  globalWorkflowPolicy?: GlobalWorkflowPolicy;
  /** Delivery log; absent persists nothing to event_log. */
  eventLog?: EventLogRecorder;
  /** event_log source column: 'relay' (Platform WS) or 'direct' (HTTP, the default). */
  eventLogSource?: EventLogSource;
  /** Audit stream; absent skips hold-creation rows (`held_run.request`). */
  accessLogWriter?: AccessLogWriter;
  /** runsOnAll fan-out resolution; absent makes runsOnAll jobs fail at materialize. */
  hostRosterStore?: HostRosterStore;
  /** For the cross-cluster host-fanout pin reroute. */
  instanceId?: string;
  /** Grace before a disconnected static host reads unreachable (ms). */
  rosterGraceMs?: number;
  /** Cap on runsOnAll per-host children (default 1024). Cluster default; live
   * override `cluster_settings.max_fanout_hosts`. */
  maxFanoutHosts?: number;
  /** Fleet-wide cluster tunables (max_fanout_hosts live override). */
  clusterSettings?: ClusterSettingsReader;
}

/**
 * Does any trigger use path filters? When none does, the changedFilesFetcher call
 * is skipped, saving one provider API call per webhook.
 */
export function anyTriggerHasPathPatterns(workflows: LockWorkflow[]): boolean {
  for (const wf of workflows) {
    for (const trigger of wf.triggers) {
      if (triggerHasPathFilters(trigger)) {
        return true;
      }
    }
  }
  return false;
}

/** Only pr and push triggers support paths (including !-prefixed exclusions). */
function triggerHasPathFilters(trigger: LockTrigger): boolean {
  if (trigger._type === 'pr' || trigger._type === 'push') {
    return trigger.paths !== undefined && trigger.paths.length > 0;
  }
  return false;
}

// `./processor.js` stays the canonical module path for callers (server.ts, app.ts) and tests.
export { processWebhook } from './process-webhook.js';

/** How many times {@link hasPendingHold} reads before it gives up and refuses. */
export const PENDING_HOLD_READ_ATTEMPTS = 3;
/** Backoff between {@link hasPendingHold} attempts, multiplied by the attempt number. */
export const PENDING_HOLD_RETRY_BASE_MS = 25;

/**
 * Is there a still-pending hold for this (run, job)?
 *
 * `held_runs.job_id` carries the expanded job NAME for job-scoped holds, the
 * pending dispatch context's key. A missing row or non-pending status means
 * nothing gates the job.
 *
 * **Fails CLOSED** on a genuine read failure: the job is treated as held. This is
 * the enforcement point for a job carrying two holds (reviewer and security rows,
 * written together, BOTH must leave `pending`); answering `false` on error would
 * dispatch with neither released, bypassing approval unrecoverably.
 *
 * A refusal only delays: the context is not consumed (the check precedes the
 * consume), every release path re-drives `dispatchReadyJob`, and the
 * needs-scheduler recovery loop on the next start re-fires ready jobs of every
 * non-terminal run.
 *
 * Transient errors (deadlock, statement timeout, lost connection) must not park a
 * job until restart, so the read is tried {@link PENDING_HOLD_READ_ATTEMPTS} times
 * with a short linear backoff first.
 */
export async function hasPendingHold(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  opts: { attempts?: number; retryBaseMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? PENDING_HOLD_READ_ATTEMPTS;
  const retryBaseMs = opts.retryBaseMs ?? PENDING_HOLD_RETRY_BASE_MS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const row = await db
        .selectFrom('held_runs')
        .select('status')
        .where('run_id', '=', runId)
        .where('job_id', '=', jobName)
        .where('status', '=', HeldRunStatus.Pending)
        .executeTakeFirst();
      return !!row;
    } catch (err) {
      const lastAttempt = attempt === attempts;
      logger.error('Failed to check for a pending hold before dispatching a ready job', {
        runId,
        jobName,
        attempt,
        attempts,
        // Tells the operator whether the job was parked or the read retries.
        outcome: lastAttempt ? 'refusing dispatch (fail closed)' : 'retrying',
        error: toErrorMessage(err),
      });
      if (lastAttempt) return true;
      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * attempt));
    }
  }
  // Unreachable; keeps fail-closed the only exit.
  return true;
}

/** Read attempts for the needs verdict, mirroring {@link PENDING_HOLD_READ_ATTEMPTS}. */
export const NEEDS_READ_ATTEMPTS = 3;
/** Linear backoff base between needs-verdict read attempts. */
export const NEEDS_RETRY_BASE_MS = 25;

/**
 * Are a job's `needs` upstreams satisfied? For the dispatch guard.
 *
 * Fails CLOSED like {@link hasPendingHold}: `{ satisfied: false }` reads as
 * "upstream still pending", the recoverable branch (the start-up recovery loop
 * re-fires ready jobs; the stale-run expiry sweep is the backstop).
 *
 * Reads only. It never writes `needs_satisfied` — the scheduler owns that claim.
 */
export async function readNeedsVerdict(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  opts: { attempts?: number; retryBaseMs?: number } = {},
): Promise<{ satisfied: boolean; action?: 'dispatch' | 'skip'; reason?: string }> {
  const attempts = opts.attempts ?? NEEDS_READ_ATTEMPTS;
  const retryBaseMs = opts.retryBaseMs ?? NEEDS_RETRY_BASE_MS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await checkAllUpstreamsSatisfied(db, runId, jobName);
    } catch (err) {
      const lastAttempt = attempt === attempts;
      logger.error('Failed to read the needs verdict before dispatching a ready job', {
        runId,
        jobName,
        attempt,
        attempts,
        outcome: lastAttempt ? 'refusing dispatch (fail closed)' : 'retrying',
        error: toErrorMessage(err),
      });
      if (lastAttempt) return { satisfied: false };
      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * attempt));
    }
  }
  // Unreachable; keeps fail-closed the only exit.
  return { satisfied: false };
}

/**
 * Resolve the `execution_jobs.job_id` a ready job is currently tracked under.
 *
 * `onJobStatus` keys on the job ID (in-memory job map, scheduler hook,
 * run-completion check, `(run_id, job_id)` upsert target). A name matches nothing:
 * the upsert INSERTs a second row while the placeholder stays `pending` and the
 * scheduler hook never runs.
 *
 * A gated job sits on a `NEEDS_PENDING_JOB_ID_PREFIX` placeholder — the one
 * synthetic shape, shared by the needs gate, approval hold and rolling-wave hold —
 * which {@link ExecutionTracker.findSyntheticJobId} resolves from memory and DB.
 * `undefined` means the job is NOT gated (already dispatched, or untracked), so
 * not this gate's to terminalize.
 *
 * No by-name `execution_jobs` fallback: it would resolve already-dispatched rows
 * and mark a running or completed job `skipped` (the upsert has no terminal-status
 * guard, so `success` is overwritten). `undefined` leaves the context for a later
 * recompute.
 */
async function resolveTrackedJobId(
  executionTracker: ExecutionTracker,
  runId: string,
  jobName: string,
): Promise<string | undefined> {
  return executionTracker.findSyntheticJobId(runId, jobName);
}

/**
 * Pre-dispatch `needs` gate for {@link dispatchReadyJob}.
 *
 * A needs-gated job must not dispatch merely because a hold was released: every
 * release path (approval, the stale detector's concurrency sweep, wait holds,
 * admin release) funnels through `dispatchReadyJob`, and would otherwise run the
 * job beside a pending or failed upstream.
 *
 * Outcomes:
 * - upstreams satisfied -> `'proceed'` (a job with no needs edges always is);
 * - upstream not terminal -> `'stop'` without consuming, so the scheduler's next
 *   `onJobReady` still has the context;
 * - upstream terminal but not admitted by the edge's `run_on`, and
 *   {@link resolveTrackedJobId} finds the placeholder -> consume and terminalize
 *   it as `skipped`;
 * - same, but no tracker or placeholder -> `'stop'` without consuming, so a later
 *   recompute can resume the job instead of it waiting for the context expiry sweep.
 *
 * Reads only. The scheduler owns the `needs_satisfied` claim; see the warning on
 * `recomputeNeedsSatisfied` about handing claims back. Runs BEFORE the consume,
 * like {@link hasPendingHold}, so a refusal never strands the job.
 */
async function applyNeedsGate(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  executionTracker: ExecutionTracker | undefined,
): Promise<'proceed' | 'stop'> {
  const verdict = await readNeedsVerdict(db, runId, jobName);
  if (!verdict.satisfied) {
    // The scheduler re-fires `onJobReady` on upstream completion; the context stays.
    logger.info('Ready job has unsatisfied needs — leaving it for the scheduler', {
      runId,
      jobName,
    });
    return 'stop';
  }
  if (verdict.action === 'skip') {
    // The scheduler never fires ready again, so terminalize instead of stranding
    // the job: `onJobStatus` -> `runSchedulerHook` -> `evaluateDownstreams`
    // propagates the skip downstream.
    logger.info('Ready job upstream is terminal and unmet — skipping', {
      runId,
      jobName,
      reason: verdict.reason,
    });
    // Resolve BEFORE consuming: with no row to terminalize, consuming would delete
    // the only resume path.
    const jobId = executionTracker
      ? await resolveTrackedJobId(executionTracker, runId, jobName)
      : undefined;
    if (!executionTracker || !jobId) {
      logger.warn('Ready job to skip has no tracked execution_jobs row — leaving it queued', {
        runId,
        jobName,
        hasTracker: !!executionTracker,
      });
      return 'stop';
    }
    await consumePendingJobContext(db, runId, jobName);
    // The tracker persists `error` (not `reason`) to `error_message`, for the dashboard.
    await executionTracker.onJobStatus(
      runId,
      jobId,
      ExecutionJobStatus.enum.skipped,
      Date.now(),
      undefined,
      { error: verdict.reason },
    );
    return 'stop';
  }
  return 'proceed';
}

/**
 * The raw (snake_case) `contexts` row subset the ready-dispatch re-gate reads.
 *
 * `concurrency_strategy` and `hold_expiry_seconds` are optional because some
 * release-path callers narrow their closure to `concurrency_limit`; absent values
 * resolve to {@link DEFAULT_CONCURRENCY_STRATEGY} and
 * {@link DEFAULT_HOLD_EXPIRY_SECONDS}, the columns' own defaults.
 */
export interface ReadyDispatchContextRow {
  id: string;
  concurrency_limit: number | null;
  concurrency_strategy?: string | null;
  hold_expiry_seconds?: number | null;
}

/** Inputs the ready-dispatch concurrency re-gate needs. Absent = no re-gate. */
export interface ReadyDispatchGateDeps {
  matchContext: (orgId: string, name: string) => Promise<ReadyDispatchContextRow | null>;
  heldRunStore: Pick<HeldRunStore, 'create'>;
  /**
   * Audits each re-hold with the `held_run.request` row the dispatch pass writes.
   * Without a writer the gate still gates.
   */
  accessLogWriter?: Pick<AccessLogWriter, 'record'>;
  /** Audit row attribution, when the call site knows it. */
  routingKey?: string | null;
  /**
   * Stores for a released job's context variables and secrets. Called at release
   * time, so stores built after wiring can still be supplied.
   */
  contextData?: () => ContextDataDeps;
}

/** What {@link resolveRunConcurrency} needs to evaluate the concurrency gate. */
export interface RunConcurrency {
  orgId: string;
  group: string;
  contextId: string;
  limit: number | null;
  strategy: EngineContext['concurrencyStrategy'];
  /**
   * The context's hold window, seconds, so this gate's queued holds expire on the
   * dispatch pass's schedule and the configured queue timeout applies to both.
   */
  holdExpirySeconds: number;
}

/**
 * Resolve a run's bound context to concurrency gate inputs. `null` (no bound
 * context, or it no longer exists) is the common case, costing one indexed
 * lookup by `run_id`.
 */
export async function resolveRunConcurrency(
  db: Kysely<Database>,
  matchContext: ReadyDispatchGateDeps['matchContext'],
  runId: string,
): Promise<RunConcurrency | null> {
  const run = await db
    .selectFrom('execution_runs')
    .select(['context', 'customer_id'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (!run?.context || !run.customer_id) return null;

  const cfg = await matchContext(run.customer_id, run.context);
  if (!cfg) return null;

  return {
    orgId: run.customer_id,
    group: run.context,
    contextId: cfg.id,
    limit: cfg.concurrency_limit,
    strategy: (cfg.concurrency_strategy ??
      DEFAULT_CONCURRENCY_STRATEGY) as EngineContext['concurrencyStrategy'],
    holdExpirySeconds: cfg.hold_expiry_seconds ?? DEFAULT_HOLD_EXPIRY_SECONDS,
  };
}

/**
 * Pre-dispatch concurrency re-gate for {@link dispatchReadyJob}.
 *
 * The context protection pipeline runs once, at dispatch-pass time, and only its
 * CONCURRENCY gate is time-varying (approval is {@link hasPendingHold}'s). Without
 * this, a job released after its `needs` or a hold would run over its group's limit.
 *
 * Only {@link evaluateConcurrencyGate} runs: the whole pipeline would re-litigate
 * branch/trust/reviewer decisions and could re-derive the approval hold
 * `hasPendingHold` respects.
 *
 * Re-holding a just-released job is CORRECT, not a ping-pong: another job can
 * retake the freed slot first, and the stale detector's sweep releases the queued
 * hold when a slot frees again.
 *
 * Runs BEFORE the consume, so a re-held job keeps its pending context.
 */
async function applyContextProtectionGate(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  gateDeps: ReadyDispatchGateDeps,
): Promise<'proceed' | 'stop'> {
  // An invoke gate never reaches an agent, so it holds no slot `countOccupyingJobs`
  // counts. Gating it would queue a cross-repo summon behind jobs it does not
  // compete with, and expire it if no slot freed in the hold window. Root invoke
  // gates get no gate deps for the same reason; this covers the needs-gated case.
  if (await pendingJobContextIsInvokeGate(db, runId, jobName)) return 'proceed';

  const conc = await resolveRunConcurrency(db, gateDeps.matchContext, runId);
  // A degenerate non-positive limit is unlimited, exactly as the gate reads it.
  if (!conc || conc.limit === null || conc.limit <= 0) return 'proceed';

  const running = await countOccupyingJobs(db, conc.orgId, conc.group);
  const verdict = evaluateConcurrencyGate(
    { concurrencyLimit: conc.limit, concurrencyStrategy: conc.strategy },
    running,
    conc.group,
  );
  if (verdict.action !== 'queue') return 'proceed';

  logger.info('Ready job is over its context concurrency limit — re-holding', {
    runId,
    jobName,
    concurrencyGroup: conc.group,
    running,
    limit: conc.limit,
  });
  const held = await gateDeps.heldRunStore.create(conc.orgId, {
    runId,
    jobId: jobName,
    contextId: conc.contextId,
    holdType: HoldType.enum.concurrency,
    queueType: 'context',
    reason: verdict.reason ?? `Concurrency limit reached (${running}/${conc.limit})`,
    expiresAt: new Date(Date.now() + conc.holdExpirySeconds * 1000),
  });
  // One audit row per hold, as the dispatch pass writes: a queued hold with no
  // trail is a gap. The actor is the dispatcher; no operator is on this path.
  runDetached(
    logger,
    'Access log write',
    () =>
      gateDeps.accessLogWriter?.record({
        orgId: conc.orgId,
        routingKey: gateDeps.routingKey ?? null,
        actor: { type: 'system', component: 'dispatcher' },
        action: 'held_run.request',
        target: { type: 'held_run', id: held.id },
        requestId: null,
        source: 'platform_proxy',
        outcome: 'allowed',
        meta: {
          runId,
          jobId: jobName,
          holdType: HoldType.enum.concurrency,
          concurrencyGroup: conc.group,
          running,
          limit: conc.limit,
        },
      }),
    { runId, heldRunId: held.id },
  );
  return 'stop';
}

/**
 * The dispatch input for a job leaving its pending context.
 *
 * A context-bound job was stored without its context data; resolve it now. A
 * failure fails the job and returns `undefined`: it never dispatches without its
 * context's secrets. No record (no bound context, or an older row whose input
 * still carries its data) dispatches the stored input unchanged.
 */
async function releasedJobInput(
  runId: string,
  jobName: string,
  pendingCtx: PendingJobContext,
  gateDeps: ReadyDispatchGateDeps | undefined,
  executionTracker: ExecutionTracker | undefined,
): Promise<QueuedJobInput | undefined> {
  // Unlike a queued row, a pending context never moves to another coordinator,
  // so an unopenable seal fails the job, naming the fix.
  // fails-when: a job whose sealed secrets cannot be decrypted is dispatched without them
  // breaks-if-wrong: a pending context whose seal opened dispatches as before
  if (pendingCtx.secretsUnavailable) {
    logger.error('Released job failed: its stored secrets cannot be decrypted', {
      runId,
      job: jobName,
      error: pendingCtx.secretsUnavailable,
    });
    await failReleasedJob(runId, jobName, executionTracker, pendingCtx.secretsUnavailable);
    return undefined;
  }
  // breaks-if-wrong: a pending context with no record must dispatch its stored input unchanged
  if (!pendingCtx.contextResolution) return pendingCtx.jobInput;
  try {
    return await resolveReleasedJobInput({
      jobInput: pendingCtx.jobInput,
      jobName,
      resolution: pendingCtx.contextResolution,
      deps: gateDeps?.contextData?.(),
    });
  } catch (err) {
    const error = logReleaseResolutionFailure(pendingCtx.jobInput, err);
    await failReleasedJob(runId, jobName, executionTracker, error);
    return undefined;
  }
}

/** Fail a job leaving its pending context, on its `needs-pending-` placeholder. */
async function failReleasedJob(
  runId: string,
  jobName: string,
  executionTracker: ExecutionTracker | undefined,
  error: string,
): Promise<void> {
  if (!executionTracker) return;
  // Tracked under its placeholder id — see {@link resolveTrackedJobId}.
  await executionTracker.onJobStatus(
    runId,
    (await executionTracker.findSyntheticJobId(runId, jobName)) ?? jobName,
    ExecutionJobStatus.enum.failed,
    Date.now(),
    undefined,
    { error },
  );
}

/**
 * Dispatch a job the needs scheduler made ready (the tracker's onJobReady
 * callback): consume its pending context, dispatch normally, and record the real
 * job ID.
 */
export async function dispatchReadyJob(
  runId: string,
  jobName: string,
  dispatcher: Dispatcher,
  executionTracker?: ExecutionTracker,
  coordinator?: RunCoordinator,
  db?: Kysely<Database>,
  invokeGateDeps?: InvokeGateDeps,
  gateDeps?: ReadyDispatchGateDeps,
): Promise<void> {
  // A job can be BOTH needs-gated and held for approval, sharing one synthetic id
  // and pending context. The scheduler claims on `needs_satisfied` alone, so
  // without this an upstream completing would dispatch a held job, bypassing
  // approval.
  //
  // Checked BEFORE the consume, so a refusal never strands the job. Release paths
  // flip the row out of `pending` first, so a legitimate resume passes.
  if (db && (await hasPendingHold(db, runId, jobName))) {
    logger.info('Ready job is held for approval — leaving it for the release path', {
      runId,
      jobName,
    });
    return;
  }

  if (db && (await applyNeedsGate(db, runId, jobName, executionTracker)) === 'stop') return;

  // Load-bearing order: needs first, so a job with a failed upstream is skipped,
  // not queued for a slot it would never use.
  if (db && gateDeps && (await applyContextProtectionGate(db, runId, jobName, gateDeps)) === 'stop')
    return;

  const pendingCtx = await consumePendingJobContext(db, runId, jobName);
  if (!pendingCtx) {
    logger.warn('No pending dispatch context for ready job (may have been dispatched already)', {
      runId,
      jobName,
    });
    return;
  }

  // An invoke gate summons the source repo's subscribers instead of dispatching
  // its stepless input; missing gate deps fail loudly rather than hang.
  if (pendingCtx.invoke) {
    if (!db || !executionTracker || !invokeGateDeps) {
      logger.error('Invoke gate ready but gate dependencies are unavailable; failing the gate', {
        runId,
        jobName,
        hasDb: !!db,
        hasTracker: !!executionTracker,
        hasInvokeGateDeps: !!invokeGateDeps,
      });
      if (executionTracker) {
        // Tracked under its placeholder id — see {@link resolveTrackedJobId}.
        await executionTracker.onJobStatus(
          runId,
          (await executionTracker.findSyntheticJobId(runId, jobName)) ?? jobName,
          ExecutionJobStatus.enum.failed,
          Date.now(),
          undefined,
          { error: 'invoke gate could not run: gate dependencies unavailable' },
        );
      }
      return;
    }
    await releaseInvokeGate(
      { db, executionTracker, invokeGateDeps },
      runId,
      jobName,
      pendingCtx.invoke,
    );
    return;
  }

  const jobInput = await releasedJobInput(runId, jobName, pendingCtx, gateDeps, executionTracker);
  if (!jobInput) return;

  try {
    const result = await dispatcher.dispatch(jobInput);
    if (result.status === 'rejected') {
      logger.error('Scheduler-dispatched job rejected by dispatcher', {
        runId,
        jobName,
        reason: (result as any).reason,
      });
      if (executionTracker) {
        // A rejected dispatch has no real id, so terminalize the placeholder — see
        // {@link resolveTrackedJobId}.
        await executionTracker.onJobStatus(
          runId,
          (await executionTracker.findSyntheticJobId(runId, jobName)) ?? jobName,
          ExecutionJobStatus.enum.failed,
          Date.now(),
          undefined,
          { error: `dispatch rejected: ${(result as any).reason}` },
        );
      }
    } else {
      // `queued-no-backend` is handled like `queued`: the job IS queued under
      // `result.jobId`, and the placeholder swap lets the queue expiry sweep
      // terminalize it (`unroutable`) instead of pinning the run.
      if (result.status === 'queued-no-backend') {
        logger.warn('Scheduler-dispatched job has no matching backend (tracked)', {
          runId,
          jobName,
        });
      }
      // Swap the placeholder for the real id, so isRunComplete does not block on it.
      if (executionTracker) {
        const syntheticId = await executionTracker.findSyntheticJobId(runId, jobName);
        // The swap INSERTs a fresh row, losing what the synthetic row carried unless
        // restated. The credential relay fails CLOSED on empty `git_credentials`, so
        // dropping it would refuse every declared credential on a needs-gated job.
        const declaredCredentials =
          db && syntheticId
            ? ((
                await db
                  .selectFrom('execution_jobs')
                  .select('git_credentials')
                  .where('run_id', '=', runId)
                  .where('job_id', '=', syntheticId)
                  .executeTakeFirst()
              )?.git_credentials ?? undefined)
            : undefined;
        await executionTracker.addJobsToRun(
          runId,
          [
            {
              jobId: result.jobId,
              jobName,
              runsOnLabels: pendingCtx.runsOnLabels,
              ...(declaredCredentials && { gitCredentials: declaredCredentials }),
            },
          ],
          undefined,
          syntheticId,
        );
        // A ready job's needs are satisfied by definition, but addJobsToRun INSERTs
        // needs_satisfied=false (DB default). Restore it so checkSchedulerInvariant
        // does not flag the real row as "stuck".
        if (db) {
          await db
            .updateTable('execution_jobs')
            .set({ needs_satisfied: true, ready_at: new Date() })
            .where('run_id', '=', runId)
            .where('job_id', '=', result.jobId)
            .execute();
        }
      }
      logger.info('Scheduler-dispatched job ready and dispatched', {
        runId,
        jobName,
        jobId: result.jobId,
      });
    }
  } catch (err) {
    logger.error('Failed to dispatch scheduler-ready job', {
      runId,
      jobName,
      error: toErrorMessage(err),
    });
  }
}

/**
 * The repository's default branch from a webhook payload:
 *   1. `normalizer.extractDefaultBranch?(payload)` — provider hook (universal-git
 *      reads the source's `payloadPaths.defaultBranch` JSONPath);
 *   2. `payload.repository.default_branch` — the GitHub shape most forges mirror;
 * else `null`. The registration write path persists it, so a scheduled run can
 * present it as its own branch.
 */
export function extractDefaultBranch(
  payload: Record<string, unknown>,
  normalizer: WebhookNormalizer,
): string | null {
  const viaHook = normalizer.extractDefaultBranch?.(payload) ?? null;
  const repository = payload.repository as { default_branch?: string } | undefined;
  return viaHook ?? repository?.default_branch ?? null;
}

/** A push to the default branch triggers registration extraction for event subscriptions. */
export function isDefaultBranchPush(
  info: WebhookInfo,
  event: SimulatedEvent,
  payload: Record<string, unknown>,
  normalizer: WebhookNormalizer,
): boolean {
  if (info.event !== 'push') return false;
  const defaultBranch = extractDefaultBranch(payload, normalizer);
  if (!defaultBranch) return false;
  return event.targetBranch === defaultBranch;
}

/**
 * Cap on the per-decision trace forwarded to the Platform. Fixed, not tunable: the
 * summary rides an `execution.event` into a stored row, and hundreds of triggers
 * must not grow either without limit.
 */
export const DECISION_TRACE_MAX_CHECKS = 50;

/**
 * Serializable workflow decision summary for the Platform. Carries the capped
 * checks, so the dashboard answers "why did this not fire" from the delivery
 * alone; `checksCount` is the untruncated total, `checksTruncated` marks a cut.
 */
export function summarizeDecision(decision: WorkflowDecision): Record<string, unknown> {
  return {
    workflowName: decision.workflowName,
    matched: decision.matched,
    matchedTrigger: decision.matchedTrigger,
    summary: decision.summary,
    checksCount: decision.checks.length,
    checks: decision.checks.slice(0, DECISION_TRACE_MAX_CHECKS),
    ...(decision.checks.length > DECISION_TRACE_MAX_CHECKS && { checksTruncated: true }),
  };
}

/**
 * Byte budget for the whole forwarded trace, across every workflow on the delivery.
 *
 * The check cap and per-field clamp bound one entry; this bounds the frame, since
 * one event is evaluated against every lock file workflow plus every org-wide
 * registration. A frame past the Platform's WebSocket payload ceiling closes the
 * connection, stalling every delivery for the org until reconnect, so the budget
 * sits well under the Platform's storage guard, which stays a backstop.
 */
export const DECISION_TRACE_MAX_BYTES = 131_072;

/**
 * Bound the serialized trace, replacing what did not fit with a marker: the answer
 * stays partially readable and says the rest was dropped.
 */
export function capDecisionSummaries(
  summaries: readonly Record<string, unknown>[],
  maxBytes: number = DECISION_TRACE_MAX_BYTES,
): Record<string, unknown>[] {
  return truncateDecisionsToByteBudget(summaries, maxBytes).decisions;
}
