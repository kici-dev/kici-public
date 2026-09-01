/**
 * Core webhook processing pipeline.
 *
 * Connects all orchestrator modules into a complete processing flow:
 * dedup -> normalize event -> fetch lock file -> get changed files ->
 * match triggers -> cache check -> dispatch jobs
 *
 * Uses the ProviderRegistry for all provider-specific operations.
 * No direct GitHub/Octokit references -- fully provider-agnostic.
 *
 * Decision traces are forwarded to Platform via platformClient.send() (which buffers
 * internally when disconnected -- the caller does NOT check connection state).
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
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
import { LockFileParseError } from '@kici-dev/engine';
import type { EventRouter } from '../events/event-router.js';
import type { InvokeGateDeps, InvokeGateParams } from './invoke-gate.js';
import { releaseInvokeGate } from './invoke-gate.js';
import { checkAllUpstreamsSatisfied } from './needs-scheduler.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { CronScheduler } from '../cron/cron-scheduler.js';
import type { GlobalWorkflowPolicy } from '../security/global-workflow-policy.js';
import type { EventLogWriter } from '../webhook/event-log.js';
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

const logger = createLogger({ prefix: 'pipeline' });

/**
 * Pending dispatch context for jobs gated by the needs scheduler.
 * Keyed by `${runId}:${jobName}`. Populated at processWebhook time for all
 * non-root static jobs. Consumed by the onJobReady callback when the scheduler
 * determines a job's upstreams are all satisfied.
 *
 * Entries are cleaned up after dispatch or when the run completes.
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
}

const pendingJobContexts = new Map<string, PendingJobContext>();

/**
 * Eval-gate registry for result-aware dynamic generators, keyed by
 * `${runId}:${evalJobName}`. A deferred `processDynamicEntry` background task
 * registers a gate and awaits it; the needs scheduler opens the gate (resolving
 * the promise) when the eval job's upstream `needs` reach a terminal state.
 *
 * This is the in-process signal that crosses from the scheduler's `onJobReady`
 * path back to the waiting dispatch task — the gating itself stays in the
 * DB-backed `execution_job_needs` scheduler. Like `pendingJobContexts`, it is a
 * module-level singleton because both producer and consumer run in the same
 * orchestrator process for the lifetime of the awaiting task.
 */
const pendingEvalGates = new Map<string, () => void>();

function evalGateKey(runId: string, evalJobName: string): string {
  return `${runId}:${evalJobName}`;
}

/**
 * Register an eval gate and return a promise that resolves when the scheduler
 * opens it (the eval job's upstream needs are all satisfied).
 */
export function trackEvalGate(runId: string, evalJobName: string): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingEvalGates.set(evalGateKey(runId, evalJobName), resolve);
  });
}

/**
 * Open a registered eval gate, unblocking the deferred dispatch task. Returns
 * true if a gate was registered for this eval job (so the scheduler knows it
 * handled the ready signal itself and must not run the normal dispatch path).
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
 * Store a pending dispatch context for a job that will be dispatched later
 * by the needs scheduler. The key is `${runId}:${jobName}`.
 * Writes to both in-memory Map and DB table for crash recovery.
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
    await db
      .insertInto('pending_job_contexts')
      .values({
        run_id: runId,
        job_name: jobName,
        job_input: JSON.stringify(ctx.jobInput),
        runs_on_labels: JSON.stringify(ctx.runsOnLabels),
        invoke_config: invokeConfig,
      })
      .onConflict((oc) =>
        oc.columns(['run_id', 'job_name']).doUpdateSet({
          job_input: JSON.stringify(ctx.jobInput),
          runs_on_labels: JSON.stringify(ctx.runsOnLabels),
          invoke_config: invokeConfig,
        }),
      )
      .execute();
  }
}

/**
 * Consume and remove a pending dispatch context for a job.
 * Returns undefined if no context is stored (e.g. job was already dispatched).
 * Deletes from both in-memory Map and DB table.
 *
 * Cluster correctness: `storePendingJobContext` writes to both the local
 * in-memory Map and the shared DB. In an HA cluster the peer that ingested
 * the webhook stores the context, but `onJobReady` fires on whichever peer
 * tracked the upstream job's completion — which, for a rerouted upstream,
 * is a different peer whose Map is empty. Falling through to an atomic
 * `DELETE ... RETURNING` ensures exactly one peer claims the context.
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
    .returning(['job_input', 'runs_on_labels', 'invoke_config'])
    .execute();

  if (claimed.length === 0) return undefined;

  const row = claimed[0];
  return {
    jobInput: row.job_input as unknown as QueuedJobInput,
    runsOnLabels: row.runs_on_labels as unknown as string[],
    ...(row.invoke_config != null && {
      invoke: JSON.parse(row.invoke_config) as InvokeGateParams,
    }),
  };
}

/**
 * Is the pending context for this (run, job) an invoke gate?
 *
 * Reads WITHOUT consuming, which is why it exists as its own function: the
 * ready-dispatch concurrency re-gate runs before `consumePendingJobContext`, and
 * consuming there would delete the resume path of a job it goes on to re-hold.
 *
 * `undefined` means "no pending context" — the caller already handles that a few
 * lines later, when the consume returns nothing.
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

/**
 * Clean up all pending dispatch contexts for a run (called on run completion).
 * Deletes from both in-memory Map and DB table.
 */
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
 * Restore all pending job contexts from DB into the in-memory Map.
 * Called on startup before the needs scheduler recovery loop so that
 * dispatchReadyJob has context available for recovered jobs.
 */
