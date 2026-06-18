/**
 * GitHub check run integration module.
 *
 * Creates and updates check runs at key lifecycle points using the Checks API.
 * Per locked decisions:
 * - Check runs created (queued) at trigger match time (before agent picks up the job)
 * - Both per-job AND overall workflow check runs: kici/{workflow} and kici/{workflow}/job/{job}
 * - Success ONLY if ALL jobs pass
 * - Cancelled/timed-out use 'cancelled' conclusion
 * - All API calls are fire-and-forget (non-blocking)
 *
 * Check run IDs are tracked in-memory after creation so that subsequent
 * updates (job complete, workflow complete) can reference them via checks.update().
 *
 * Enriched output:
 * - Live step progress with checklist-style updates (debounced at 5s)
 * - Failed check runs include step names, error messages, exit codes, and log context
 * - Check run annotations link failures to step source locations in workflow files (.kici/workflows/*.ts)
 *
 * Currently GitHub-only. Non-GitHub providers are handled gracefully (no-op with log).
 *
 * Note: The engine-level CheckStatusPoster interface (packages/engine/src/provider/check-status-poster.ts)
 * provides a provider-agnostic API for posting security-related check statuses (holds, approvals,
 * workflow modifications). The GitHub implementation is at packages/orchestrator/src/providers/github/check-status-poster.ts.
 * This CheckRunReporter handles execution lifecycle checks (queued, in_progress, completed per job/workflow).
 * Future cleanup may unify both under CheckStatusPoster, but they serve different purposes today.
 */

import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createInstallationOctokit, type GitHubAppConfig } from '../providers/github/auth.js';
import { githubCheckRunTotal } from '../metrics/prometheus.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { StepLogBuffer } from './step-log-buffer.js';
import {
  buildCheckRunSummary,
  buildAnnotations,
  buildProgressText,
  type StepResultData,
  type SourceLocationData,
  type CheckAnnotation,
  type StepProgressEntry,
} from './check-run-summary.js';
import type { CheckRunTrackingKey, CheckRunTrackingStore } from './check-run-tracking-store.js';

const logger = createLogger({ prefix: 'check-run-reporter' });

/** Debounce interval for in_progress check run updates (ms). */
const PROGRESS_DEBOUNCE_MS = 5_000;

import { ExecutionJobStatus, ExecutionStepStatus, CheckRunConclusion } from '@kici-dev/engine';

/**
 * Dependencies for the CheckRunReporter.
 */
interface CheckRunReporterDeps {
  /**
   * Provider registry for per-routing-key credential lookup.
   * When provided, the reporter resolves GitHub App credentials by routing key
   * from the registry's CloneTokenProvider config. Takes precedence over githubConfig.
   */
  providerRegistry?: ProviderRegistry;
  /**
   * GitHub App config for creating Octokit instances.
   * Fallback for backward compatibility when providerRegistry is not provided
   * or when no routing key is available.
   */
  githubConfig?: GitHubAppConfig;
  /** Step log buffer for enriched failure summaries. */
  stepLogBuffer?: StepLogBuffer;
  /**
   * DB-backed tracking store. When provided, every per-key state mutation
   * (check-run ID, step-progress array, build creation marker,
   * in-progress-sent flag) is written through to the store so a replacement
   * coord on Raft leader switch can recover the state. When omitted (the
   * back-compat path used by unit tests that don't need HA correctness),
   * the reporter operates entirely from in-memory `Map`s.
   */
  trackingStore?: CheckRunTrackingStore;
  /** Resolver for step source locations from the lock file (for annotations). */
  getStepSourceLocations?: (
    workflowName: string,
    jobName: string,
  ) => SourceLocationData[] | undefined;
  /**
   * Base URL of the user-facing dashboard (e.g.
   * `https://dashboard.example.com/dashboard`). When set AND
   * `getOrgPublicAlias()` returns an alias, the reporter populates
   * `details_url = <dashboardUrl>/r/orgs/<alias>/runs/<runId>` on
   * every check-run create/update. When unset, no `details_url` is
   * emitted (preserving today's behavior).
   */
  dashboardUrl?: string;
  /**
   * Resolver for the orchestrator's owning org public alias. Typically
   * wired to `PlatformClient.getOrgPublicAlias()`. Returns the
   * `oal_<12-char>` alias supplied by Platform on `auth.success`, or
   * `undefined` before auth completes / when running against a
   * Platform that predates the alias plumbing.
   */
  getOrgPublicAlias?: () => string | undefined;
}

/**
 * Options for setPending.
 */
interface SetPendingOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  jobNames: string[];
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

/**
 * Options for setBuildPending.
 */
interface SetBuildPendingOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

/**
 * Options for setBuildComplete.
 */
interface SetBuildCompleteOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  status: Extract<ExecutionJobStatus, 'success' | 'failed' | 'cancelled' | 'timed_out_stale'>;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  description?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

/**
 * Options for updateJobStatus.
 */
interface UpdateJobStatusOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  jobName: string;
  state: Extract<ExecutionJobStatus, 'success' | 'failed' | 'cancelled' | 'timed_out_stale'>;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  description?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
  /** Additional data from the agent (e.g., stepResults). */
  data?: Record<string, unknown>;
  /** Run ID for StepLogBuffer lookup. */
  runIdForLogs?: string;
  /** Job ID for StepLogBuffer lookup. */
  jobId?: string;
}

