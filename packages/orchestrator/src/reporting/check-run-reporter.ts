/**
 * GitHub Checks API integration for the execution lifecycle.
 *
 * - Check runs are created (queued) at trigger match time, before an agent picks up the job
 * - Per-job AND overall check runs: kici/{workflow} and kici/{workflow}/job/{job}
 * - Success ONLY if ALL jobs pass; cancelled/timed-out use the 'cancelled' conclusion
 * - All API calls are fire-and-forget (non-blocking)
 *
 * Check run IDs are tracked after creation so later updates can call checks.update().
 * Output carries live step progress (debounced at 5s), failure details (step names, errors,
 * exit codes, log context) and annotations pointing at step source locations in
 * `.kici/workflows/*.ts`. GitHub-only: other providers are a logged no-op.
 *
 * Security check statuses (holds, approvals, workflow modifications) go through the separate
 * engine `CheckStatusPoster` (packages/engine/src/provider/check-status-poster.ts; GitHub impl
 * in packages/orchestrator/src/providers/github/check-status-poster.ts) — the two serve
 * different purposes today.
 */

import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createInstallationOctokit, type GitHubAppConfig } from '../providers/github/auth.js';
import { githubCheckRunTotal } from '../metrics/prometheus.js';
import { buildReducedPrivilegeNote } from '../security/reduced-privilege-note.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { StepLogBuffer } from './step-log-buffer.js';
import {
  buildCheckRunSummary,
  buildAnnotations,
  buildProgressText,
  type StepResultData,
  type SourceLocationData,
  type CheckAnnotation,
  clampSummaryToLimit,
  type StepProgressEntry,
} from './check-run-summary.js';
import type { CheckRunTrackingKey, CheckRunTrackingStore } from './check-run-tracking-store.js';

const logger = createLogger({ prefix: 'check-run-reporter' });

/** Debounce interval for in_progress check run updates (ms). */
const PROGRESS_DEBOUNCE_MS = 5_000;

import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  CheckRunConclusion,
  type TerminalJobStatus,
} from '@kici-dev/engine';
import { runDetached } from '../helpers/run-detached.js';

interface CheckRunReporterDeps {
  /** Resolves GitHub App credentials by routing key from its CloneTokenProvider config. */
  providerRegistry?: ProviderRegistry;
  /** Feeds log context into failure summaries. */
  stepLogBuffer?: StepLogBuffer;
  /**
   * When provided, every per-key state mutation (check-run ID, step progress, build creation
   * marker, in-progress-sent flag) is written through so a replacement coord on Raft leader
   * switch can recover it. When omitted (unit tests that don't need HA correctness), state
   * lives only in the in-memory `Map`s.
   */
  trackingStore?: CheckRunTrackingStore;
  /** Step source locations from the lock file, for annotations. */
  getStepSourceLocations?: (
    workflowName: string,
    jobName: string,
  ) => SourceLocationData[] | undefined;
  /**
   * Dashboard base URL (e.g. `https://dashboard.example.com/dashboard`). When set AND
   * `getOrgPublicAlias()` returns an alias, every check-run create/update carries
   * `details_url = <dashboardUrl>/r/orgs/<alias>/runs/<runId>`; otherwise no `details_url`.
   */
  dashboardUrl?: string;
  /**
   * Typically `PlatformClient.getOrgPublicAlias()`: the `oal_<12-char>` alias the Platform
   * supplies on `auth.success`, or `undefined` before auth completes.
   */
  getOrgPublicAlias?: () => string | undefined;
}

interface SetPendingOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /**
   * The repository that DEFINES the workflow when it differs from the acted-on one (an
   * organization-wide workflow). Qualifies the check-run name so the run cannot share a check
   * run with a same-named workflow of the acted-on repository; see `workflowLabel`. Passing
   * the acted-on repository is a no-op, so a per-repository run's name cannot change by accident.
   */
  workflowRepoIdentifier?: string;
  jobNames: string[];
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

interface SetBuildPendingOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

interface SetBuildCompleteOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  status: TerminalJobStatus;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  description?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
}

interface UpdateJobStatusOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  jobName: string;
  state: TerminalJobStatus;
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
  /**
   * The run's resolved trust tier and lock-file branch. For any tier other than `trusted`, the
   * completion summary leads with the reduced-privilege note so a contributor reading a failed
   * fork-PR job can see what the build environment lacked. Both absent when trust never resolved.
   */
  trustTier?: string;
  lockFileSource?: string;
}

interface UpdateWorkflowStatusOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  overallStatus: TerminalJobStatus;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  description?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
  /**
   * Same contract as {@link UpdateJobStatusOptions}. The roll-up check carries the note too: a
   * contributor who reads only `kici/<workflow>` — the one branch protection usually requires —
   * would otherwise see a run fail with no explanation.
   */
  trustTier?: string;
  lockFileSource?: string;
}

export interface CompleteUndispatchedCheckRunsOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  /** Pass the exact list `setPending` / `setPendingAwait` used, or names miss the check runs. */
  jobNames: string[];
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  /** Explicit requestId for trace context (falls back to AsyncLocalStorage context). */
  requestId?: string;
  /** Explicit runId for trace context (falls back to AsyncLocalStorage context). */
  runId?: string;
  conclusion: CheckRunConclusion;
  /** The check-run output body. The title stays the standard `KiCI: <label>` form. */
  summary: string;
}

interface UpdateStepProgressOptions {
  provider: string;
  owner: string;
  repo: string;
  sha: string;
  workflowName: string;
  /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
  workflowRepoIdentifier?: string;
  jobName: string;
  stepIndex: number;
  stepName: string;
  state: 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs?: number;
  installationId?: number;
  /** Routing key for per-app credential lookup (e.g., "github:12345"). */
  routingKey?: string;
  requestId?: string;
  runId?: string;
}

/**
 * Reports check run status via the GitHub Checks API (checks.create / checks.update).
 * Non-GitHub providers are a no-op with a warning log.
 *
 * All public methods are fire-and-forget: they return void immediately and log errors
 * internally without propagating them.
 */
export class CheckRunReporter {
  /**
   * L1 cache: composite key → check run ID, backed by `check_run_tracking.check_run_id` when
   * `deps.trackingStore` is wired (miss → store; store miss → undefined, caller logs + skips).
   * Without the store this Map IS the source of truth (single-coord deployments, unit tests).
   */
  private readonly checkRunIds = new Map<string, number>();
  /**
   * L1 cache: in-flight build-creation promises. Needed locally even with the DB-backed
   * `check_run_tracking.build_creation_state`, so a same-process `setBuildComplete` can await
   * the in-progress `setBuildPending` (the DB column is a state marker, not an awaitable).
   */
  private readonly pendingBuildCreations = new Map<string, Promise<void>>();
  /** L1 cache: step-progress entries (synced to `check_run_tracking.step_progress_json`). */
  private readonly stepProgress = new Map<string, StepProgressEntry[]>();
  /**
   * L1 cache: per-key debounce timers. NOT persisted — on coord failover the next update
   * either flushes immediately (the DB row's `updated_at` is older than the debounce window)
   * or starts a fresh timer.
   */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /** L1 cache: first in-progress sent flag (synced to `check_run_tracking.in_progress_sent_at`). */
  private readonly inProgressSent = new Map<string, boolean>();
  /**
   * Keys whose job check run has been completed. Makes status monotonic: after a `completed`
   * update, no step-progress update may push it back to `in_progress`. Cancelling the debounce
   * timer at completion is not enough — a step status arriving later schedules a FRESH timer,
   * which would leave `status: in_progress` with a terminal `conclusion` attached, the
   * permanently-unresolved state completion exists to prevent. So the guard is on the write
   * itself, not on the timer.
   */
  private readonly terminalSent = new Set<string>();
  /**
   * L1 cache: runId → check-run composite keys. Synced to the indexed
   * `check_run_tracking.run_id` column so a replacement coord can find every key at cleanup.
   */
  private readonly runIdToKeys = new Map<string, Set<string>>();
  /**
   * Per-key serialization of GitHub check-run PATCHes. Two updates for one check run must never
   * be in flight at once: the terminal `completed` write and an earlier `in_progress` write race
   * last-write-wins, and an `in_progress` landing second reopens the check run to the
   * permanently-unresolved `{ status: in_progress, conclusion: <terminal> }` state. The
   * `terminalSent` re-check in `updateCheckRun` is a check-then-await and cannot stop a PATCH
   * already on the network; chaining every PATCH for a key makes re-check + PATCH atomic
   * relative to the completion write.
   */
  private readonly updateLocks = new Map<string, Promise<void>>();

  constructor(private deps: CheckRunReporterDeps) {}

  /**
   * Run `fn` after every queued PATCH for `key` has settled, so updates to one check run run
   * strictly in order. The chain swallows prior errors (each surfaces to its own caller) so one
   * failed PATCH does not wedge the key.
   */
  private runUpdateExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.updateLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.updateLocks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Called after config reload rebuilds the provider registry. */
  updateRegistry(newRegistry: ProviderRegistry): void {
    this.deps = { ...this.deps, providerRegistry: newRegistry };
  }

  /**
   * Late-bound from `server.ts` / `standalone.ts` once `PlatformClient` exists: orchestrator-core
   * can't pass it at construction because the platform client is created after the HTTP server
   * starts.
   */
  setOrgPublicAliasResolver(resolver: () => string | undefined): void {
    this.deps = { ...this.deps, getOrgPublicAlias: resolver };
  }