export async function restorePendingJobContexts(db: Kysely<Database>): Promise<number> {
  // Clean up stale rows for runs that already reached terminal state.
  // These can linger if the orchestrator crashed after run completion but before
  // the fire-and-forget cleanupPendingJobContexts DB delete finished.
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
      jobInput: row.job_input as unknown as QueuedJobInput,
      runsOnLabels: row.runs_on_labels as unknown as string[],
      ...(row.invoke_config != null && {
        invoke: JSON.parse(row.invoke_config) as InvokeGateParams,
      }),
    });
  }
  return rows.length;
}

/**
 * Clear all entries from the in-memory pending job contexts Map.
 * @internal Exported for testing only.
 */
export function clearPendingJobContextsMap(): void {
  pendingJobContexts.clear();
}

/**
 * Determine if a lock job is a "root" job (no concrete needs and no dependsOnGroups).
 * Root jobs can be dispatched immediately; non-root jobs wait for the scheduler.
 */
export function isRootJob(lockJob: LockJob): boolean {
  // Check for concrete needs (string or NeedsEntry with 'name'). A lock job
  // read from the registration store can arrive without a `needs` array (the
  // compiler always emits `needs: []`, but a directly-registered global entry
  // may omit it); a missing `needs` means no upstreams — a root job.
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
 * Why this exists
 * ----------------
 * The webhook pipeline binds `lockFileFetcher` to the inbound webhook's
 * provider bundle. When a local-sourced webhook (e.g., the staging
 * stg-ha-smoke failover-dispatch test) arrives for a repo whose lock file
 * is only accessible via a different provider (e.g., github), the inbound
 * fetcher returns null and trigger matching silently drops the webhook.
 * This resolver lets the pipeline consult OTHER bundles whose registrations
 * prove they own the repo for the same tenant.
 *
 * Tenant boundary (security-critical)
 * -----------------------------------
 * The fallback iterates ONLY registrations returned by
 * `registrationIndex.getByOrgAndRepo(customerId, repoIdentifier)`. That
 * index is keyed by `${customerId}|${repoIdentifier}`, so cross-customer
 * leakage is structurally impossible — a customer-B registration for
 * `owner/repo` will never be returned when we pass `customerId = 'custA'`.
 * The resolver also skips any registration whose `routingKey` matches the
 * inbound routing key (no self-recursion) and dedupes by routing key so a
 * repo with many workflows registered through the same source only
 * triggers one fallback fetch.
 *
 * Ordering
 * --------
 * Registrations are consulted in the order returned by the index (which
 * preserves insertion order = createdAt ascending). The first non-null
 * lock file wins. If all fallbacks return null the function returns null
 * and the caller falls through to the existing `Lock file not found`
 * global-workflow-matching path.
 *
 * Credentials
 * -----------
 * Each fallback fetcher is invoked with the REGISTRATION'S
 * `providerContext`, NOT the inbound normalizer's credentials. This is
 * load-bearing: the LocalWebhookNormalizer returns `{}` as
 * credentials, which would never satisfy a github fetcher that requires
 * `installationId`. The registration carries the correct credentials
 * because it was created via the owning provider's source.
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
}): Promise<{
  lockFile: FullLockFile | null;
  resolvedVia: 'inbound' | 'fallback' | 'miss' | 'corrupt';
  fallbackRoutingKey?: string;
  /** The winning provider bundle when resolvedVia='fallback'. Used by the dispatch
   *  site to swap repoUrlBuilder and cloneTokenProvider (Layer 4 cross-provider fix). */
  fallbackBundle?: ProviderBundle;
  /** The winning registration's providerContext when resolvedVia='fallback'.
   *  Carries installationId etc. for clone token issuance. */
  fallbackCredentials?: Record<string, unknown>;
  /** Set when resolvedVia='corrupt': the parse error seen while attempting to
   *  resolve a lock file. A valid fallback always wins over a corrupt inbound,
   *  so this is only surfaced when NOTHING resolved. */
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

  // A corrupt lock file (present-but-unparseable) is remembered here. If no
  // provider resolves a valid lock, a remembered parse error turns the final
  // 'miss' into a 'corrupt' outcome so the pipeline can record a
  // lock_resolution init-failure run. A valid lock from any provider still wins.
  let parseError: LockFileParseError | undefined;
  const missOrCorrupt = (): {
    lockFile: FullLockFile | null;
    resolvedVia: 'miss' | 'corrupt';
    corruptError?: LockFileParseError;
  } =>
    parseError
      ? { lockFile: null, resolvedVia: 'corrupt', corruptError: parseError }
      : { lockFile: null, resolvedVia: 'miss' };

  // 1. Try inbound bundle first (existing behavior).
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

  // 2. Gate on preconditions: no fallback if no registrationIndex or no
  //    tenant context, and skip fallback entirely when customerId is the
  //    global default (fallback only makes sense within a real tenant).
  if (!registrationIndex || customerId === '__default__') {
    return missOrCorrupt();
  }

  // 3. Iterate same-customer registrations for this repo. The index is
  //    keyed by `${customerId}|${repoIdentifier}` so cross-tenant leakage
  //    is structurally impossible.
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

    // Use the registration's own providerContext as credentials — the
    // inbound normalizer's credentials (e.g. {} for local) would not
    // satisfy a github fetcher which needs installationId.
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
 * Resolve the customer/org ID for a routing key.
 *
 * Checks the `sources` table first (GitHub App sources), then
 * `generic_webhook_sources` (generic webhook sources), then `remote_sources`
 * (the auto-provisioned anchor for Platform-relayed `kici run remote`, routing
 * key `remote:<orgId>`). Falls back to '__default__' if none of the three
 * tables has the routing key.
 */
export async function resolveOrgId(db: Kysely<Database>, routingKey: string): Promise<string> {
  // Check sources table (GitHub App sources)
  const source = await db
    .selectFrom('sources')
    .select('customer_id')
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (source?.customer_id) {
    return source.customer_id;
  }

  // Check generic_webhook_sources table
  const genericSource = await db
    .selectFrom('generic_webhook_sources')
    .select('customer_id')
    .where('routing_key', '=', routingKey)
    .executeTakeFirst();

  if (genericSource?.customer_id) {
    return genericSource.customer_id;
  }

  // Check remote_sources (Platform-relayed `kici run remote` anchor)
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

/**
 * Map GitHub webhook event types to lock file trigger type strings.
 * Used for global workflow matching via RegistrationIndex.getGlobalByTriggerType().
 */
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

/**
 * Extract a human-readable trigger event string from webhook info.
 * Combines event type with action (e.g. "push", "pull_request:opened").
 */
export function buildTriggerEvent(event: string, action: string | null | undefined): string {
  if (action) return `${event}:${action}`;
  return event;
}

/**
 * Best-effort extraction of a repository identifier from a generic webhook
 * payload for cross-source dispatch. Generic webhooks have no
 * canonical repo shape, so we probe the conventions a sender is most likely
 * to use:
 *
 *   1. GitHub-style `repository.full_name` (`owner/repo`)
 *   2. GitHub-style `repository.owner.login` + `repository.name`
 *   3. Flat `repository` string (e.g. `{"repository": "owner/repo"}`)
 *
 * Returns null when no recognisable repo field is present, in which case the
 * cross-source repo lookup is skipped (event-name fan-out still runs).
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
 * Extract the first line of the commit message from a webhook payload, for run
 * display. Handles push (head_commit.message), PR (pull_request.title) and
 * issue_comment (issue.title) events.
 *
 * The Tier-0 `commitMessage` trigger filter deliberately reads a DIFFERENT text
 * (the full message, and PR title + body) — see `githubFilterText`.
 */
export function extractCommitMessage(event: string, payload: unknown): string | undefined {
  return githubDisplayMessage(event, payload);
}

/**
 * Build a human-readable summary for a security hold check.
 *
 * `tier` is the resolved trust tier, or undefined when trust never resolved;
 * the summary displays `unknown` for the latter. The caller passes the resolved
 * value rather than forging `unknown` for an absent one, so this summary and
 * `buildReducedPrivilegeNote` (`../security/reduced-privilege-note.ts`) cannot
 * disagree about which case a run is in.
 *
 * Carries no reduced-privilege note of its own: the note is appended by the
 * call site, because the two summaries this builds are read on checks with
 * different fates. The trust-policy HOLD stores a resume context, so
 * `/kici approve` replays its dispatch and its call site
 * (`holdRunForSecurityPolicy`) appends the note; the trust-policy REJECTION
 * never runs, so `buildSecurityRejectionSummary`'s call site appends nothing.
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
 * Build the failure check-run description for a run the org trust policy
 * REJECTED.
 *
 * Deliberately not `buildSecurityHoldSummary`: a rejected run creates no
 * `held_runs` row, so telling the contributor to seek "approval from a user
 * with ci_trust:write or higher" points at a queue the run will never appear
 * in. Only an org policy change can unblock it.
 *
 * Carries no reduced-privilege note for the same reason: the summary's own next
 * line says the run cannot be approved, so a posture note beside it would read
 * as "it ran with reduced privileges and that is why it failed" for a run that
 * never dispatched at all.
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
 * Build the pending check-run description for a job/workflow approval hold,
 * naming the clauses an approver must satisfy. `{team:X}` renders as
 * "team X", `{user:Y}` as "user Y". An empty clause list (any eligible
 * reviewer satisfies the hold) falls back to a generic message.
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
 * The line appended to an approval hold's check description when a security
 * trust hold gates the SAME job.
 *
 * Both holds must be answered before the job runs, and the check run carries one
 * description. Without this line the check names only the approval clauses — so
 * the named approver approves, nothing runs, and the text does not change: a
 * contributor is left with a satisfied requirement, no statement of what is
 * still outstanding, and no idea that a different permission clears it. Naming
 * the second gate and how it is released is the minimum that makes the check
 * honest.
 */
export const SECURITY_HOLD_ALSO_GATES_NOTE =
  'A security trust hold also gates this job, and both must be released before it runs. ' +
  'That one is cleared by a `ci_trust:write` approver, or by commenting `/kici approve` on this pull request.';

/**
 * Dependencies for the processing pipeline.
 * All injected for testability. Fully provider-agnostic.
 *
 * sourceCache and buildCoordinator are optional for backward compatibility --
 * existing tests and deployments without cache configured still work.
 */
export interface ProcessingDeps {
  dedup: DedupCache;
  providerRegistry: ProviderRegistry;
  /**
   * Re-register the provider bundle for a generic routing key from server
   * truth, returning true when a bundle is now present.
   *
   * The registry is an in-memory CACHE of `generic_webhook_sources`, populated
   * by three independent paths (startup enumeration, the admin write handler,
   * and the LISTEN/NOTIFY drain). None of them can guarantee the entry is
   * present for a delivery that arrives at an arbitrary moment, and a miss is
   * not benign: `getByRoutingKey` used to substitute an unrelated `generic:`
   * bundle whose normalizer reports "this payload has no repository", so the
   * delivery was discarded with nothing above `debug` to say why.
   *
   * Optional — hand-built test deps and wirings with no generic-source manager
   * keep the previous behaviour (a miss stays a miss, reported loudly).
   */
  ensureProviderBundle?: (routingKey: string) => Promise<boolean>;
  lockFileCache: LockFileCache;
  /**
   * Cache for the Tier-1 `requires` static content filter (source-file bytes at
   * a ref, keyed by (repo, sha, path)). Optional so hand-built test deps and
   * independent deployments that never use `requires` keep working; when absent,
   * a candidate carrying `requires` is dropped fail-visible rather than
   * dispatched unfiltered (see content-filter.ts).
   */
  contentRequirementsCache?: ContentRequirementsCache;
  dispatcher: Dispatcher;
  /** Null/undefined in Independent mode. send() buffers when disconnected. */
  platformClient?: PlatformClient;
  /** Directory for writing raw webhook payloads. If set, writes {dir}/{repo}/{deliveryId}/payload.json. */
  webhookPayloadDir?: string;
  /** Bundle cache for compiled workflow bundles. Optional -- if not set, cache is bypassed. */
  sourceCache?: SourceCache;
  /** Build coordinator for deduplicating concurrent builds. Optional -- if not set, cache is bypassed. */
  buildCoordinator?: BuildCoordinator;
  /** Dep cache for dependency tarballs. Optional -- if not set, dep caching is bypassed. */
  depCache?: DepCache;
  /** Pending build tracker -- waits for build agents to finish before dispatching execution jobs. */
  pendingBuilds?: PendingBuildTracker;
  /** Pending init tracker -- waits for init agents to resolve dynamic fields before static dispatch. */
  pendingInits?: PendingInitTracker;
  /** Pending dynamic tracker -- waits for agents to evaluate DynamicJobFn and return generated LockJob[]. */
  pendingDynamics?: PendingDynamicTracker;
  /** Pending global-eval tracker -- waits for the pre-run round that decides which global workflows apply. */
  pendingGlobalEvals?: PendingGlobalEvalTracker;
  /** Round-result cache for the pre-run global eval round. Optional -- if not set, every round re-runs. */
  globalEvalCache?: GlobalEvalRoundCache;
  /** Cluster default for the whole-round budget handed to the eval agent (ms).
   *  The live per-cluster override is `cluster_settings.global_eval_round_timeout_ms`. */
  globalEvalRoundTimeoutMs?: number;
  /** Cluster default for the per-candidate budget handed to the eval agent (ms).
   *  The live per-cluster override is `cluster_settings.global_eval_candidate_timeout_ms`. */
  globalEvalCandidateTimeoutMs?: number;
  /** Cluster default for the orchestrator's own ceiling on awaiting a round (ms).
   *  Unlike the two budgets above, this one is enforced here rather than by the
   *  agent, so it also bounds a round no agent ever picked up. The live
   *  per-cluster override is `cluster_settings.global_eval_wait_timeout_ms`. */
  globalEvalWaitTimeoutMs?: number;
  /** Commit status reporter for setting pending/success/failure/error on commits. Optional. */
  checkRunReporter?: CheckRunReporter;
  /** Execution tracker for DB persistence. Optional -- if not set, execution tracking is skipped. */
  executionTracker?: ExecutionTracker;
  /** Agent registry for determining execution target platform/arch. Optional -- if not set, defaults to linux/x64. */
  agentRegistry?: AgentRegistry;
  /** Run coordinator for multi-orchestrator job routing. Optional -- if not set, all jobs dispatch locally (single-orchestrator mode). */
  coordinator?: RunCoordinator;
  /** Secret resolver for dispatch-time secret resolution. Optional -- if not set, secrets are not resolved. */
  secretResolver?: SecretResolverApi;
  /**
   * Cached per-org container-sandbox escape-hatch allow-list reader. Optional --
   * when absent, dispatch defaults to the safe deny-all allow-list, so no
   * workflow can escalate capabilities / host networking.
   */
  sandboxAllowListReader?: SandboxAllowListReader;
  /** Optional callback when source locations are extracted from a lock file workflow. */
  onSourceLocationsExtracted?: (
    workflowName: string,
    jobName: string,
    sourceLocations: Array<{ file: string; line: number; column: number } | undefined>,
  ) => void;
  /** Event router for registering lock file event subscriptions. Optional -- if not set, event routing is inactive. */
  eventRouter?: EventRouter;
  /**
   * Invoke-gate dependencies (summon callback + chain-depth bound). Optional --
   * when absent an invoke gate cannot summon (it fails loudly rather than
   * silently reaching an agent). Built at the composition root.
   */
  invokeGateDeps?: InvokeGateDeps;
  /** Registration store for persisting workflow registrations. Optional -- if not set, registration is skipped. */
  registrationStore?: RegistrationStore;
  /** Registration index for in-memory lookup. Optional -- if not set, registration is skipped. */
  registrationIndex?: RegistrationIndex;
  /** Cron scheduler for cache refresh after registration changes. Optional -- if not set, cron cache refresh is skipped. */
  cronScheduler?: CronScheduler;
  /** Database connection for ephemeral key storage. Optional -- if not set, cross-job secret output support is inactive. */
  db?: Kysely<Database>;
  /** Secret key (KICI_SECRET_KEY) for encrypting ephemeral private keys. Required when db is set. */
  secretKey?: string;
  /** Log storage backend for persisting webhook payloads. Optional -- if not set, payload storage is skipped. */
  logStorage?: LogStorage;
  /**
   * Durable step-log writer. Optional -- when present, the deferred-init path
   * uses it to surface a post-init env warning on the run's log stream so a
   * blocking `kici run remote` test run prints it (the accept response has
   * already been returned by the time the init round resolves).
   */
  logWriter?: Pick<LogWriter, 'appendChunk' | 'drain'>;
  /** Context store for looking up deployment contexts. Optional -- if not set, context features are inactive. */
  contextStore?: ContextStore;
  /** Variable store for resolving context variables. Optional -- if not set, context vars are not merged. */
  variableStore?: VariableStore;
  /** Held run store for persisting protection rule holds. Optional -- if not set, holds are not persisted. */
  heldRunStore?: HeldRunStore;
  /**
   * Cache of the Platform-owned org trust policy. Read per PR event by the
   * trust-policy gate. Optional so existing tests and independent deployments
   * that construct deps by hand keep working.
   */
  trustPolicyStore?: TrustPolicyStore;
  /**
   * This orchestrator's mode. The trust-policy gate needs it to decide what an
   * absent policy means: Platform-attached modes fail closed (a push is
   * imminent), independent mode has no upstream authority and keeps legacy
   * behavior. Defaults to `'platform'` at the read site — the fail-closed side —
   * so a hand-built deps object never accidentally opens the gate.
   */
  orchestratorMode?: OrchestratorMode;
  /** Identity links pushed from Platform, read by the comment-approval path. Optional -- defaults to empty. */
  identityLinks?: IdentityLink[];
  /** ci_trust permission levels per user ID from Platform push. Optional -- defaults to empty. */
  orgMemberPermissions?: Map<string, PermissionLevel>;
  /**
   * Persisted approval directory, read at `/kici approve` time when neither
   * `identityLinks` nor `orgMemberPermissions` was supplied.
   *
   * The two fields above are the Platform-push path: `server.ts` keeps them in
   * memory and refreshes them on every `trust_policy.update`, so it always
   * supplies both and this store is never consulted there. Every other
   * assembly of these deps — the direct-ingress pipeline in `app.ts`, which is
   * the ONLY one an independent orchestrator has — supplies neither, and
   * without this store its approval path would resolve an empty directory and
   * refuse every commenter forever.
   *
   * Optional so a hand-built deps object keeps working; the read is skipped
   * when it is absent.
   */
  trustDirectoryStore?: TrustDirectoryStore;
  /** Global workflow policy for org-level permission enforcement. Optional -- if not set, global workflows are unrestricted. */
  globalWorkflowPolicy?: GlobalWorkflowPolicy;
  /** Inbound webhook delivery log writer. Optional -- if not set, deliveries are not persisted to event_log. */
  eventLog?: EventLogWriter;
  /** Where this delivery arrived: 'relay' (Platform WS) or 'direct' (HTTP).
   *  Used by the eventLog writer to populate the source column. Defaults to
   *  'direct' when omitted (independent / direct paths). */
  eventLogSource?: EventLogSource;
  /** Access-log writer for the orchestrator audit stream. Optional -- if not
   *  set, hold-creation audit rows (`held_run.request`) are skipped. */
  accessLogWriter?: AccessLogWriter;
  /** Host roster store for runsOnAll fan-out resolution. Optional -- if not set,
   *  runsOnAll jobs cannot be resolved and fail at materialize. */
  hostRosterStore?: HostRosterStore;
  /** This orchestrator instance id (for the cross-cluster host-fanout pin reroute). */
  instanceId?: string;
  /** Static-host grace before a disconnected static host reads unreachable (ms). */
  rosterGraceMs?: number;
  /** Cap on runsOnAll per-host children (default 1024). Cluster default; the
   * live per-cluster override is read from `cluster_settings.max_fanout_hosts`. */
  maxFanoutHosts?: number;
  /** Reader for fleet-wide cluster tunables (max_fanout_hosts live override). */
  clusterSettings?: ClusterSettingsReader;
}

/**
 * Check if any trigger in the lock file workflows uses path filters.
 * Used to skip the changedFilesFetcher call when no path patterns are configured,
 * saving one provider API call per webhook.
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

/**
 * Check if a single trigger has path-based filters.
 * Only pr and push triggers support paths (including !-prefixed exclusions).
 */
function triggerHasPathFilters(trigger: LockTrigger): boolean {
  if (trigger._type === 'pr' || trigger._type === 'push') {
    return trigger.paths !== undefined && trigger.paths.length > 0;
  }
  return false;
}

// Re-export the webhook processing entry point. The implementation lives in
// `process-webhook.ts` (split out per the function-body-length refactor); this
// re-export keeps `./processor.js` as the canonical module path for callers
// (server.ts, app.ts) and tests.
export { processWebhook } from './process-webhook.js';

/** How many times {@link hasPendingHold} reads before it gives up and refuses. */
export const PENDING_HOLD_READ_ATTEMPTS = 3;
/** Backoff between {@link hasPendingHold} attempts, multiplied by the attempt number. */
export const PENDING_HOLD_RETRY_BASE_MS = 25;

/**
 * Is there a still-pending hold for this (run, job)?
 *
 * `held_runs.job_id` carries the expanded job NAME for job-scoped holds, which
 * is the same key the pending dispatch context uses. A missing row, or any
 * non-pending status, means nothing is gating the job.
 *
 * **Fails CLOSED** once the read has genuinely failed: a job whose hold state
 * cannot be read is treated as held and left for the release path. This gate is
 * the enforcement point for "every requirement answered" on a job carrying two
 * holds — the reviewer row and the security row are written together and BOTH
 * must leave `pending` before dispatch — so answering `false` on a read error
 * dispatched a job with neither hold released and the approval boundary
 * bypassed entirely. That is unrecoverable; the failure in the other direction
 * is not.
 *
 * A refusal leaves the job pending rather than losing it: the context is not
 * consumed (the check runs before the consume), every release path re-drives
 * `dispatchReadyJob`, and the needs-scheduler recovery loop on the next start
 * recomputes `needs_satisfied` for every non-terminal run and re-fires the
 * ready jobs. So the worst case of a closed failure is a delay, against a
 * silently bypassed approval for an open one.
 *
 * The retries are what keep that trade cheap. The realistic error here is a
 * transient one — a deadlock, a statement timeout, a lost connection — and a
 * single blip must not park a job until the next restart, so the read is
 * attempted {@link PENDING_HOLD_READ_ATTEMPTS} times with a short linear
 * backoff before the refusal stands.
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
        // Names the consequence, so an operator reading the line knows whether
        // the job was parked or the read is about to be retried.
        outcome: lastAttempt ? 'refusing dispatch (fail closed)' : 'retrying',
        error: toErrorMessage(err),
      });
      if (lastAttempt) return true;
      await new Promise((resolve) => setTimeout(resolve, retryBaseMs * attempt));
    }
  }
  // Unreachable: the loop either returns a row verdict or returns true on the
  // last attempt. Kept so the fail-closed direction is the function's only exit.
  return true;
}

/** Read attempts for the needs verdict, mirroring {@link PENDING_HOLD_READ_ATTEMPTS}. */
export const NEEDS_READ_ATTEMPTS = 3;
/** Linear backoff base between needs-verdict read attempts. */
export const NEEDS_RETRY_BASE_MS = 25;

/**
 * Read whether a job's `needs` upstreams are satisfied, for the dispatch guard.
 *
 * Fails CLOSED, exactly as {@link hasPendingHold} does and for the same reason:
 * an unreadable verdict must never be read as permission to dispatch. A closed
 * failure returns `{ satisfied: false }`, which the guard treats as "upstream
 * still pending" — the recoverable branch, since the start-up recovery loop
 * recomputes `needs_satisfied` for every non-terminal run and re-fires its ready
 * jobs, and the stale-run expiry sweep is the backstop.
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
  // Unreachable: the loop either returns a verdict or fails closed on the last
  // attempt. Kept so the fail-closed direction is the function's only exit.
  return { satisfied: false };
}

/**
 * Resolve the `execution_jobs.job_id` a ready job is currently tracked under.
 *
 * `onJobStatus` keys on the job ID, not the job name: the tracker's in-memory
 * job map, its scheduler hook, its run-completion check and the
 * `(run_id, job_id)` upsert conflict target all use it. Passing a name matches
 * nothing, so the upsert INSERTs a second row under `job_id = <name>` while the
 * real placeholder stays `pending` and the scheduler hook never runs.
 *
 * A job still waiting on a gate sits on a `NEEDS_PENDING_JOB_ID_PREFIX`
 * placeholder — the one synthetic shape this codebase builds, for the needs
 * gate, the approval hold and the rolling-wave hold alike — which
 * {@link ExecutionTracker.findSyntheticJobId} resolves from memory and from the
 * DB. `undefined` therefore means the job is NOT waiting on a gate: it already
 * dispatched and had its placeholder swapped for a real id, or nothing tracks
 * it at all. Neither is this gate's to terminalize.
 *
 * A by-name `execution_jobs` fallback would resolve exactly those already-
 * dispatched rows, and the caller would then mark a running or completed job
 * `skipped` — the upsert carries no terminal-status guard, so a `success` row
 * would be overwritten. Answering `undefined` is the safe direction: the caller
 * leaves the context in place and a later recompute can still act.
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
 * A needs-gated job must not dispatch merely because a hold was released. The
 * needs scheduler claims a downstream on `needs_satisfied` alone, so every
 * release path (approval, the stale detector's concurrency sweep, wait holds,
 * admin release) funnels through `dispatchReadyJob` and would otherwise run the
 * job beside a pending upstream — or after a failed one.
 *
 * Four outcomes:
 * - upstreams satisfied and admitted -> `'proceed'`, the ordinary path (a job
 *   with no needs edges reads as dispatchable, so this is a no-op for it);
 * - upstream not terminal yet -> `'stop'` without consuming the context, so the
 *   scheduler's next `onJobReady` still has one to dispatch with;
 * - upstream terminal but its status not admitted by the edge's `run_on`, and
 *   {@link resolveTrackedJobId} finds the placeholder the job waits on ->
 *   consume the context and terminalize that row as `skipped`;
 * - same, but no tracker or no placeholder -> `'stop'` without consuming, so
 *   the context outlives the miss and a later recompute can still resume the
 *   job. Consuming with nothing to terminalize would delete the only resume
 *   path and leave the job pending until the context expiry sweep.
 *
 * Reads only. The scheduler owns the `needs_satisfied` claim; see the warning on
 * `recomputeNeedsSatisfied` about handing claims back.
 *
 * Called BEFORE the context is consumed, for the same reason
 * {@link hasPendingHold} is: refusing after the consume would delete the resume
 * path and strand the job.
 */
async function applyNeedsGate(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  executionTracker: ExecutionTracker | undefined,
): Promise<'proceed' | 'stop'> {
  const verdict = await readNeedsVerdict(db, runId, jobName);
  if (!verdict.satisfied) {
    // Upstream is not terminal yet. The scheduler re-fires `onJobReady` when it
    // completes, and the context is still here for that call.
    logger.info('Ready job has unsatisfied needs — leaving it for the scheduler', {
      runId,
      jobName,
    });
    return 'stop';
  }
  if (verdict.action === 'skip') {
    // Upstream IS terminal but its status is not admitted by the edge's
    // `run_on`. The scheduler will never fire ready again, so returning early
    // would strand the job until the expiry sweep. Terminalize it instead —
    // `onJobStatus` drives `runSchedulerHook` -> `evaluateDownstreams`, which
    // propagates the skip to this job's own downstreams.
    logger.info('Ready job upstream is terminal and unmet — skipping', {
      runId,
      jobName,
      reason: verdict.reason,
    });
    // Resolve the tracked job id BEFORE consuming the context. Without a row to
    // terminalize, consuming would delete the only resume path and leave the
    // placeholder pending forever; leaving the context in place keeps the job
    // recoverable by a later recompute.
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
    // `error` (not `reason`) is the field the tracker persists to
    // `error_message`, so the skip carries its cause to the dashboard.
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
 * The subset of a context row the ready-dispatch re-gate reads.
 *
 * `ContextStore.matchContext` returns the raw `contexts` row, so the field names
 * are snake_case. `concurrency_strategy` and `hold_expiry_seconds` are optional
 * because the release-path callers already in the tree narrow their closure to
 * `concurrency_limit` alone; an absent strategy resolves to
 * {@link DEFAULT_CONCURRENCY_STRATEGY} and an absent hold window to
 * {@link DEFAULT_HOLD_EXPIRY_SECONDS}, which are also the columns' own defaults.
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
   * Audits each re-hold, mirroring the `held_run.request` row the dispatch-pass
   * path writes for every hold it mints. Optional: a call site with no writer
   * still gates, exactly as the dispatch path's own `accessLogWriter?.record`
   * degrades.
   */
  accessLogWriter?: Pick<AccessLogWriter, 'record'>;
  /** The routing key the audit row is attributed to, when the call site knows it. */
  routingKey?: string | null;
}

/** What {@link resolveRunConcurrency} needs to evaluate the concurrency gate. */
export interface RunConcurrency {
  orgId: string;
  group: string;
  contextId: string;
  limit: number | null;
  strategy: EngineContext['concurrencyStrategy'];
  /**
   * The context's own hold window, seconds. A queued hold this gate mints must
   * expire on the same schedule as one the dispatch pass mints for the same
   * context, or an operator's configured queue timeout applies to one path and
   * not the other.
   */
  holdExpirySeconds: number;
}

/**
 * Resolve a run's bound context to the inputs the concurrency gate needs.
 *
 * `null` means no concurrency constraint applies — the run has no bound context,
 * or the context it names no longer exists. That is the common case, so the cost
 * on the ready-dispatch path is one indexed lookup by `run_id`.
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
 * The context protection pipeline runs once, at dispatch-pass time. Only the
 * CONCURRENCY gate is time-varying — branch, trust, reviewer and wait-timer
 * verdicts cannot change between then and now, and approval state is already
 * covered by {@link hasPendingHold}. So a job that reaches this chokepoint after
 * its `needs` were satisfied, or after an approval / wait / admin hold released,
 * would otherwise dispatch with no limit check at all and run over its group's
 * limit.
 *
 * Only {@link evaluateConcurrencyGate} is consulted. Re-running the whole
 * pipeline would re-litigate branch/trust/reviewer decisions already made — and
 * could re-derive the very approval hold `hasPendingHold` exists to respect.
 *
 * Re-holding a just-released job is CORRECT, not a ping-pong: the slot that
 * freed can be retaken by another job before this one dispatches, and the queued
 * hold is what the stale detector's sweep releases when a slot frees again.
 *
 * Called BEFORE the context is consumed, for the same reason every other guard
 * here is: a re-held job must keep its pending context so the release path can
 * resume it.
 */
async function applyContextProtectionGate(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
  gateDeps: ReadyDispatchGateDeps,
): Promise<'proceed' | 'stop'> {
  // An invoke gate never reaches an agent — `releaseInvokeGate` summons the
  // source repo's subscribers — so it never becomes a `running` row and holds no
  // slot in the group `countOccupyingJobs` counts. Gating it would queue a cross-repo
  // summon behind jobs it does not compete with, and expire it outright if no
  // slot freed inside the hold window. The three call sites that dispatch ROOT
  // invoke gates pass no gate deps at all for the same reason; this is the
  // needs-gated case, which reaches the shared ready callback.
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
  // One audit row per hold, matching what the dispatch-pass path writes for
  // every row it mints: a hold that appears in the approval queue with no trail
  // saying it was raised is a gap, whichever gate raised it. The actor is the
  // dispatcher system component — no operator is present on this path.
  void gateDeps.accessLogWriter?.record({
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
  });
  return 'stop';
}

/**
 * Dispatch a job that has become ready via the needs scheduler.
 *
 * Called by the onJobReady callback registered on the execution tracker.
 * Consumes the pending dispatch context stored at processWebhook time,
 * dispatches the job through the normal dispatcher path, and updates the
 * execution tracker with the real job ID.
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
  // A job can be BOTH needs-gated and held for approval, and the two use the
  // SAME `needs-pending-` synthetic id and the same pending context. The needs
  // scheduler claims a downstream on `needs_satisfied` alone, so without this
  // gate an upstream completing dispatched a held job straight to an agent while
  // its `held_runs` row still said `pending` — approval bypassed entirely.
  //
  // Checked BEFORE consuming the context: refusing after the consume would
  // delete the resume path and strand the job forever. Every release path flips
  // the row out of `pending` before it dispatches, so a legitimate resume passes
  // straight through.
  if (db && (await hasPendingHold(db, runId, jobName))) {
    logger.info('Ready job is held for approval — leaving it for the release path', {
      runId,
      jobName,
    });
    return;
  }

  if (db && (await applyNeedsGate(db, runId, jobName, executionTracker)) === 'stop') return;

  // Ordering is load-bearing: the needs gate runs first, so a job whose upstream
  // failed is skipped rather than queued for a slot it would never use.
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

  // An invoke gate never reaches an agent: on release it summons the source
  // repo's subscribers instead of dispatching its (stepless) job input. Fail
  // loudly rather than silently hanging if the gate deps are missing.
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
        // The gate is tracked under its `needs-pending-` placeholder id, and
        // `onJobStatus` keys on the job id — see {@link resolveTrackedJobId}.
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

  try {
    const result = await dispatcher.dispatch(pendingCtx.jobInput);
    if (result.status === 'rejected') {
      logger.error('Scheduler-dispatched job rejected by dispatcher', {
        runId,
        jobName,
        reason: (result as any).reason,
      });
      if (executionTracker) {
        // Terminalize the `needs-pending-` placeholder the job is still tracked
        // under, not its name — see {@link resolveTrackedJobId}. A rejected
        // dispatch never got a real job id to swap it for.
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
      // `queued-no-backend` is handled exactly like `queued`: the job IS in the
      // dispatch queue under `result.jobId`, so swapping the synthetic
      // `needs-pending-*` placeholder for the real id is what lets the queue
      // expiry sweep terminalize it (`unroutable`) instead of leaving the run
      // pinned on a placeholder no agent will ever update.
      if (result.status === 'queued-no-backend') {
        logger.warn('Scheduler-dispatched job has no matching backend (tracked)', {
          runId,
          jobName,
        });
      }
      // Update the execution tracker with the real job ID from the dispatcher.
      // Find and replace the synthetic needs-pending-* entry so isRunComplete
      // doesn't block on a placeholder that no agent will ever update.
      if (executionTracker) {
        const syntheticId = await executionTracker.findSyntheticJobId(runId, jobName);
        await executionTracker.addJobsToRun(
          runId,
          [
            {
              jobId: result.jobId,
              jobName,
              runsOnLabels: pendingCtx.runsOnLabels,
            },
          ],
          undefined,
          syntheticId,
        );
        // The scheduler has decided this job is ready to dispatch, so its needs
        // are satisfied by definition. addJobsToRun INSERTs the real row with
        // needs_satisfied=false (DB default), losing the flag set on the synthetic
        // row by evaluateDownstreams. Restore it here so checkSchedulerInvariant
        // doesn't flag the real row as "stuck" on the next completion check.
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
 * Read the repository's default branch out of a webhook payload.
 *
 * Resolution order:
 *   1. `normalizer.extractDefaultBranch?(payload)` — provider-specific hook
 *      (universal-git reads a JSONPath from the source's `payloadPaths.defaultBranch`).
 *   2. Fallback to `payload.repository.default_branch` — the GitHub-shaped
 *      default that most forges mirror.
 *
 * `null` when neither source names one. Shared by `isDefaultBranchPush` (which
 * compares it against the pushed branch) and the registration write path (which
 * persists it, so a scheduled run can present it as its own branch).
 */
export function extractDefaultBranch(
  payload: Record<string, unknown>,
  normalizer: WebhookNormalizer,
): string | null {
  const viaHook = normalizer.extractDefaultBranch?.(payload) ?? null;
  const repository = payload.repository as { default_branch?: string } | undefined;
  return viaHook ?? repository?.default_branch ?? null;
}

/**
 * Check whether a webhook event is a push to the repository's default branch.
 * Used to trigger registration extraction for workflow event subscriptions.
 */
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
 * Cap on the per-decision trace forwarded to the Platform.
 *
 * A fixed bound on a debug payload, not a behavior an operator tunes: the
 * summary rides an `execution.event` and lands in a stored row, so an
 * essay-length trace from a workflow with hundreds of triggers must not be able
 * to grow either without limit.
 */
export const DECISION_TRACE_MAX_CHECKS = 50;

/**
 * Create a serializable summary of a workflow decision for Platform forwarding.
 *
 * Carries the individual checks, capped, so the dashboard can answer "why did
 * this workflow not fire" from the delivery alone. `checksCount` stays the
 * untruncated total, and `checksTruncated` marks a trace the cap shortened.
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
 * Byte budget for the whole forwarded trace, across every workflow on the
 * delivery.
 *
 * The per-decision check cap and the per-field text clamp bound one entry; this
 * bounds the frame. One event is evaluated against every workflow in the lock
 * file plus every organization-wide registration, so a repository with a
 * hundred comment-triggered workflows multiplies a bounded entry into an
 * unbounded message. A frame past the Platform's WebSocket payload ceiling
 * closes the orchestrator's connection, stalling every delivery for that
 * organization until it reconnects — so the budget sits well under the
 * Platform's own storage guard, which is then a backstop rather than the only
 * limit.
 */
export const DECISION_TRACE_MAX_BYTES = 131_072;

/**
 * Bound the serialized trace, replacing whatever did not fit with a marker.
 *
 * Truncating rather than dropping keeps the delivery's answer to "why did my
 * workflow not fire" partially readable, and says out loud that the rest was
 * dropped.
 */
export function capDecisionSummaries(
  summaries: readonly Record<string, unknown>[],
  maxBytes: number = DECISION_TRACE_MAX_BYTES,
): Record<string, unknown>[] {
  return truncateDecisionsToByteBudget(summaries, maxBytes).decisions;
}
