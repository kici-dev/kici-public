import { type Kysely, sql } from 'kysely';
import { ExecutionJobStatus, type LabelMatcher } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { CheckRunTrackingStore } from '../reporting/check-run-tracking-store.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import { reportJobCheckRunCompletion } from '../reporting/job-check-run-completion.js';
import type { LogStorage } from '../reporting/log-storage.js';
import { pruneExpiredLogs } from '../reporting/log-retention.js';
import { pruneRequestIdempotency } from '../pipeline/request-idempotency.js';
import {
  checkRunTrackingRowsPrunedTotal,
  dispatchQueueRowsPrunedTotal,
  stepLogsPrunedTotal,
} from '../metrics/prometheus.js';
import { type ExpiredJobInfo, JobQueue } from './job-queue.js';

const logger = createLogger({ prefix: 'cleanup' });

/**
 * The operator-facing reason an expired job is `unroutable`, naming the exact
 * selectors that went unmatched. Regex matchers are rendered as their source so
 * the message stays readable rather than printing `[object Object]`.
 */
function renderMatcher(m: LabelMatcher): string {
  return m.kind === 'exact' ? m.value : `/${m.source}/${m.flags}`;
}

function unroutableMessage(job: ExpiredJobInfo): string {
  const required = [...job.runsOnLabels, ...job.runsOnPatterns.map(renderMatcher)];
  const excluded = [...job.excludeLabels, ...job.excludePatterns.map(renderMatcher)];
  // `currently`, and both halves of the probe, because the same verdict covers a
  // fleet that is merely empty right now — a lone static agent that dropped off
  // for the whole window reaches this line too, and a message asserting the
  // labels are wrong would send its operator chasing a correct `runsOn`.
  const selector =
    required.length > 0
      ? `runsOn [${required.join(', ')}]`
      : 'this job (it declares no runsOn, so any agent would do)';
  const parts = [selector];
  if (excluded.length > 0) parts.push(`excluding [${excluded.join(', ')}]`);
  return `No connected agent or scaler backend currently matches ${parts.join(' ')} — the job was never dispatched`;
}

/**
 * Optional cleanup dependencies + retention knobs. Present in platform/hybrid
 * mode (the only wiring site, `orchestrator-core`, always supplies them); the
 * retention sweeps and Platform status-forwarding run only when this is set.
 */
export interface CleanupExtras {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  /**
   * Resolves each expired job's check run to a terminal conclusion.
   *
   * Required for correctness, not decoration: this sweep settles a job by
   * writing `execution_jobs` directly rather than through
   * `ExecutionTracker.onJobStatus`, so the tracker's terminal-job hook — the
   * funnel a tracker-driven terminal status reaches the check-run reporter
   * through — never fires here. Absent, the check run created at trigger match
   * stays `queued` on the commit forever, which no branch-protection rule
   * requiring it can ever be satisfied by.
   */
  checkRunReporter?: Pick<CheckRunReporter, 'updateJobStatus'>;
  /** Terminal dispatch_queue row retention (days); 0 disables. Default 30. */
  dispatchQueueTtlDays?: number;
  /** Step-log object retention (days); 0 disables. Default 90. */
  stepLogTtlDays?: number;
  /** Store for `check_run_tracking`; the retention sweep runs only when wired. */
  checkRunTrackingStore?: CheckRunTrackingStore;
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
   * registered agent (regardless of capacity) or a scaler backend able to spawn
   * one.
   *
   * Read once per expired job to split the two reasons a queued job never ran:
   * nothing in the fleet matched its `runsOn` (`unroutable` — a label/fleet
   * problem an operator has to fix) versus something matched but never produced
   * a usable agent (`timed_out_stale` — a capacity or provisioning problem).
   * Both halves are load-bearing: a scaler-managed pool at zero has no
   * registered agent yet still routes perfectly well, so asking only the agent
   * registry would report every failed spawn as a bad `runsOn`.
   *
   * Asked at expiry rather than at dispatch so a label satisfied moments later
   * by an autoscaled agent is not mislabelled unroutable. Absent → every expiry
   * stays `timed_out_stale`, the behaviour before the split existed.
   *
   * The predicate is allowed to answer "routable" conservatively (the scaler
   * half matches exact labels only, so a pattern-only `runsOn` reads routable on
   * a scaler-configured orchestrator). That costs precision on the status, never
   * safety: the job is terminal either way and the run fails either way.
   */
  canRouteLabels?: (
    requiredLabels: string[],
    requiredPatterns: LabelMatcher[],
    excludeLabels: string[],
    excludePatterns: LabelMatcher[],
  ) => boolean;
}