/**
 * Options for updateWorkflowStatus.
 */
interface UpdateWorkflowStatusOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  overallStatus: Extract<
    ExecutionJobStatus,
    'success' | 'failed' | 'cancelled' | 'timed_out_stale'
  >;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  description?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

/**
 * Options for updateStepProgress.
 */
interface UpdateStepProgressOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  jobName: string;
  stepIndex: number;
  stepName: string;
  state: 'running' | 'success' | 'failed' | 'skipped' | 'cancelled' | 'error'; // step progress states (broader than ExecutionStepStatus)
  durationMs?: number;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  requestId?: string;
  runId?: string;
}

/**
 * Reports check run status to Git hosting providers.
 *
 * Currently supports GitHub via the Checks API (checks.create / checks.update).
 * Non-GitHub providers are handled gracefully (no-op with warning log).
 *
 * All public methods are fire-and-forget: they return void immediately
 * and log errors internally without propagating them.
 */
export class CheckRunReporter {
  /**
   * L1 cache: composite key → check run ID.
   *
   * Backed by `check_run_tracking.check_run_id` when `deps.trackingStore`
   * is wired. On a miss the cache falls through to the store; on a store
   * miss the lookup returns undefined and the caller logs + skips.
   *
   * Without the store this Map IS the source of truth (single-coord
   * deployments, unit tests).
   */
  private readonly checkRunIds = new Map<string, number>();
  /**
   * L1 cache: in-flight build-creation promises. The DB-backed counterpart
   * lives in `check_run_tracking.build_creation_state`; this Map is needed
   * locally so a same-process `setBuildComplete` can await the
   * in-progress `setBuildPending` promise (the DB column is a state
   * marker, not an awaitable).
   */
  private readonly pendingBuildCreations = new Map<string, Promise<void>>();
  /** L1 cache: step-progress entries (synced to `check_run_tracking.step_progress_json`). */
  private readonly stepProgress = new Map<string, StepProgressEntry[]>();
  /**
   * L1 cache: per-key debounce timers. NOT persisted — on coord failover
   * the next update either flushes immediately (because the DB row's
   * `updated_at` is older than the debounce window) or starts a fresh
   * timer.
   */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /** L1 cache: first in-progress sent flag (synced to `check_run_tracking.in_progress_sent_at`). */
  private readonly inProgressSent = new Map<string, boolean>();
  /**
   * L1 cache: runId → set of check-run composite keys. Synced to the
   * indexed `check_run_tracking.run_id` column so a replacement coord can
   * still find every key for a runId at cleanup time.
   */
  private readonly runIdToKeys = new Map<string, Set<string>>();

  constructor(private deps: CheckRunReporterDeps) {}

  /**
   * Update the provider registry used for per-routing-key credential lookup.
   * Called after config reload when the provider registry is rebuilt.
   */
  updateRegistry(newRegistry: ProviderRegistry): void {
    this.deps = { ...this.deps, providerRegistry: newRegistry };
  }

  /**
   * Late-bind the public-alias resolver. Called from `server.ts` /
   * `standalone.ts` after `PlatformClient` is constructed so the reporter
   * can pull the freshly-authenticated org's alias when building
   * `details_url`. orchestrator-core can't pass it at construction time
   * because the platform client is created later (after the HTTP server
   * starts).
   */
  setOrgPublicAliasResolver(resolver: () => string | undefined): void {
    this.deps = { ...this.deps, getOrgPublicAlias: resolver };
  }

