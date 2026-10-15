import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { CheckRunTrackingStore } from '../reporting/check-run-tracking-store.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import type { LogStorage } from '../reporting/log-storage.js';
import { pruneExpiredLogs } from '../reporting/log-retention.js';
import { pruneRequestIdempotency } from '../pipeline/request-idempotency.js';
import {
  checkRunTrackingRowsPrunedTotal,
  dispatchQueueRowsPrunedTotal,
  stepLogsPrunedTotal,
} from '../metrics/prometheus.js';
import { JobQueue } from './job-queue.js';
import {
  type CanRouteLabels,
  type TerminalizeDeps,
  terminalizeUnroutableJob,
} from './terminalize-unroutable.js';
import {
  pruneExpiredHistorySafely,
  resolveRetentionWindows,
  type RetentionWindows,
} from './retention.js';

const logger = createLogger({ prefix: 'cleanup' });

/**
 * Optional cleanup dependencies + retention knobs. Present in platform/hybrid
 * mode (the only wiring site, `orchestrator-core`, always supplies them); the
 * retention sweeps and Platform status-forwarding run only when this is set.
 */
export interface CleanupExtras {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  /**
   * Resolves each expired job's check run to a terminal conclusion. Required for
   * correctness: this sweep writes `execution_jobs` directly, not through
   * `ExecutionTracker.onJobStatus`, so the tracker's terminal-job hook to the
   * check-run reporter never fires. Absent, the check run stays `queued` on the
   * commit forever, and no branch-protection rule requiring it is ever satisfied.
   */
  checkRunReporter?: Pick<CheckRunReporter, 'updateJobStatus'>;
  /** Terminal dispatch_queue row retention (days); 0 disables. Default 30. */
  dispatchQueueTtlDays?: number;
  /** Step-log object retention (days); 0 disables. Default 90. */
  stepLogTtlDays?: number;
  /** Store for `check_run_tracking`; the retention sweep runs only when wired. */
  checkRunTrackingStore?: CheckRunTrackingStore;
  /** Database-side retention windows, in days. Absent leaves the history sweep off. */
  retentionWindows?: RetentionWindows;
  /**
   * True when the cold store is configured: its archivers own the tables they
   * register and the history sweep leaves those alone — one owner per table.
   */
  coldStoreEnabled?: boolean;
  /** Live cluster-settings reader; absent ⇒ the config default is used as-is. */
  clusterSettings?: ClusterSettingsReader;
  /** `check_run_tracking` row retention (days); 0 disables. Default 7. */
  checkRunTrackingTtlDays?: number;
  /** The orchestrator's log storage — the S3 sweep runs only when S3-backed. */
  logStorage?: LogStorage;
  /** True when `logStorage` is the S3 backend (the filesystem backend is
   *  customer-managed, so its lifecycle stays the operator's concern). */
  logStorageIsS3?: boolean;
  /**
   * Whether ANYTHING could ever have run a job with these selectors — a
   * registered agent (regardless of capacity) or a scaler backend able to spawn one.
   *
   * Splits why a queued job never ran: nothing matched its `runsOn`
   * (`unroutable` — a label/fleet problem for the operator) versus something
   * matched but never produced a usable agent (`timed_out_stale` — capacity or
   * provisioning). Both halves are load-bearing: a scaler pool at zero has no
   * registered agent yet routes fine, so asking only the agent registry would
   * report every failed spawn as a bad `runsOn`.
   *
   * Asked on the unroutable probe's short tick (a grace window absorbs a label an
   * autoscaled agent satisfies moments later) and again at expiry, the backstop
   * when fast-fail is disabled. Absent → every expiry stays `timed_out_stale`.
   *
   * It may answer "routable" conservatively (the scaler half matches exact labels
   * only, so a pattern-only `runsOn` reads routable on a scaler-configured
   * orchestrator). That costs status precision, never safety: the job is terminal
   * and the run fails either way.
   */
  canRouteLabels?: CanRouteLabels;
  /**
   * The Tier-2 global-eval tracker, forwarded to
   * {@link terminalizeUnroutableJob} so a round job this sweep settles also
   * settles the webhook request awaiting its verdict.
   */
  pendingGlobalEvals?: TerminalizeDeps['pendingGlobalEvals'];
}

/**
 * One cleanup pass: remove expired dedup_cache entries and mark expired
 * dispatch_queue entries. With `extras`, expired jobs are also forwarded to the
 * Platform as terminal status so its execution_jobs projection stays in sync.
 *
 * Event-log retention is not here: event_log rows are archived to cold-store and
 * then deleted (see `packages/orchestrator/src/cold-store/tables/event-log.ts`).
 */