/**
 * Run a single cleanup pass: remove expired dedup_cache entries and
 * mark expired dispatch_queue entries.
 *
 * When `extras` is provided, expired jobs are also forwarded to Platform
 * as terminal status updates so the Platform execution_jobs projection
 * stays in sync.
 *
 * Event-log row + payload retention used to live here too, but Phase E
 * replaced the 30-day hard-delete with cold-store archive-then-delete
 * (see `packages/orchestrator/src/cold-store/tables/event-log.ts`).
 *
 * @returns Counts of cleaned entries.
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
}> {
  // 1. Delete expired dedup_cache entries (also trims in-memory cache)
  const dedupDeleted = await dedup.cleanup();

  // 2. Mark expired dispatch_queue entries and get details
  const expiredJobs = await queue.markExpired();
  const queueExpired = expiredJobs.length;

  let dispatchRowsPruned = 0;
  let logObjectsPruned = 0;
  let checkRunRowsPruned = 0;

  // 2b. Prune stale request idempotency claims (>1h; the request budget is
  // ~10s, so a claimed requestId is never re-sent after an hour).
  if (extras) {
    try {
      const pruned = await pruneRequestIdempotency(extras.db);
      if (pruned > 0) logger.info('Pruned stale request idempotency claims', { pruned });
    } catch (err) {
      logger.error('Failed to prune request idempotency claims', { error: toErrorMessage(err) });
    }

    // 2c. Prune terminal dispatch_queue rows past the retention window. Only
    // completed/failed/expired rows older than the window go — a still-active
    // run keeps all of its rows.
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

    // 2d. Prune expired step-log objects (S3 backend only; the filesystem
    // backend's lifecycle is customer-managed).
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

    // 2e. Prune stale check_run_tracking rows. Age-based rather than keyed to
    // run completion: every upsert bumps `updated_at`, so a run still emitting
    // check-run traffic keeps its rows fresh, and a late check-run status
    // update can still resolve its check-run ID from the row. Age is measured
    // on check-run writes rather than on run liveness; `pruneStale` documents
    // what that costs.
    if (extras.checkRunTrackingStore) {
      const checkRunTtlDefault = extras.checkRunTrackingTtlDays ?? 7;
      try {
        // `getNumber` returns a genuine 0 when the operator set the knob to 0,
        // which is the documented way to disable the sweep — so this must stay
        // a null-coalescing read, never `||`.
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
  }

  // 3. Forward terminal status to Platform for each expired job
  if (extras && expiredJobs.length > 0) {
    const affectedRunIds = new Set<string>();
    const genericMessage = 'Queue timeout expired (job was never dispatched to an agent)';

    for (const job of expiredJobs) {
      // A job nothing in the fleet could ever have run — no agent, no scaler
      // backend — is `unroutable`, not a capacity timeout. Naming the
      // unsatisfied `runsOn` is the whole point: a typo or a retired label lands
      // here and the message has to say which selectors went unmatched. Without
      // the probe wired in, every expiry keeps its historical `timed_out_stale`.
      //
      // A recorded provisioning error settles it on its own: the scaler got far
      // enough to attempt (and fail) a spawn, so the labels DID route and the
      // real cause is that failure. Calling that unroutable would send an
      // operator to fix a `runsOn` that is already correct.
      const unroutable =
        job.lastProvisioningError === null &&
        extras.canRouteLabels !== undefined &&
        !extras.canRouteLabels(
          job.runsOnLabels,
          job.runsOnPatterns,
          job.excludeLabels,
          job.excludePatterns,
        );
      const status = unroutable
        ? ExecutionJobStatus.enum.unroutable
        : ExecutionJobStatus.enum.timed_out_stale;
      // An unroutable job has no provisioning error by construction (see the
      // guard above), so the two branches never contend.
      const errorMessage = unroutable
        ? unroutableMessage(job)
        : (job.lastProvisioningError ?? genericMessage);
      try {
        // Update the orchestrator's local execution_jobs row
        const ejResult = await extras.db
          .updateTable('execution_jobs')
          .set({
            status,
            completed_at: new Date(),
            error_message: errorMessage,
          })
          .where('run_id', '=', sql<string>`${job.runId}::uuid`)
          .where('job_name', '=', job.jobName)
          .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
          .executeTakeFirst();

        if (ejResult.numUpdatedRows && ejResult.numUpdatedRows > 0n) {
          // Surface the provisioning error as the run-level failure reason so
          // `kici status`, `kici-admin runs show`, and the dashboard banner
          // show the real cause. Only set it when no real step-failure reason
          // has been recorded yet — never clobber an existing reason.
          // An unroutable job's message carries the same weight: it is the only
          // statement of WHICH selectors went unmatched, and a run whose reason
          // stayed NULL would render the generic `Failed jobs: <name>` roll-up
          // on every surface the comment above names.
          const runReason = unroutable ? errorMessage : job.lastProvisioningError;
          if (runReason) {
            await extras.db
              .updateTable('execution_runs')
              .set({ failure_reason: runReason })
              .where('run_id', '=', sql<string>`${job.runId}::uuid`)
              .where('failure_reason', 'is', null)
              .execute();
          }

          // Look up the job_id (dispatch_queue.id ≠ execution_jobs.job_id)
          const ejRow = await extras.db
            .selectFrom('execution_jobs')
            .select(['job_id'])
            .where('run_id', '=', sql<string>`${job.runId}::uuid`)
            .where('job_name', '=', job.jobName)
            .executeTakeFirst();

          if (ejRow) {
            extras.executionTracker.updateInMemoryJob(job.runId, ejRow.job_id, status);

            extras.executionTracker.forwardJobTerminalStatus(
              job.runId,
              ejRow.job_id,
              job.jobName,
              status,
              errorMessage,
            );

            extras.executionTracker.emitInfraEvent(job.runId, 'orchestrator.job.queue_expired', {
              jobId: ejRow.job_id,
              metadata: { jobName: job.jobName, reason: errorMessage },
            });

            // Resolve the job's check run — see `CleanupExtras.checkRunReporter`
            // for why this path has to post it itself. `errorMessage` is passed
            // as the description because it is the only text naming the
            // unmatched `runsOn` selectors (or the provisioning failure).
            if (extras.checkRunReporter) {
              reportJobCheckRunCompletion(
                {
                  checkRunReporter: extras.checkRunReporter,
                  getExecutionContext: (runId) =>
                    extras.executionTracker.getExecutionContext(runId),
                },
                {
                  runId: job.runId,
                  jobId: ejRow.job_id,
                  jobName: job.jobName,
                  status,
                  description: errorMessage,
                },
              );
            }
          }

          affectedRunIds.add(job.runId);
        }
      } catch (err) {
        logger.error('Failed to forward expired job status', {
          runId: job.runId,
          jobName: job.jobName,
          error: toErrorMessage(err),
        });
      }
    }

    // Check run completion for all affected runs
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
  };
}

/**
 * Build a per-tick handler for the queue-cleanup scheduled job.
 *
 * The cadence (`intervalMs`) and the periodic wrapper itself live in
 * `packages/orchestrator/src/queue/scheduled-job.ts` — this factory
 * just produces the tick function. `runCleanup` is unchanged.
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