  /**
   * Set pending (queued) check runs for a workflow and all its jobs.
   * Called at trigger match time (before agent picks up the job).
   * Fire-and-forget: errors are logged but don't block the pipeline.
   *
   * Creates check runs via checks.create with status 'queued'.
   * Per locked decision: both per-job AND overall workflow check runs.
   * Name format: kici/{workflow-name}, kici/{workflow-name}/job/{job-name}
   */
  setPending(opts: SetPendingOptions): void {
    this.doSetPending(opts).catch((err) => {
      logger.error('Failed to set pending check run', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
      });
    });
  }

  /**
   * Same as setPending but returns a Promise that resolves when check runs
   * are created. Used by the RunCoordinator for rerouted jobs where the
   * check runs MUST exist before job dispatch to ensure updates work.
   */
  async setPendingAwait(opts: SetPendingOptions): Promise<void> {
    await this.doSetPending(opts);
  }

  /**
   * Update a specific job's check run.
   * Called when a job reaches a terminal state.
   * Fire-and-forget: errors are logged but don't block the pipeline.
   */
  updateJobStatus(opts: UpdateJobStatusOptions): void {
    this.doUpdateJobStatus(opts).catch((err) => {
      logger.error('Failed to update job check run', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
        jobName: opts.jobName,
      });
    });
  }

  /**
   * Update the overall workflow check run.
   * Called when ALL jobs in a workflow reach terminal state.
   * Per locked decision: success ONLY if ALL jobs pass.
   * Fire-and-forget: errors are logged but don't block the pipeline.
   */
  updateWorkflowStatus(opts: UpdateWorkflowStatusOptions): void {
    this.doUpdateWorkflowStatus(opts).catch((err) => {
      logger.error('Failed to update workflow check run', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
      });
    });
  }

  /**
   * Clean up stale check runs left by a dead orchestrator.
   *
   * Unlike updateJobStatus/updateWorkflowStatus (which rely on in-memory checkRunId),
   * this method discovers check runs via the GitHub API by listing check runs for the
   * commit SHA and matching on the `kici/` name prefix. This allows a replacement
   * orchestrator to clean up check runs it didn't create.
   *
   * Uses the GitHub App to look up the installation for each repo, then lists and
   * updates any stuck "in_progress" check runs with a "timed_out" conclusion.
   *
   * Fire-and-forget: errors are logged but don't block.
   */
  cleanupStaleCheckRuns(opts: {
    provider: string;
    routingKey: string;
    owner: string;
    repo: string;
    sha: string;
    workflowName: string;
    jobNames: string[];
  }): void {
    this.doCleanupStaleCheckRuns(opts).catch((err) => {
      logger.error('Failed to clean up stale check runs', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
      });
    });
  }

  /**
   * Update live step progress for a job's check run.
   * Called each time a step starts, completes, or fails.
   * The first 'running' step triggers an immediate in_progress transition.
   * Subsequent updates are debounced (5 seconds) to prevent API rate limiting.
   * Fire-and-forget: errors are logged but don't block the pipeline.
   */
  updateStepProgress(opts: UpdateStepProgressOptions): void {
    this.doUpdateStepProgress(opts).catch((err) => {
      logger.error('Failed to update step progress', {
        error: toErrorMessage(err),
        provider: opts.provider,
        workflowName: opts.workflowName,
        jobName: opts.jobName,
        stepName: opts.stepName,
      });
    });
  }

  /**
   * Set a build check run to pending (queued).
   * Called when a build job is dispatched for dependency installation and/or bundle compilation.
   * Separate from execution check runs so users see build progress independently.
   * Fire-and-forget: errors are logged but don't block the pipeline.
   *
   * Check run name format: kici/{workflowName}/setup
   */
  setBuildPending(opts: SetBuildPendingOptions): void {
    const buildCheckName = `kici/${opts.workflowName}/setup`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, buildCheckName);

    // Stamp the DB-backed pending marker BEFORE kicking off the create.
    // A replacement coord that takes over mid-create can read this marker
    // and avoid issuing a duplicate `checks.create()` for the same SHA.
    void this.persistBuildCreationPending(key, opts.runId);
    this.trackRunKey(opts.runId, key);

    const creation = this.doSetBuildPending(opts).catch((err) => {
      logger.error('Failed to set build pending check run', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
      });
    });

    this.pendingBuildCreations.set(key, creation);
    creation.finally(() => this.pendingBuildCreations.delete(key));
  }

  /**
   * Update a build check run to completed.
   * Called when the build job finishes (success, failure, or cancellation).
   * Fire-and-forget: errors are logged but don't block the pipeline.
   */
  setBuildComplete(opts: SetBuildCompleteOptions): void {
    this.doSetBuildComplete(opts).catch((err) => {
      logger.error('Failed to set build complete check run', {
        error: toErrorMessage(err),
        provider: opts.provider,
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
      });
    });
  }

  /**
   * Clean up step-progress entries, debounce timers, and DB rows for a
   * completed run. Called when the execution tracker prunes the run.
   *
   * In-memory cleanup is synchronous; the DB cleanup is fire-and-forget
   * because the caller (run-pruning hook) is on the response-shaping path
   * and shouldn't block on a network round-trip. Failure logs but does
   * not propagate.
   */
  cleanupRun(runId: string): void {
    const keysToClean = this.runIdToKeys.get(runId);
    if (keysToClean) {
      for (const key of keysToClean) {
        const timer = this.progressTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.progressTimers.delete(key);
        }
        this.stepProgress.delete(key);
        this.inProgressSent.delete(key);
        this.checkRunIds.delete(key);
      }
      this.runIdToKeys.delete(runId);
    }
    if (this.deps.trackingStore) {
      this.deps.trackingStore.deleteByRunId(runId).catch((err) => {
        logger.warn('Failed to delete check-run-tracking rows for run, leaving for GC', {
          runId,
          error: toErrorMessage(err),
        });
      });
    }
  }

  /**
   * Hydrate the L1 caches from the DB after a leader switch (or any
   * boot-time recovery). Called once on coord become-leader so the
   * runIdToKeys reverse map is populated for any future cleanupRun calls
   * without requiring a DB round-trip per cleanup. If no store is wired,
   * this is a no-op.
   */
  async recoverState(): Promise<void> {
    if (!this.deps.trackingStore) return;
    // We don't bulk-hydrate every L1 cache (the table could be large
    // across many shas). On-demand load-through inside resolveCheckRunId
    // handles ID lookups; the reverse-map cache is built lazily as the
    // store reports keys during cleanup.
    logger.info('CheckRunReporter recovered (DB-backed state lookups enabled)');
  }

  /** Track a check run key associated with a runId for later cleanup. */
  private trackRunKey(runId: string | undefined, key: string): void {
    if (!runId) return;
    let keys = this.runIdToKeys.get(runId);
    if (!keys) {
      keys = new Set();
      this.runIdToKeys.set(runId, keys);
    }
    keys.add(key);
  }

  /**
   * Parse a composite L1 cache key back into the (provider, owner, repo,
   * sha, check_name) tuple used by the store. The key format is fixed by
   * `checkRunKey()`; provider defaults to 'github' because today's
   * reporter only writes check runs for GitHub.
   */
  private parseKey(key: string): CheckRunTrackingKey {
    const idx1 = key.indexOf('/');
    const idx2 = key.indexOf('/', idx1 + 1);
    const idx3 = key.indexOf('/', idx2 + 1);
    return {
      provider: 'github',
      owner: key.slice(0, idx1),
      repo: key.slice(idx1 + 1, idx2),
      sha: key.slice(idx2 + 1, idx3),
      checkName: key.slice(idx3 + 1),
    };
  }

  /**
   * Write-through helper: persist a check-run ID to L1 + the store.
   * Used by `setPending` / `setBuildPending` after a successful
   * `checks.create()`.
   */
  private async persistCheckRunId(key: string, checkRunId: number, runId?: string): Promise<void> {
    this.checkRunIds.set(key, checkRunId);
    if (!this.deps.trackingStore) return;
    try {
      await this.deps.trackingStore.setCheckRunId(this.parseKey(key), checkRunId);
      if (runId) {
        await this.deps.trackingStore.markBuildCreationComplete(this.parseKey(key));
      }
    } catch (err) {
      logger.warn('Failed to persist check_run_tracking row; cache-only fallback', {
        key,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Read-through helper: look up a check-run ID. Checks L1 first, falls
   * through to the store on miss, caches the result on hit. Returns
   * undefined when neither layer has the ID — the caller logs + skips.
   */
  private async resolveCheckRunId(key: string): Promise<number | undefined> {
    const cached = this.checkRunIds.get(key);
    if (cached !== undefined) return cached;
    if (!this.deps.trackingStore) return undefined;
    try {
      const fromDb = await this.deps.trackingStore.getCheckRunId(this.parseKey(key));
      if (fromDb !== undefined) {
        this.checkRunIds.set(key, fromDb);
      }
      return fromDb;
    } catch (err) {
      logger.warn('Failed to read check_run_tracking row; treating as miss', {
        key,
        error: toErrorMessage(err),
      });
      return undefined;
    }
  }

  /**
   * Write-through helper: persist updated step-progress entries.
   */
  private async persistStepProgress(
    key: string,
    steps: StepProgressEntry[],
    runId?: string,
  ): Promise<void> {
    this.stepProgress.set(key, steps);
    if (!this.deps.trackingStore) return;
    try {
      await this.deps.trackingStore.setStepProgress(this.parseKey(key), steps, runId);
    } catch (err) {
      logger.warn('Failed to persist step-progress; cache-only fallback', {
        key,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Write-through helper: mark the first running-step transition as sent.
   */
  private async persistInProgressSent(key: string, runId?: string): Promise<void> {
    this.inProgressSent.set(key, true);
    if (!this.deps.trackingStore) return;
    try {
      await this.deps.trackingStore.markInProgressSent(this.parseKey(key), runId);
    } catch (err) {
      logger.warn('Failed to persist in-progress-sent marker; cache-only fallback', {
        key,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * Write-through helper: stamp `build_creation_state = 'pending'`.
   */
  private async persistBuildCreationPending(key: string, runId?: string): Promise<void> {
    if (!this.deps.trackingStore) return;
    try {
      await this.deps.trackingStore.markBuildCreationPending(this.parseKey(key), runId);
    } catch (err) {
      logger.warn('Failed to persist build-creation-pending marker', {
        key,
        error: toErrorMessage(err),
      });
    }
  }

  // -- Private implementation --

  /**
   * Resolve GitHub App credentials for a given routing key.
   *
   * Resolution order:
   * 1. If providerRegistry is provided AND routingKey is given, look up the bundle
   *    by routing key and extract config from the CloneTokenProvider's getAppConfig().
   * 2. Fall back to the direct githubConfig dep (backward compatible).
   *
   * Returns undefined if no config is available.
   */
  private resolveGithubConfig(routingKey?: string): GitHubAppConfig | undefined {
    if (routingKey && this.deps.providerRegistry) {
      const bundle = this.deps.providerRegistry.getByRoutingKey(routingKey);
      if (bundle) {
        // GitHubCloneTokenProvider exposes getAppConfig() for credential extraction
        if (bundle.cloneTokenProvider) {
          const provider = bundle.cloneTokenProvider as {
            getAppConfig?: () => GitHubAppConfig;
            provider: string;
          };
          if (typeof provider.getAppConfig === 'function') {
            return provider.getAppConfig();
          }
        }
      }
    }
    // Fallback to direct githubConfig
    return this.deps.githubConfig;
  }

  /**
   * Resolve trace IDs for check run summaries.
   * Priority: explicit option value > AsyncLocalStorage context > 'N/A'
   */
  private resolveTraceIds(opts: { requestId?: string; runId?: string }): {
    requestId: string;
    runId: string;
  } {
    const ctx = getRequestContext();
    return {
      requestId: opts.requestId ?? ctx.requestId ?? 'N/A',
      runId: opts.runId ?? ctx.runId ?? 'N/A',
    };
  }

  /**
   * Append trace IDs to a check run summary string.
   */
  private appendTraceIds(summary: string, traceIds: { requestId: string; runId: string }): string {
    return `${summary}\n\nTrace: ${traceIds.requestId} | Run: ${traceIds.runId}`;
  }

  private checkRunKey(owner: string, repo: string, sha: string, name: string): string {
    return `${owner}/${repo}/${sha}/${name}`;
  }

  /**
   * Build the `details_url` for a check run pointing at the dashboard's
   * public-alias resolver (`/r/orgs/<oal_xxx>/runs/<runId>`). Returns
   * `undefined` when either the dashboard URL or the alias is missing,
   * or when the runId is the synthetic `'N/A'` sentinel from
   * `resolveTraceIds` (no real run to link to). Strips any trailing
   * slash on `dashboardUrl` so the concatenation produces a single
   * separator.
   */
  private buildDetailsUrl(runId: string): string | undefined {
    if (!this.deps.dashboardUrl) return undefined;
    if (!runId || runId === 'N/A') return undefined;
    const alias = this.deps.getOrgPublicAlias?.();
    if (!alias) return undefined;
    const base = this.deps.dashboardUrl.replace(/\/+$/, '');
    return `${base}/r/orgs/${alias}/runs/${runId}`;
  }

  private async doSetPending(opts: SetPendingOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.warn('Check runs not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping check run', {
        hasConfig: !!githubConfig,
        hasInstallationId: !!opts.installationId,
      });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    // Create overall workflow check run
    const workflowCheckName = `kici/${opts.workflowName}`;
    const workflowKey = this.checkRunKey(opts.owner, opts.repo, opts.sha, workflowCheckName);
    const result = await this.createCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      name: workflowCheckName,
      head_sha: opts.sha,
      status: 'queued',
      output: {
        title: `KiCI: ${opts.workflowName}`,
        summary: this.appendTraceIds('Waiting for agent...', traceIds),
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });

    if (result) {
      this.trackRunKey(opts.runId, workflowKey);
      await this.persistCheckRunId(workflowKey, result, opts.runId);
    }

    // Create per-job check runs
    for (const jobName of opts.jobNames) {
      const jobCheckName = `kici/${opts.workflowName}/job/${jobName}`;
      const jobKey = this.checkRunKey(opts.owner, opts.repo, opts.sha, jobCheckName);
      const jobResult = await this.createCheckRun(octokit, {
        owner: opts.owner,
        repo: opts.repo,
        name: jobCheckName,
        head_sha: opts.sha,
        status: 'queued',
        output: {
          title: `KiCI: ${opts.workflowName}/${jobName}`,
          summary: this.appendTraceIds('Waiting for agent...', traceIds),
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      });

      if (jobResult) {
        this.trackRunKey(opts.runId, jobKey);
        await this.persistCheckRunId(jobKey, jobResult, opts.runId);
      }
    }
  }

  private async doUpdateJobStatus(opts: UpdateJobStatusOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.warn('Check runs not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping check run update');
      return;
    }

    const checkName = `kici/${opts.workflowName}/job/${opts.jobName}`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, checkName);
    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) {
      logger.warn('Check run ID not found for job update, skipping', { key });
      return;
    }

    // Cancel any pending debounce timer for this check run (completion takes priority)
    const pendingTimer = this.progressTimers.get(key);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.progressTimers.delete(key);
    }

    // Clear step progress for this key in the L1 cache. The DB row is
    // deleted later in cleanupRun once the run completes.
    this.stepProgress.delete(key);
    this.inProgressSent.delete(key);

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);

    // Build enriched summary based on state
    let summary: string;
    let annotations: CheckAnnotation[] | undefined;

    if (
      (opts.state === ExecutionJobStatus.enum.failed ||
        opts.state === ExecutionJobStatus.enum.cancelled ||
        opts.state === ExecutionJobStatus.enum.timed_out_stale) &&
      opts.data &&
      Array.isArray(opts.data.stepResults) &&
      this.deps.stepLogBuffer &&
      opts.runIdForLogs &&
      opts.jobId
    ) {
      // Build rich summary with step details and log context
      const stepResults = opts.data.stepResults as StepResultData[];

      summary = buildCheckRunSummary({
        jobName: opts.jobName,
        stepResults,
        logBuffer: this.deps.stepLogBuffer,
        runId: opts.runIdForLogs,
        jobId: opts.jobId,
        traceIds,
        jobDurationMs: opts.data.durationMs as number | undefined,
      });

      // Build annotations from source locations
      if (this.deps.getStepSourceLocations) {
        const sourceLocations = this.deps.getStepSourceLocations(opts.workflowName, opts.jobName);
        if (sourceLocations) {
          const locMap = new Map<number, SourceLocationData>();
          for (let i = 0; i < sourceLocations.length; i++) {
            if (sourceLocations[i]) {
              locMap.set(i, sourceLocations[i]);
            }
          }
          const result = buildAnnotations({ stepResults, sourceLocations: locMap });
          annotations = result.annotations.length > 0 ? result.annotations : undefined;

          // Mention remaining annotation count in summary
          if (result.remainingCount > 0) {
            summary += `\n\n_${result.remainingCount} additional annotation(s) not shown (GitHub limit: 50)._`;
          }
        }
      }
    } else if (
      opts.state === ExecutionJobStatus.enum.success &&
      opts.data &&
      Array.isArray(opts.data.stepResults)
    ) {
      // Success with step results -- build rich success summary
      const stepResults = opts.data.stepResults as StepResultData[];

      summary = buildCheckRunSummary({
        jobName: opts.jobName,
        stepResults,
        logBuffer: this.deps.stepLogBuffer ?? ({ getLastLines: () => undefined } as any),
        runId: opts.runIdForLogs ?? '',
        jobId: opts.jobId ?? '',
        traceIds,
        jobDurationMs: opts.data.durationMs as number | undefined,
      });
    } else {
      // Fallback: use description or default
      const { description } = this.mapJobConclusion(opts.state, opts.description);
      summary = this.appendTraceIds(description, traceIds);
    }

    const { conclusion } = this.mapJobConclusion(opts.state, opts.description);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: `KiCI: ${opts.workflowName}/${opts.jobName}`,
        summary,
        annotations,
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });
  }

  private async doUpdateWorkflowStatus(opts: UpdateWorkflowStatusOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.warn('Check runs not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping check run update');
      return;
    }

    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, `kici/${opts.workflowName}`);
    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) {
      logger.warn('Check run ID not found for workflow update, skipping', { key });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const { conclusion, description } = this.mapWorkflowConclusion(
      opts.overallStatus,
      opts.description,
    );
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: `KiCI: ${opts.workflowName}`,
        summary: this.appendTraceIds(description, traceIds),
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });
  }

  private async doCleanupStaleCheckRuns(opts: {
    provider: string;
    routingKey: string;
    owner: string;
    repo: string;
    sha: string;
    workflowName: string;
    jobNames: string[];
  }): Promise<void> {
    if (opts.provider !== 'github') {
      logger.debug('Stale check run cleanup not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig) {
      logger.debug('GitHub config not available for stale cleanup, skipping', {
        routingKey: opts.routingKey,
      });
      return;
    }

    // Look up the installation ID for this repo via the GitHub App
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: githubConfig.appId, privateKey: githubConfig.privateKey },
    });

    let installationId: number;
    try {
      const { data } = await appOctokit.apps.getRepoInstallation({
        owner: opts.owner,
        repo: opts.repo,
      });
      installationId = data.id;
    } catch (err) {
      logger.warn('Could not find installation for repo, skipping stale cleanup', {
        owner: opts.owner,
        repo: opts.repo,
        error: toErrorMessage(err),
      });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, installationId);

    // Build the set of check names we expect for this workflow
    const expectedNames = new Set<string>();
    expectedNames.add(`kici/${opts.workflowName}`);
    expectedNames.add(`kici/${opts.workflowName}/setup`);
    for (const jobName of opts.jobNames) {
      expectedNames.add(`kici/${opts.workflowName}/job/${jobName}`);
    }

    // List check runs for this commit and find stuck ones
    try {
      const { data } = await octokit.checks.listForRef({
        owner: opts.owner,
        repo: opts.repo,
        ref: opts.sha,
        per_page: 100,
      });

      let cleanedCount = 0;
      for (const checkRun of data.check_runs) {
        if (
          checkRun.status === 'in_progress' &&
          checkRun.name &&
          expectedNames.has(checkRun.name)
        ) {
          try {
            await octokit.checks.update({
              owner: opts.owner,
              repo: opts.repo,
              check_run_id: checkRun.id,
              status: 'completed',
              conclusion: 'timed_out',
              completed_at: new Date().toISOString(),
              output: {
                title: checkRun.name,
                summary: 'Orchestrator died — marked stale by Platform',
              },
            });
            cleanedCount++;
          } catch (updateErr) {
            logger.warn('Failed to update stale check run', {
              checkRunId: checkRun.id,
              checkName: checkRun.name,
              error: toErrorMessage(updateErr),
            });
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info('Cleaned up stale check runs', {
          owner: opts.owner,
          repo: opts.repo,
          sha: opts.sha,
          workflowName: opts.workflowName,
          cleanedCount,
        });
        githubCheckRunTotal.add(cleanedCount, { operation: 'stale_cleanup' });
      }
    } catch (err) {
      logger.error('Failed to list check runs for stale cleanup', {
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        error: toErrorMessage(err),
      });
    }
  }

  private async doUpdateStepProgress(opts: UpdateStepProgressOptions): Promise<void> {
    if (opts.provider !== 'github') return;

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) return;

    const checkName = `kici/${opts.workflowName}/job/${opts.jobName}`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, checkName);
    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) return;

    // Track this key for runId-based cleanup
    this.trackRunKey(opts.runId, key);

    // Update step progress array
    let steps = this.stepProgress.get(key);
    if (!steps) {
      steps = [];
      this.stepProgress.set(key, steps);
    }

    // Update or insert the step entry
    if (opts.stepIndex < steps.length) {
      steps[opts.stepIndex] = {
        name: opts.stepName,
        status: opts.state,
        durationMs: opts.durationMs,
      };
    } else {
      // Fill gaps with pending entries
      while (steps.length < opts.stepIndex) {
        steps.push({ name: `Step ${steps.length}`, status: 'pending' });
      }
      steps.push({
        name: opts.stepName,
        status: opts.state,
        durationMs: opts.durationMs,
      });
    }

    // Persist the updated array. Fire-and-forget: a write failure logs
    // but doesn't block the GitHub update path — the in-memory copy is
    // still correct for the rest of this orchestrator's lifetime.
    await this.persistStepProgress(key, steps, opts.runId);

    // First step going to 'running': immediate in_progress transition
    if (opts.state === ExecutionStepStatus.enum.running && !this.inProgressSent.get(key)) {
      await this.persistInProgressSent(key, opts.runId);

      const octokit = createInstallationOctokit(githubConfig, opts.installationId);
      const traceIds = this.resolveTraceIds(opts);
      const progressText = buildProgressText({ steps, traceIds });
      const detailsUrl = this.buildDetailsUrl(traceIds.runId);

      await this.updateCheckRun(octokit, {
        owner: opts.owner,
        repo: opts.repo,
        check_run_id: checkRunId,
        status: 'in_progress',
        output: {
          title: `KiCI: ${opts.workflowName}/${opts.jobName}`,
          summary: progressText,
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      });
      return;
    }

    // Subsequent updates: debounce at 5s interval
    if (!this.progressTimers.has(key)) {
      const timer = setTimeout(() => {
        this.progressTimers.delete(key);
        this.flushProgress(key, opts).catch((err) => {
          logger.error('Failed to flush step progress', {
            error: toErrorMessage(err),
            key,
          });
        });
      }, PROGRESS_DEBOUNCE_MS);

      this.progressTimers.set(key, timer);
    }
    // If timer already pending, do nothing -- it will pick up latest state when it fires
  }

  /**
   * Flush pending progress update to GitHub.
   */
  private async flushProgress(
    key: string,
    opts: {
      provider: string;
      owner: string;
      repo: string;
      sha: string;
      workflowName: string;
      jobName: string;
      installationId?: number;
      routingKey?: string;
      requestId?: string;
      runId?: string;
    },
  ): Promise<void> {
    const checkRunId = await this.resolveCheckRunId(key);
    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!checkRunId || !githubConfig || !opts.installationId) return;

    const steps = this.stepProgress.get(key);
    if (!steps) return;

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);
    const progressText = buildProgressText({ steps, traceIds });
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      check_run_id: checkRunId,
      status: 'in_progress',
      output: {
        title: `KiCI: ${opts.workflowName}/${opts.jobName}`,
        summary: progressText,
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });
  }

  private async doSetBuildPending(opts: SetBuildPendingOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.warn('Check runs not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping build check run', {
        hasConfig: !!githubConfig,
        hasInstallationId: !!opts.installationId,
      });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const buildCheckName = `kici/${opts.workflowName}/setup`;
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    const result = await this.createCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      name: buildCheckName,
      head_sha: opts.sha,
      status: 'queued',
      output: {
        title: `KiCI: ${opts.workflowName}/setup`,
        summary: this.appendTraceIds('Building dependencies and compiling workflow...', traceIds),
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });

    if (result) {
      const buildKey = this.checkRunKey(opts.owner, opts.repo, opts.sha, buildCheckName);
      await this.persistCheckRunId(buildKey, result, opts.runId);
    }
  }

  private async doSetBuildComplete(opts: SetBuildCompleteOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.warn('Check runs not supported for provider, skipping', {
        provider: opts.provider,
      });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping build check run update');
      return;
    }

    const buildCheckName = `kici/${opts.workflowName}/setup`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, buildCheckName);

    // Wait for in-flight setBuildPending to complete before looking up the ID
    const pending = this.pendingBuildCreations.get(key);
    if (pending) {
      await pending;
    }

    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) {
      logger.warn('Check run ID not found for build update, skipping', { key });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const { conclusion, description } = this.mapBuildConclusion(opts.status, opts.description);
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: `KiCI: ${opts.workflowName}/setup`,
        summary: this.appendTraceIds(description, traceIds),
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });
  }

  /**
   * Map internal build status to GitHub Checks conclusion and description.
   */
  private mapBuildConclusion(
    status: Extract<ExecutionJobStatus, 'success' | 'failed' | 'cancelled' | 'timed_out_stale'>,
    customDescription?: string,
  ): { conclusion: CheckRunConclusion; description: string } {
    switch (status) {
      case ExecutionJobStatus.enum.success:
        return {
          conclusion: CheckRunConclusion.enum.success,
          description: customDescription ?? 'Build complete',
        };
      case ExecutionJobStatus.enum.failed:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'Build failed',
        };
      case ExecutionJobStatus.enum.cancelled:
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Build cancelled',
        };
      case ExecutionJobStatus.enum.timed_out_stale:
        return {
          conclusion: CheckRunConclusion.enum.timed_out,
          description:
            customDescription ?? 'Build became stale -- no heartbeat received from agent.',
        };
    }
  }

  /**
   * Map internal job state to GitHub Checks conclusion and description.
   */
  private mapJobConclusion(
    state: Extract<ExecutionJobStatus, 'success' | 'failed' | 'cancelled' | 'timed_out_stale'>,
    customDescription?: string,
  ): { conclusion: CheckRunConclusion; description: string } {
    switch (state) {
      case ExecutionJobStatus.enum.success:
        return {
          conclusion: CheckRunConclusion.enum.success,
          description: customDescription ?? 'Job passed',
        };
      case ExecutionJobStatus.enum.failed:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'Job failed',
        };
      case ExecutionJobStatus.enum.cancelled:
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Execution cancelled',
        };
      case ExecutionJobStatus.enum.timed_out_stale:
        return {
          conclusion: CheckRunConclusion.enum.timed_out,
          description:
            customDescription ??
            'Run became stale -- no heartbeat received. Agent may have died or become unresponsive.',
        };
    }
  }

  /**
   * Map internal workflow state to GitHub Checks conclusion and description.
   */
  private mapWorkflowConclusion(
    status: Extract<ExecutionJobStatus, 'success' | 'failed' | 'cancelled' | 'timed_out_stale'>,
    customDescription?: string,
  ): { conclusion: CheckRunConclusion; description: string } {
    switch (status) {
      case ExecutionJobStatus.enum.success:
        return {
          conclusion: CheckRunConclusion.enum.success,
          description: customDescription ?? 'All jobs passed',
        };
      case ExecutionJobStatus.enum.failed:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'One or more jobs failed',
        };
      case ExecutionJobStatus.enum.cancelled:
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Execution cancelled',
        };
      case ExecutionJobStatus.enum.timed_out_stale:
        return {
          conclusion: CheckRunConclusion.enum.timed_out,
          description:
            customDescription ??
            'One or more jobs became stale -- no heartbeat received from agent.',
        };
    }
  }

  /**
   * Create a check run via the GitHub Checks API.
   * Returns the check run ID on success, or undefined on failure.
   */
  private async createCheckRun(
    octokit: Octokit,
    params: {
      owner: string;
      repo: string;
      name: string;
      head_sha: string;
      status: 'queued';
      output: { title: string; summary: string };
      /**
       * Optional URL shown as "Details" on the GitHub Check. Builds via
       * `buildDetailsUrl` from the public org alias — the canonical
       * `org_<12-char>` id never appears here.
       */
      details_url?: string;
    },
  ): Promise<number | undefined> {
    try {
      const result = await octokit.checks.create({
        owner: params.owner,
        repo: params.repo,
        name: params.name,
        head_sha: params.head_sha,
        status: params.status,
        output: params.output,
        ...(params.details_url && { details_url: params.details_url }),
      });

      githubCheckRunTotal.add(1, { operation: 'create' });
      return result.data.id;
    } catch (err: unknown) {
      const error = err as { status?: number; response?: { headers?: Record<string, string> } };
      if (error.status === 403) {
        const rateRemaining = error.response?.headers?.['x-ratelimit-remaining'];
        const rateReset = error.response?.headers?.['x-ratelimit-reset'];
        logger.error('GitHub API 403 creating check run', {
          name: params.name,
          rateRemaining,
          rateReset,
        });
      } else {
        logger.error('GitHub API error creating check run', {
          name: params.name,
          status: error.status,
          error: toErrorMessage(err),
        });
      }
      return undefined;
    }
  }

  /**
   * Update an existing check run via the GitHub Checks API.
   * Supports both 'completed' and 'in_progress' statuses.
   */
  private async updateCheckRun(
    octokit: Octokit,
    params: {
      owner: string;
      repo: string;
      check_run_id: number;
      status: 'completed' | 'in_progress';
      conclusion?: CheckRunConclusion;
      completed_at?: string;
      output: {
        title: string;
        summary: string;
        annotations?: CheckAnnotation[];
      };
      /**
       * Optional URL shown as "Details" on the GitHub Check. See
       * `createCheckRun` — same alias-based shape.
       */
      details_url?: string;
    },
  ): Promise<void> {
    try {
      const updateParams: Record<string, unknown> = {
        owner: params.owner,
        repo: params.repo,
        check_run_id: params.check_run_id,
        status: params.status,
        output: {
          title: params.output.title,
          summary: params.output.summary,
          ...(params.output.annotations &&
            params.output.annotations.length > 0 && {
              annotations: params.output.annotations,
            }),
        },
      };

      if (params.conclusion) {
        updateParams.conclusion = params.conclusion;
      }
      if (params.completed_at) {
        updateParams.completed_at = params.completed_at;
      }
      if (params.details_url) {
        updateParams.details_url = params.details_url;
      }

      await octokit.checks.update(updateParams as any);

      githubCheckRunTotal.add(1, { operation: 'update' });
    } catch (err: unknown) {
      const error = err as { status?: number; response?: { headers?: Record<string, string> } };
      if (error.status === 403) {
        const rateRemaining = error.response?.headers?.['x-ratelimit-remaining'];
        const rateReset = error.response?.headers?.['x-ratelimit-reset'];
        logger.error('GitHub API 403 updating check run', {
          checkRunId: params.check_run_id,
          rateRemaining,
          rateReset,
        });
      } else {
        logger.error('GitHub API error updating check run', {
          checkRunId: params.check_run_id,
          status: error.status,
          error: toErrorMessage(err),
        });
      }
    }
  }
}

/**
 * Build a meaningful failure description from agent job status data.
 *
 * Examines `stepResults` for the first failed step, falling back to
 * `data.error`, and finally to a generic "Job failed" message.
 */
export function buildJobFailureDescription(data: Record<string, unknown>): string {
  // Check for stepResults array with a failed step
  if (Array.isArray(data.stepResults)) {
    const failedStep = data.stepResults.find(
      (s: Record<string, unknown>) =>
        s.status === ExecutionStepStatus.enum.failed || s.status === 'error',
    );
    if (failedStep) {
      const name = failedStep.name ?? 'unknown';
      if (failedStep.error) {
        return `Step '${name}' failed: ${failedStep.error}`;
      }
      if (failedStep.exitCode !== undefined) {
        return `Step '${name}' failed (exit code ${failedStep.exitCode})`;
      }
      return `Step '${name}' failed`;
    }
  }

  // Fall back to top-level error
  if (data.error) {
    return `Job error: ${data.error}`;
  }

  return 'Job failed';
}
