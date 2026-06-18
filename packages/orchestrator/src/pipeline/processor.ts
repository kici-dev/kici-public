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
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { DedupCache } from '../webhook/dedup.js';
import type { ProviderRegistry, ProviderBundle } from '../provider-registry.js';
import type { LockFileCache } from '../lockfile-cache.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { PlatformClient } from '../ws/platform-client.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { SourceCache } from '../cache/index.js';
import type { BuildCoordinator } from '../cache/index.js';
import type { DepCache } from '../cache/index.js';
import type { PendingBuildTracker } from '../cache/index.js';
import type { PendingInitTracker } from '../cache/pending-inits.js';
import type { PendingDynamicTracker } from '../cache/pending-dynamics.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { HostRosterStore } from '../agent/host-roster.js';
import type { RunCoordinator } from '../cluster/coordinator.js';
import type { TeamMembershipLookup } from '../approvals/team-membership-lookup.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { ContributorCache } from '../security/contributor-cache.js';
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
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { CronScheduler } from '../cron/cron-scheduler.js';
import type { GlobalWorkflowPolicy } from '../security/global-workflow-policy.js';
import type { EventLogWriter } from '../webhook/event-log.js';
import { EventLogSource } from '@kici-dev/engine';
import { ExecutionJobStatus, TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { LockJob } from '@kici-dev/engine';
import type { EnvironmentStore } from '../environments/environment-store.js';
import type { VariableStore } from '../environments/variable-store.js';
import type { TrustResolver, IdentityLink, PermissionLevel } from '../security/trust-resolver.js';
import type { HeldRunStore } from '../environments/held-runs.js';
import type { WorkflowDecision } from '@kici-dev/engine';

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
    await db
      .insertInto('pending_job_contexts')
      .values({
        run_id: runId,
        job_name: jobName,
        job_input: JSON.stringify(ctx.jobInput),
        runs_on_labels: JSON.stringify(ctx.runsOnLabels),
      })
      .onConflict((oc) =>
        oc.columns(['run_id', 'job_name']).doUpdateSet({
          job_input: JSON.stringify(ctx.jobInput),
          runs_on_labels: JSON.stringify(ctx.runsOnLabels),
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
    .returning(['job_input', 'runs_on_labels'])
    .execute();

  if (claimed.length === 0) return undefined;

  const row = claimed[0];
  return {
    jobInput: row.job_input as unknown as QueuedJobInput,
    runsOnLabels: row.runs_on_labels as unknown as string[],
  };
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
  // Check for concrete needs (string or NeedsEntry with 'name')
  const hasConcreteNeeds = lockJob.needs.some(
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
 * Extract the first line of the commit message from a webhook payload.
 * Handles push (head_commit.message) and PR (pull_request.title) events.
 */
/**
 * Best-effort extraction of a repository identifier from a generic webhook
 * payload for cross-source dispatch (phase 28.5). Generic webhooks have no
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

export function extractCommitMessage(event: string, payload: unknown): string | undefined {
  const p = payload as Record<string, unknown>;
  if (event === 'push') {
    const headCommit = p.head_commit as { message?: string } | undefined;
    if (headCommit?.message) {
      // Take first line only
      return headCommit.message.split('\n')[0];
    }
  }
  if (
    event === 'pull_request' ||
    event === 'pull_request_review' ||
    event === 'pull_request_review_comment'
  ) {
    const pr = p.pull_request as { title?: string } | undefined;
    if (pr?.title) return pr.title;
  }
  if (event === 'issue_comment') {
    const issue = p.issue as { title?: string } | undefined;
    if (issue?.title) return issue.title;
  }
  return undefined;
}

/**
 * Build a human-readable summary for a security hold check.
 */
export function buildSecurityHoldSummary(
  reason: string,
  tier: string,
  contributorUsername?: string,
): string {
  const parts: string[] = [];

  if (reason === 'workflow_modification') {
    parts.push(
      'This PR modifies workflow files (.kici/) and was submitted by a non-trusted contributor.',
    );
    parts.push('Workflow changes require approval from a user with ci_trust:write or higher.');
  } else if (reason === 'unknown_contributor') {
    parts.push('Unknown contributor. Requires approval from a user with ci_trust:write or higher.');
  } else if (reason === 'fork_pr') {
    parts.push(
      'Fork PR requires approval. Requires approval from a user with ci_trust:write or higher.',
    );
  } else if (reason === 'environment_trust') {
    parts.push('Environment requires a higher trust level than the contributor has.');
    parts.push('Requires approval from a user with ci_trust:write or higher.');
  } else {
    parts.push(`Held for security review: ${reason}`);
  }

  if (contributorUsername) {
    parts.push(`\n**Contributor:** ${contributorUsername} (tier: ${tier})`);
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
 * Dependencies for the processing pipeline.
 * All injected for testability. Fully provider-agnostic.
 *
 * sourceCache and buildCoordinator are optional for backward compatibility --
 * existing tests and deployments without cache configured still work.
 */
export interface ProcessingDeps {
  dedup: DedupCache;
  providerRegistry: ProviderRegistry;
  lockFileCache: LockFileCache;
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
  /** Commit status reporter for setting pending/success/failure/error on commits. Optional. */
  checkRunReporter?: CheckRunReporter;
  /** Execution tracker for DB persistence. Optional -- if not set, execution tracking is skipped. */
  executionTracker?: ExecutionTracker;
  /** Agent registry for determining execution target platform/arch. Optional -- if not set, defaults to linux/x64. */
  agentRegistry?: AgentRegistry;
  /** Run coordinator for multi-orchestrator job routing. Optional -- if not set, all jobs dispatch locally (single-orchestrator mode). */
  coordinator?: RunCoordinator;
  /** Secret resolver for dispatch-time secret resolution. Optional -- if not set, secrets are not resolved. */
  secretResolver?: SecretResolver;
  /** Optional callback when source locations are extracted from a lock file workflow. */
  onSourceLocationsExtracted?: (
    workflowName: string,
    jobName: string,
    sourceLocations: Array<{ file: string; line: number; column: number } | undefined>,
  ) => void;
  /** Event router for registering lock file event subscriptions. Optional -- if not set, event routing is inactive. */
  eventRouter?: EventRouter;
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
  /** Environment store for looking up deployment environments. Optional -- if not set, environment features are inactive. */
  environmentStore?: EnvironmentStore;
  /** Variable store for resolving environment variables. Optional -- if not set, environment vars are not merged. */
  variableStore?: VariableStore;
  /** Held run store for persisting protection rule holds. Optional -- if not set, holds are not persisted. */
  heldRunStore?: HeldRunStore;
  /** Trust resolver for determining contributor trust tiers. Optional -- if not set, trust resolution is skipped. */
  trustResolver?: TrustResolver;
  /** Identity links pushed from Platform for trust resolution. Optional -- defaults to empty. */
  identityLinks?: IdentityLink[];
  /** ci_trust permission levels per user ID from Platform push. Optional -- defaults to empty. */
  orgMemberPermissions?: Map<string, PermissionLevel>;
  /**
   * Team-membership lookup pushed from the Platform (team name → member set).
   * Consumed by the approval resolver to satisfy `{team}` approval clauses.
   * Optional -- defaults to "no teams".
   */
  teamMembershipLookup?: TeamMembershipLookup;
  /** Global workflow policy for org-level permission enforcement. Optional -- if not set, global workflows are unrestricted. */
  globalWorkflowPolicy?: GlobalWorkflowPolicy;
  /** Inbound webhook delivery log writer. Optional -- if not set, deliveries are not persisted to event_log. */
  eventLog?: EventLogWriter;
  /** Where this delivery arrived: 'relay' (Platform WS) or 'direct' (HTTP).
   *  Used by the eventLog writer to populate the source column. Defaults to
   *  'direct' when omitted (independent / direct paths). */
  eventLogSource?: EventLogSource;
  /** Contributor permission cache. Optional -- if not set, membership-webhook
   *  invalidations silently no-op. In platform/hybrid mode the singleton is
   *  created in server.ts and threaded through both the Platform-relay WS
   *  path and the generic webhook HTTP path. */
  contributorCache?: ContributorCache;
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
  /** Cap on runsOnAll per-host children (default 1024). */
  maxFanoutHosts?: number;
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
): Promise<void> {
  const pendingCtx = await consumePendingJobContext(db, runId, jobName);
  if (!pendingCtx) {
    logger.warn('No pending dispatch context for ready job (may have been dispatched already)', {
      runId,
      jobName,
    });
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
        await executionTracker.onJobStatus(
          runId,
          jobName,
          ExecutionJobStatus.enum.failed,
          Date.now(),
          undefined,
          { error: `dispatch rejected: ${(result as any).reason}` },
        );
      }
    } else if (result.status === 'queued-no-backend') {
      logger.warn('Scheduler-dispatched job has no matching backend', {
        runId,
        jobName,
      });
    } else {
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
 * Check whether a webhook event is a push to the repository's default branch.
 * Used to trigger registration extraction for workflow event subscriptions.
 *
 * Resolution order for the default branch:
 *   1. `normalizer.extractDefaultBranch?(payload)` — provider-specific hook
 *      (universal-git reads a JSONPath from the source's `payloadPaths.defaultBranch`).
 *   2. Fallback to `payload.repository.default_branch` — the GitHub-shaped
 *      default that most forges mirror.
 */
export function isDefaultBranchPush(
  info: WebhookInfo,
  event: SimulatedEvent,
  payload: Record<string, unknown>,
  normalizer: WebhookNormalizer,
): boolean {
  if (info.event !== 'push') return false;
  const viaHook = normalizer.extractDefaultBranch?.(payload) ?? null;
  const repository = payload.repository as { default_branch?: string } | undefined;
  const defaultBranch = viaHook ?? repository?.default_branch ?? null;
  if (!defaultBranch) return false;
  return event.targetBranch === defaultBranch;
}

/**
 * Create a serializable summary of a workflow decision for Platform forwarding.
 */
export function summarizeDecision(decision: WorkflowDecision): Record<string, unknown> {
  return {
    workflowName: decision.workflowName,
    matched: decision.matched,
    matchedTrigger: decision.matchedTrigger,
    summary: decision.summary,
    checksCount: decision.checks.length,
  };
}