export async function runCleanup(
  dedup: { cleanup(): Promise<number> },
  queue: JobQueue,
  extras?: CleanupExtras,
): Promise<{
  dedupDeleted: number;
  queueExpired: number;
  dispatchRowsPruned: number;
  logObjectsPruned: number;
  checkRunRowsPruned: number;
  historyRowsPruned: number;
}> {
  // Also trims the in-memory dedup cache.
  const dedupDeleted = await dedup.cleanup();

  const expiredJobs = await queue.markExpired();
  const queueExpired = expiredJobs.length;

  let dispatchRowsPruned = 0;
  let logObjectsPruned = 0;
  let checkRunRowsPruned = 0;
  let historyRowsPruned = 0;

  // Request idempotency claims older than 1h: the request budget is ~10s, so a
  // claimed requestId is never re-sent after an hour.
  if (extras) {
    try {
      const pruned = await pruneRequestIdempotency(extras.db);
      if (pruned > 0) logger.info('Pruned stale request idempotency claims', { pruned });
    } catch (err) {
      logger.error('Failed to prune request idempotency claims', { error: toErrorMessage(err) });
    }

    // Only completed/failed/expired rows past the window go — an active run
    // keeps all of its rows.
    const ttlDays = extras.dispatchQueueTtlDays ?? 30;
    try {
      dispatchRowsPruned = await queue.pruneTerminalDispatchRows(ttlDays);
      if (dispatchRowsPruned > 0) {
        dispatchQueueRowsPrunedTotal.add(dispatchRowsPruned);
        logger.info('Pruned terminal dispatch_queue rows', { dispatchRowsPruned, ttlDays });
      }
    } catch (err) {
      logger.error('Failed to prune terminal dispatch_queue rows', {
        error: toErrorMessage(err),
      });
    }

    // Nothing dispatches a terminal row again, so its sealed secrets have no reader.
    try {
      const scrubbed = await queue.scrubTerminalSealedSecrets();
      if (scrubbed > 0)
        logger.info('Scrubbed sealed secrets of terminal dispatch_queue rows', { scrubbed });
    } catch (err) {
      logger.error('Failed to scrub sealed secrets of terminal dispatch_queue rows', {
        error: toErrorMessage(err),
      });
    }

    // S3 backend only; the filesystem backend's lifecycle is customer-managed.
    if (extras.logStorage && extras.logStorageIsS3) {
      try {
        logObjectsPruned = await pruneExpiredLogs(extras.logStorage, extras.stepLogTtlDays ?? 90);
        if (logObjectsPruned > 0) {
          stepLogsPrunedTotal.add(logObjectsPruned);
          logger.info('Pruned expired step-log objects', { logObjectsPruned });
        }
      } catch (err) {
        logger.error('Failed to prune expired step-log objects', {
          error: toErrorMessage(err),
        });
      }
    }

    // check_run_tracking is pruned by age, not run completion: every upsert bumps
    // `updated_at`, so a run still emitting check-run traffic keeps its rows and
    // a late status update can still resolve its check-run ID. Age tracks
    // check-run writes, not run liveness; `pruneStale` documents the cost.
    if (extras.checkRunTrackingStore) {
      const checkRunTtlDefault = extras.checkRunTrackingTtlDays ?? 7;
      try {
        // A genuine 0 disables the sweep, so this stays null-coalescing, never `||`.
        const ttlDays = extras.clusterSettings
          ? await extras.clusterSettings.getNumber(
              'check_run_tracking_ttl_days',
              checkRunTtlDefault,
            )
          : checkRunTtlDefault;
        checkRunRowsPruned = await extras.checkRunTrackingStore.pruneStale(ttlDays);
        if (checkRunRowsPruned > 0) {
          checkRunTrackingRowsPrunedTotal.add(checkRunRowsPruned);
          logger.info('Pruned stale check-run-tracking rows', { checkRunRowsPruned, ttlDays });
        }
      } catch (err) {
        logger.error('Failed to prune stale check-run-tracking rows', {
          error: toErrorMessage(err),
        });
      }
    }

    // Run history, audit logs, provenance and terminal held-runs, pruned in the
    // database: the tier for an install with no object store. With the cold
    // store on, its archivers keep sole ownership of the tables they register.
    if (extras.retentionWindows) {
      // A live cluster_settings value wins over the default; a genuine 0
      // disables a window, so each read stays null-coalescing, never `||`.
      const windows = await resolveRetentionWindows(
        extras.retentionWindows,
        extras.clusterSettings,
      );
      const summary = await pruneExpiredHistorySafely({
        db: extras.db,
        windows,
        coldStoreEnabled: extras.coldStoreEnabled ?? false,
      });
      historyRowsPruned = Object.values(summary.deleted).reduce((a, b) => a + b, 0);
    }
  }

  if (extras && expiredJobs.length > 0) {
    const affectedRunIds = new Set<string>();

    for (const job of expiredJobs) {
      const runId = await terminalizeUnroutableJob(
        {
          db: extras.db,
          executionTracker: extras.executionTracker,
          checkRunReporter: extras.checkRunReporter,
          canRouteLabels: extras.canRouteLabels,
          pendingGlobalEvals: extras.pendingGlobalEvals,
        },
        job,
      );
      if (runId) affectedRunIds.add(runId);
    }

    for (const runId of affectedRunIds) {
      try {
        await extras.executionTracker.completeRunIfAllJobsTerminal(runId);
      } catch (err) {
        logger.error('Error checking run completion after queue expiry', {
          runId,
          error: toErrorMessage(err),
        });
      }
    }
  }

  if (
    dedupDeleted > 0 ||
    queueExpired > 0 ||
    dispatchRowsPruned > 0 ||
    logObjectsPruned > 0 ||
    checkRunRowsPruned > 0
  ) {
    logger.info('Cleanup completed', {
      dedupDeleted,
      queueExpired,
      dispatchRowsPruned,
      logObjectsPruned,
      checkRunRowsPruned,
    });
  } else {
    logger.debug('Cleanup completed, nothing to clean');
  }

  return {
    dedupDeleted,
    queueExpired,
    dispatchRowsPruned,
    logObjectsPruned,
    checkRunRowsPruned,
    historyRowsPruned,
  };
}

/**
 * Per-tick handler for the queue-cleanup scheduled job; the cadence and periodic
 * wrapper live in `packages/orchestrator/src/queue/scheduled-job.ts`.
 */
export function createCleanupHandler(
  dedup: { cleanup(): Promise<number> },
  queue: JobQueue,
  extras?: CleanupExtras,
): () => Promise<void> {
  return async () => {
    await runCleanup(dedup, queue, extras);
  };
}
