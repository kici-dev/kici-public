import { type Kysely, sql } from 'kysely';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import { JobQueue } from './job-queue.js';

const logger = createLogger({ prefix: 'cleanup' });

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
  extras?: {
    db: Kysely<Database>;
    executionTracker: ExecutionTracker;
  },
): Promise<{
  dedupDeleted: number;
  queueExpired: number;
}> {
  // 1. Delete expired dedup_cache entries (also trims in-memory cache)
  const dedupDeleted = await dedup.cleanup();

  // 2. Mark expired dispatch_queue entries and get details
  const expiredJobs = await queue.markExpired();
  const queueExpired = expiredJobs.length;

  // 3. Forward terminal status to Platform for each expired job
  if (extras && expiredJobs.length > 0) {
    const affectedRunIds = new Set<string>();
    const genericMessage = 'Queue timeout expired (job was never dispatched to an agent)';

    for (const job of expiredJobs) {
      // Prefer the scaler's last spawn-failure detail; fall back to the
      // generic timeout message when the job was never assigned an agent
      // for an unrelated reason.
      const errorMessage = job.lastProvisioningError ?? genericMessage;
      try {
        // Update the orchestrator's local execution_jobs row
        const ejResult = await extras.db
          .updateTable('execution_jobs')
          .set({
            status: ExecutionJobStatus.enum.timed_out_stale,
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
          if (job.lastProvisioningError) {
            await extras.db
              .updateTable('execution_runs')
              .set({ failure_reason: job.lastProvisioningError })
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
            extras.executionTracker.updateInMemoryJob(
              job.runId,
              ejRow.job_id,
              ExecutionJobStatus.enum.timed_out_stale,
            );

            extras.executionTracker.forwardJobTerminalStatus(
              job.runId,
              ejRow.job_id,
              job.jobName,
              ExecutionJobStatus.enum.timed_out_stale,
              errorMessage,
            );

            extras.executionTracker.emitInfraEvent(job.runId, 'orchestrator.job.queue_expired', {
              jobId: ejRow.job_id,
              metadata: { jobName: job.jobName, reason: errorMessage },
            });
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

  if (dedupDeleted > 0 || queueExpired > 0) {
    logger.info('Cleanup completed', {
      dedupDeleted,
      queueExpired,
    });
  } else {
    logger.debug('Cleanup completed, nothing to clean');
  }

  return {
    dedupDeleted,
    queueExpired,
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
  extras?: {
    db: Kysely<Database>;
    executionTracker: ExecutionTracker;
  },
): () => Promise<void> {
  return async () => {
    await runCleanup(dedup, queue, extras);
  };
}