  /**
   * Create queued check runs for a workflow (kici/{workflow-name}) and each job
   * (kici/{workflow-name}/job/{job-name}) at trigger match time, before an agent picks up the job.
   * Fire-and-forget.
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
   * Awaitable setPending. The RunCoordinator uses it for rerouted jobs, whose check runs MUST
   * exist before dispatch for updates to work.
   */
  async setPendingAwait(opts: SetPendingOptions): Promise<void> {
    await this.doSetPending(opts);
  }

  /** Called when a job reaches a terminal state. Fire-and-forget. */
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
   * Called when ALL jobs in a workflow reach a terminal state; success ONLY if ALL jobs pass.
   * Fire-and-forget.
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
   * Complete the queued check runs of a workflow that never dispatched a job.
   *
   * `setPendingAwait` creates `kici/<workflow>` and one `kici/<workflow>/job/<name>` per static
   * job before the pipeline knows whether the workflow runs. When it ends without dispatching
   * (a hold rejected or expired, any pre-dispatch init failure), no job or run record carries
   * these names, so `updateJobStatus` / `updateWorkflowStatus` never fire, and
   * `doCleanupStaleCheckRuns` skips them (it only updates `in_progress` check runs). They would
   * stay `queued` — on a PR, a never-finishing check that blocks branch protection.
   *
   * Completes only check runs whose id resolves (L1 or the `check_run_tracking` row), skipping
   * keys already latched terminal.
   *
   * The build check `kici/<workflow>/setup` is deliberately excluded: the latch does not
   * reliably cover it. `setBuildComplete` stamps `terminal_sent_at` on the row but not the
   * in-process `terminalSent` set, and `resolveCheckRunId` returns on an L1 hit without reading
   * the row — so a just-completed build check resolves unlatched, and completing it again would
   * overwrite a real build conclusion. An unreadable row is harmless: no id, name skipped.
   */
  async completeUndispatchedCheckRuns(opts: CompleteUndispatchedCheckRunsOptions): Promise<void> {
    if (opts.provider !== 'github') {
      logger.debug('Check runs not supported for provider, skipping', { provider: opts.provider });
      return;
    }

    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!githubConfig || !opts.installationId) {
      logger.debug('GitHub config or installationId missing, skipping undispatched completion', {
        hasConfig: !!githubConfig,
        hasInstallationId: !!opts.installationId,
      });
      return;
    }

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);
    const label = this.workflowLabel(opts);
    const summary = this.appendTraceIds(opts.summary, traceIds);

    // Same names as `doSetPending`, via `workflowLabel`, so a cross-repository global run
    // addresses its own qualified check, not the acted-on repository's same-named one.
    const targets = [
      { name: `kici/${label}`, title: `KiCI: ${label}` },
      ...opts.jobNames.map((jobName) => ({
        name: `kici/${label}/job/${jobName}`,
        title: `KiCI: ${label}/${jobName}`,
      })),
    ];

    let completed = 0;
    for (const target of targets) {
      const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, target.name);
      const checkRunId = await this.resolveCheckRunId(key);
      if (!checkRunId) {
        logger.debug('Check run ID not found for undispatched completion, skipping', { key });
        continue;
      }
      if (this.terminalSent.has(key)) continue;
      // Latch before the PATCH, as `doUpdateJobStatus` does: a status arriving mid-completion
      // must not schedule an `in_progress` update behind it.
      this.terminalSent.add(key);
      await this.updateCheckRun(
        octokit,
        {
          owner: opts.owner,
          repo: opts.repo,
          check_run_id: checkRunId,
          status: 'completed',
          conclusion: opts.conclusion,
          completed_at: new Date().toISOString(),
          output: { title: target.title, summary },
          ...(detailsUrl && { details_url: detailsUrl }),
        },
        key,
        opts.runId,
      );
      completed++;
    }

    if (completed > 0) {
      logger.info('Completed check runs for a workflow that never dispatched', {
        owner: opts.owner,
        repo: opts.repo,
        sha: opts.sha,
        workflowName: opts.workflowName,
        conclusion: opts.conclusion,
        completed,
      });
    }
  }

  /**
   * Clean up stale check runs left by a dead orchestrator.
   *
   * Unlike updateJobStatus/updateWorkflowStatus (which rely on in-memory checkRunId), this lists
   * the commit's check runs via the GitHub API and matches the `kici/` prefix, so a replacement
   * orchestrator can clean up check runs it didn't create. Looks up each repo's installation via
   * the GitHub App, then completes stuck "in_progress" check runs as "timed_out".
   * Fire-and-forget.
   */
  cleanupStaleCheckRuns(opts: {
    provider: string;
    routingKey: string;
    owner: string;
    repo: string;
    sha: string;
    workflowName: string;
    /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
    workflowRepoIdentifier?: string;
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
   * Called each time a step starts, completes, or fails. The first 'running' step triggers an
   * immediate in_progress transition; later updates are debounced (5 seconds) to avoid API rate
   * limiting. Fire-and-forget.
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
   * Queue the build check run when a build job (dependency install and/or bundle compilation) is
   * dispatched — separate from execution check runs so users see build progress independently.
   * Name: kici/{workflowName}/setup, prefixed with the defining repository for a
   * cross-repository global run (see `workflowLabel`). Fire-and-forget.
   */
  setBuildPending(opts: SetBuildPendingOptions): void {
    const buildCheckName = `kici/${this.workflowLabel(opts)}/setup`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, buildCheckName);

    // Stamp the DB pending marker BEFORE the create, so a replacement coord taking over
    // mid-create avoids a duplicate `checks.create()` for the same SHA.
    runDetached(
      logger,
      'Build creation marker write',
      () => this.persistBuildCreationPending(key, opts.runId),
      { runId: opts.runId },
    );
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
    runDetached(
      logger,
      'Build creation tracking cleanup',
      () => creation.finally(() => this.pendingBuildCreations.delete(key)),
      { runId: opts.runId },
    );
  }

  /** Called when the build job finishes (success, failure, or cancellation). Fire-and-forget. */
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
   * Drop a run's in-memory state when the execution tracker prunes it.
   *
   * In-memory only: DB rows belong to the retention sweep in `queue/cleanup.ts`, which deletes
   * on inactivity age, not run completion. Deleting here would strand a late terminal PATCH,
   * which resolves its check-run ID by loading through to the row.
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
        this.terminalSent.delete(key);
        this.checkRunIds.delete(key);
        this.updateLocks.delete(key);
      }
      this.runIdToKeys.delete(runId);
    }
  }

  /**
   * Called once on coord become-leader (or any boot-time recovery); no-op without a store.
   *
   * Nothing is hydrated up front — the table can be large across many shas — so IDs load
   * through on demand in `resolveCheckRunId`. `runIdToKeys` is rebuilt only from this coord's
   * writes, so a run whose keys predate the switch leaves `cleanupRun` nothing to evict. That is
   * harmless: those L1 caches are equally empty on a fresh coord, and DB rows belong to the
   * retention sweep, not run prune.
   */
  async recoverState(): Promise<void> {
    if (!this.deps.trackingStore) return;
    logger.info('CheckRunReporter recovered (DB-backed state lookups enabled)');
  }

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
   * Inverse of `checkRunKey()`. Provider is always 'github': the reporter only writes GitHub
   * check runs.
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

  /** Write-through to L1 + store after a successful `checks.create()`. */
  private async persistCheckRunId(key: string, checkRunId: number, runId?: string): Promise<void> {
    this.checkRunIds.set(key, checkRunId);
    if (!this.deps.trackingStore) return;
    try {
      await this.deps.trackingStore.setCheckRunId(this.parseKey(key), checkRunId, runId);
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
   * Read-through: L1, then the store (cached on hit); undefined when neither has it — the caller
   * logs + skips.
   *
   * The same row also rehydrates the `terminalSent` latch. `cleanupRun` drops both L1 entries
   * together; reloading the id without the latch would let a late step-progress update PATCH
   * `status: in_progress` over the completion. `terminal_sent_at` is on the row already
   * selected, so this costs nothing.
   */
  private async resolveCheckRunId(key: string): Promise<number | undefined> {
    const cached = this.checkRunIds.get(key);
    if (cached !== undefined) return cached;
    if (!this.deps.trackingStore) return undefined;
    try {
      const state = await this.deps.trackingStore.getState(this.parseKey(key));
      if (state?.terminalSentAt) {
        this.terminalSent.add(key);
      }
      if (state?.checkRunId !== undefined) {
        this.checkRunIds.set(key, state.checkRunId);
      }
      return state?.checkRunId;
    } catch (err) {
      logger.warn('Failed to read check_run_tracking row; treating as miss', {
        key,
        error: toErrorMessage(err),
      });
      return undefined;
    }
  }

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

  /** Mark the first running-step transition as sent. */
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

  /** Stamp `build_creation_state = 'pending'`. */
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

  /** Via the CloneTokenProvider `getAppConfig()` (only GitHubCloneTokenProvider has it). */
  private resolveGithubConfig(routingKey?: string): GitHubAppConfig | undefined {
    if (routingKey && this.deps.providerRegistry) {
      const bundle = this.deps.providerRegistry.getByRoutingKey(routingKey);
      if (bundle) {
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
    return undefined;
  }

  /** Priority: explicit option value > AsyncLocalStorage context > 'N/A'. */
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

  private appendTraceIds(summary: string, traceIds: { requestId: string; runId: string }): string {
    return `${summary}\n\nTrace: ${traceIds.requestId} | Run: ${traceIds.runId}`;
  }

  private checkRunKey(owner: string, repo: string, sha: string, name: string): string {
    return `${owner}/${repo}/${sha}/${name}`;
  }

  /**
   * The workflow label every check-run name and title is built from.
   *
   * A check run's identity is `(owner, repo, sha, check name)` — on the provider, in
   * `check_run_tracking`'s primary key, and in the L1 keys — with no run id. Per-repository runs
   * cannot collide (one lock file cannot define a workflow name twice), but an
   * organization-wide workflow, defined in ANOTHER repository, can share a name with the
   * acted-on repository's workflow and resolve to one check run on the same commit. Its
   * conclusion would then complete the acted-on check — the signal branch protection reads —
   * with the wrong `details_url`, and `cleanupRun` would evict the other run's id and latch.
   *
   * Qualifying with the defining repository keeps them apart. The "differs from the acted-on
   * repository" narrowing lives here, not at call sites, so a per-repository run's name
   * (customer-visible, possibly a branch-protection required check) cannot move because a caller
   * passed the field where it did not apply.
   */
  private workflowLabel(opts: {
    owner: string;
    repo: string;
    workflowName: string;
    workflowRepoIdentifier?: string;
  }): string {
    const definedIn = opts.workflowRepoIdentifier;
    if (!definedIn || definedIn === `${opts.owner}/${opts.repo}`) return opts.workflowName;
    return `${definedIn}/${opts.workflowName}`;
  }

  /**
   * Dashboard public-alias link (`/r/orgs/<oal_xxx>/runs/<runId>`). Undefined when the
   * dashboard URL or alias is missing, or runId is the `'N/A'` sentinel from `resolveTraceIds`.
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

    const label = this.workflowLabel(opts);
    const workflowCheckName = `kici/${label}`;
    const workflowKey = this.checkRunKey(opts.owner, opts.repo, opts.sha, workflowCheckName);
    const result = await this.createCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      name: workflowCheckName,
      head_sha: opts.sha,
      status: 'queued',
      output: {
        title: `KiCI: ${label}`,
        summary: this.appendTraceIds('Waiting for agent...', traceIds),
      },
      ...(detailsUrl && { details_url: detailsUrl }),
    });

    if (result) {
      this.trackRunKey(opts.runId, workflowKey);
      await this.persistCheckRunId(workflowKey, result, opts.runId);
    }

    for (const jobName of opts.jobNames) {
      const jobCheckName = `kici/${label}/job/${jobName}`;
      const jobKey = this.checkRunKey(opts.owner, opts.repo, opts.sha, jobCheckName);
      const jobResult = await this.createCheckRun(octokit, {
        owner: opts.owner,
        repo: opts.repo,
        name: jobCheckName,
        head_sha: opts.sha,
        status: 'queued',
        output: {
          title: `KiCI: ${label}/${jobName}`,
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

    const label = this.workflowLabel(opts);
    const checkName = `kici/${label}/job/${opts.jobName}`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, checkName);
    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) {
      logger.warn('Check run ID not found for job update, skipping', { key });
      return;
    }

    // Completion takes priority over a pending debounce timer.
    const pendingTimer = this.progressTimers.get(key);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.progressTimers.delete(key);
    }

    // L1 only: the DB row is reaped by the inactivity-age retention sweep, not run cleanup.
    this.stepProgress.delete(key);
    this.inProgressSent.delete(key);
    // Latch terminal BEFORE the PATCH: a step status arriving mid-completion must not schedule
    // a progress update behind it.
    this.terminalSent.add(key);

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);

    let summary: string;
    let annotations: CheckAnnotation[] | undefined;

    // Resolved before the summary so the note's bytes come out of the summary's budget, not on
    // top of it. `\n\n` is the separator below.
    const postureNote = buildReducedPrivilegeNote(opts.trustTier, opts.lockFileSource);
    const reservedBytes = postureNote ? Buffer.byteLength(`${postureNote}\n\n`, 'utf-8') : 0;

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
      const stepResults = opts.data.stepResults as StepResultData[];

      summary = buildCheckRunSummary({
        jobName: opts.jobName,
        stepResults,
        logBuffer: this.deps.stepLogBuffer,
        runId: opts.runIdForLogs,
        jobId: opts.jobId,
        traceIds,
        jobDurationMs: opts.data.durationMs as number | undefined,
        reservedBytes,
      });

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
      const stepResults = opts.data.stepResults as StepResultData[];

      summary = buildCheckRunSummary({
        jobName: opts.jobName,
        stepResults,
        logBuffer: this.deps.stepLogBuffer ?? ({ getLastLines: () => undefined } as any),
        runId: opts.runIdForLogs ?? '',
        jobId: opts.jobId ?? '',
        traceIds,
        jobDurationMs: opts.data.durationMs as number | undefined,
        reservedBytes,
      });
    } else {
      const { description } = this.mapJobConclusion(opts.state, opts.description);
      summary = this.appendTraceIds(description, traceIds);
    }

    // On a fork PR the trust policy let run, this check and the workflow roll-up are the only
    // two the contributor gets; the job fails on a dependency the run was never given, and
    // nothing else says so. This one carries the failing step, so the note leads it.
    if (postureNote) summary = `${postureNote}\n\n${summary}`;

    // The annotation-count line is appended after the summary's budget was spent, so the total
    // can still exceed the API cap despite `reservedBytes`. A rejected update leaves the check
    // run unresolved, which is worse than a truncated one.
    summary = clampSummaryToLimit(summary);

    const { conclusion } = this.mapJobConclusion(opts.state, opts.description);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(
      octokit,
      {
        owner: opts.owner,
        repo: opts.repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: `KiCI: ${label}/${opts.jobName}`,
          summary,
          annotations,
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      },
      key,
      opts.runId,
    );
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

    const label = this.workflowLabel(opts);
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, `kici/${label}`);
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
    // Same note as the per-job check, with no byte budgeting: a one-line conclusion plus trace
    // footer is orders of magnitude under the cap `doUpdateJobStatus` manages.
    const postureNote = buildReducedPrivilegeNote(opts.trustTier, opts.lockFileSource);
    const rollup = this.appendTraceIds(description, traceIds);

    await this.updateCheckRun(
      octokit,
      {
        owner: opts.owner,
        repo: opts.repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: `KiCI: ${label}`,
          summary: postureNote ? `${postureNote}\n\n${rollup}` : rollup,
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      },
      key,
      opts.runId,
    );
  }

  private async doCleanupStaleCheckRuns(opts: {
    provider: string;
    routingKey: string;
    owner: string;
    repo: string;
    sha: string;
    workflowName: string;
    /** See {@link SetPendingOptions.workflowRepoIdentifier}. */
    workflowRepoIdentifier?: string;
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

    // Expected names via `workflowLabel`. `stale.checkrun.cleanup` from the Platform carries the
    // defining repository for a cross-repository global run, so these match what that run
    // created and cannot reach the acted-on repository's same-named check. The Platform sends
    // the field only when the repositories differ, so absent and equal-to-acted-on are one case,
    // both mapped to the unqualified name.
    const label = this.workflowLabel(opts);
    const expectedNames = new Set<string>();
    expectedNames.add(`kici/${label}`);
    expectedNames.add(`kici/${label}/setup`);
    for (const jobName of opts.jobNames) {
      expectedNames.add(`kici/${label}/job/${jobName}`);
    }

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

    const label = this.workflowLabel(opts);
    const checkName = `kici/${label}/job/${opts.jobName}`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, checkName);
    // Progress after the job is reported would reopen a resolved check run — see `terminalSent`.
    if (this.terminalSent.has(key)) return;
    const checkRunId = await this.resolveCheckRunId(key);
    if (!checkRunId) return;
    // Re-checked: the resolve rehydrates the latch from `check_run_tracking`, and after
    // `cleanupRun` only the row remembers the terminal state.
    if (this.terminalSent.has(key)) return;

    this.trackRunKey(opts.runId, key);

    let steps = this.stepProgress.get(key);
    if (!steps) {
      steps = [];
      this.stepProgress.set(key, steps);
    }

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

    // A write failure logs but doesn't block the GitHub update — the in-memory copy stays
    // correct for this orchestrator's lifetime.
    await this.persistStepProgress(key, steps, opts.runId);

    // First step going to 'running': immediate in_progress transition.
    if (opts.state === ExecutionStepStatus.enum.running && !this.inProgressSent.get(key)) {
      await this.persistInProgressSent(key, opts.runId);

      const octokit = createInstallationOctokit(githubConfig, opts.installationId);
      const traceIds = this.resolveTraceIds(opts);
      const progressText = buildProgressText({ steps, traceIds });
      const detailsUrl = this.buildDetailsUrl(traceIds.runId);

      await this.updateCheckRun(
        octokit,
        {
          owner: opts.owner,
          repo: opts.repo,
          check_run_id: checkRunId,
          status: 'in_progress',
          output: {
            title: `KiCI: ${label}/${opts.jobName}`,
            summary: progressText,
          },
          ...(detailsUrl && { details_url: detailsUrl }),
        },
        key,
        opts.runId,
      );
      return;
    }

    // Later updates debounce; a pending timer picks up the latest state when it fires.
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
  }

  private async flushProgress(
    key: string,
    opts: {
      provider: string;
      owner: string;
      repo: string;
      sha: string;
      workflowName: string;
      /** See `workflowLabel` — carried so a flush names the same check run. */
      workflowRepoIdentifier?: string;
      jobName: string;
      installationId?: number;
      routingKey?: string;
      requestId?: string;
      runId?: string;
    },
  ): Promise<void> {
    // A timer that outlived the job's completion would PATCH `status: in_progress` over a
    // resolved check run — see `terminalSent`.
    if (this.terminalSent.has(key)) return;
    const checkRunId = await this.resolveCheckRunId(key);
    const githubConfig = this.resolveGithubConfig(opts.routingKey);
    if (!checkRunId || !githubConfig || !opts.installationId) return;
    // Re-checked: the resolve rehydrates the latch — see `resolveCheckRunId`.
    if (this.terminalSent.has(key)) return;

    const steps = this.stepProgress.get(key);
    if (!steps) return;

    const octokit = createInstallationOctokit(githubConfig, opts.installationId);
    const traceIds = this.resolveTraceIds(opts);
    const progressText = buildProgressText({ steps, traceIds });
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    await this.updateCheckRun(
      octokit,
      {
        owner: opts.owner,
        repo: opts.repo,
        check_run_id: checkRunId,
        status: 'in_progress',
        output: {
          title: `KiCI: ${this.workflowLabel(opts)}/${opts.jobName}`,
          summary: progressText,
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      },
      key,
      opts.runId,
    );
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
    const label = this.workflowLabel(opts);
    const buildCheckName = `kici/${label}/setup`;
    const traceIds = this.resolveTraceIds(opts);
    const detailsUrl = this.buildDetailsUrl(traceIds.runId);

    const result = await this.createCheckRun(octokit, {
      owner: opts.owner,
      repo: opts.repo,
      name: buildCheckName,
      head_sha: opts.sha,
      status: 'queued',
      output: {
        title: `KiCI: ${label}/setup`,
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

    const label = this.workflowLabel(opts);
    const buildCheckName = `kici/${label}/setup`;
    const key = this.checkRunKey(opts.owner, opts.repo, opts.sha, buildCheckName);

    // Wait for an in-flight setBuildPending before looking up the ID.
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

    await this.updateCheckRun(
      octokit,
      {
        owner: opts.owner,
        repo: opts.repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: `KiCI: ${label}/setup`,
          summary: this.appendTraceIds(description, traceIds),
        },
        ...(detailsUrl && { details_url: detailsUrl }),
      },
      key,
      opts.runId,
    );
  }

  private mapBuildConclusion(
    status: TerminalJobStatus,
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
      case ExecutionJobStatus.enum.skipped:
        // `CheckRunConclusion` has no `skipped` member, and adding one changes a provider
        // vocabulary with its own consumers. `cancelled` is the closest "did not run" outcome
        // and, like GitHub's skipped, does not block a branch; `success` would be a lie.
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Build skipped',
        };
      case ExecutionJobStatus.enum.drift_dropped:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ??
            'Build dropped -- determinism drift detected during re-evaluation on the agent.',
        };
      case ExecutionJobStatus.enum.unroutable:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ?? 'Build could not be routed -- its runsOn matched no agent.',
        };
      default: {
        // Unreachable while `status` is a `TerminalJobStatus` (an `Exclude<>` of non-terminal
        // statuses): a new engine status widens it and the `never` below fails to compile. The
        // runtime arm lets an untyped caller degrade the check run rather than crash it.
        const unexpected: never = status;
        logger.warn('Unexpected terminal job status mapping a build conclusion', {
          status: unexpected as unknown as string,
        });
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'Build finished with an unrecognised status',
        };
      }
    }
  }

  private mapJobConclusion(
    state: TerminalJobStatus,
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
      case ExecutionJobStatus.enum.skipped:
        // `CheckRunConclusion` has no `skipped` member; `cancelled` is the
        // closest available "did not run" outcome and does not block a branch.
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Job skipped',
        };
      case ExecutionJobStatus.enum.drift_dropped:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ??
            'Job dropped -- determinism drift detected during re-evaluation on the agent.',
        };
      case ExecutionJobStatus.enum.unroutable:
        // A job that could not run must not satisfy a required check, so this
        // is a `failure` rather than the `cancelled` used for `skipped`.
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ?? 'Job could not be routed -- its runsOn matched no agent.',
        };
      default: {
        // Exhaustiveness guard + untyped-caller fallback — see `mapBuildConclusion`.
        const unexpected: never = state;
        logger.warn('Unexpected terminal job status mapping a job conclusion', {
          status: unexpected as unknown as string,
        });
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'Job finished with an unrecognised status',
        };
      }
    }
  }

  private mapWorkflowConclusion(
    status: TerminalJobStatus,
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
      case ExecutionJobStatus.enum.skipped:
        // `CheckRunConclusion` has no `skipped` member; `cancelled` is the
        // closest available "did not run" outcome and does not block a branch.
        return {
          conclusion: CheckRunConclusion.enum.cancelled,
          description: customDescription ?? 'Workflow skipped',
        };
      case ExecutionJobStatus.enum.drift_dropped:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ??
            'One or more jobs were dropped -- determinism drift detected during re-evaluation.',
        };
      case ExecutionJobStatus.enum.unroutable:
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description:
            customDescription ??
            'One or more jobs could not be routed -- their runsOn matched no agent.',
        };
      default: {
        // Exhaustiveness guard + untyped-caller fallback — see `mapBuildConclusion`.
        const unexpected: never = status;
        logger.warn('Unexpected terminal job status mapping a workflow conclusion', {
          status: unexpected as unknown as string,
        });
        return {
          conclusion: CheckRunConclusion.enum.failure,
          description: customDescription ?? 'Workflow finished with an unrecognised status',
        };
      }
    }
  }

  /** Returns the check run ID, or undefined on failure. */
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
       * "Details" link, from `buildDetailsUrl` with the public org alias — the canonical
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
      details_url?: string;
    },
    trackingKey?: string,
    trackingRunId?: string,
  ): Promise<void> {
    // Serialize PATCHes per check run — see `updateLocks`. Keyed on the tracking key when present
    // (workflow- and job-level checks have distinct keys, so they do not block each other), else
    // on the check-run id.
    const lockKey = trackingKey ?? `checkrun:${params.check_run_id}`;
    return this.runUpdateExclusive(lockKey, () =>
      this.updateCheckRunLocked(octokit, params, trackingKey, trackingRunId),
    );
  }

  private async updateCheckRunLocked(
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
      /** Same alias-based "Details" link as `createCheckRun`. */
      details_url?: string;
    },
    /**
     * Row stamped `terminal_sent_at` once the provider accepts a `completed` update. Optional
     * only so a keyless caller compiles; every call site passes it, so a terminal update cannot
     * skip the marker without skipping the PATCH.
     *
     * `doCleanupStaleCheckRuns` deliberately bypasses this method: its `timed_out` PATCHes on
     * check runs a dead orchestrator abandoned are not results this pipeline sent, so they stay
     * unstamped and the column keeps meaning "the pipeline reported a result".
     */
    trackingKey?: string,
    /**
     * Threaded like `markInProgressSent` / `markBuildCreationPending` / `setStepProgress`. The
     * stamp is an upsert, so on the cache-only fallback (`persistCheckRunId` swallowed a DB
     * error, L1 holds the id) it can INSERT the row — without `run_id`, `listKeysByRunId` cannot
     * see it and nothing tells an operator which run posted it.
     */
    trackingRunId?: string,
  ): Promise<void> {
    // Final latch re-check, as close to the PATCH as possible. `doUpdateStepProgress` /
    // `flushProgress` check `terminalSent` before their awaits, but the job can complete in
    // that window (`doUpdateJobStatus` latches synchronously, then PATCHes `completed`). An
    // `in_progress` PATCH landing after it would reopen the check run — GitHub keeps the
    // terminal `conclusion` but flips `status` back, the permanently-unresolved state. A
    // `completed` write is the terminal itself and always proceeds.
    if (params.status === 'in_progress' && trackingKey && this.terminalSent.has(trackingKey)) {
      return;
    }
    let patchAccepted = false;
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
      patchAccepted = true;

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

    // Stamp only a terminal update the provider accepted; stamping a thrown or `in_progress`
    // update would make the column lie, and not lying is its only value. Best-effort like every
    // write on this table: a tracking failure must not turn an accepted update into an error.
    if (patchAccepted && params.status === 'completed' && trackingKey && this.deps.trackingStore) {
      try {
        await this.deps.trackingStore.markTerminalSent(this.parseKey(trackingKey), trackingRunId);
      } catch (err) {
        logger.warn('Failed to stamp terminal_sent_at; continuing', {
          key: trackingKey,
          error: toErrorMessage(err),
        });
      }
    }
  }
}

/**
 * Failure description from agent job status data: the first failed step in `stepResults`,
 * else `data.error`, else a generic "Job failed".
 */
export function buildJobFailureDescription(data: Record<string, unknown>): string {
  if (Array.isArray(data.stepResults)) {
    const failedStep = data.stepResults.find(
      (s: Record<string, unknown>) => s.status === ExecutionStepStatus.enum.failed,
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

  if (data.error) {
    return `Job error: ${data.error}`;
  }

  return 'Job failed';
}
