/**
 * Shared run-cancellation path.
 *
 * `cancelRunWithReason` is the single canonical implementation of "cancel
 * this whole run, recording a reason". It is invoked by:
 *
 *  - the operator-facing `POST /api/v1/admin/runs/:runId/cancel` route
 *    (user-initiated `kici cancel`), and
 *  - the WorkflowDeadlineDetector, which cancels runs that exceeded their
 *    workflow-level wall-clock timeout (TimeoutReason.workflow_timeout).
 *
 * Keeping one implementation means the deadline enforcer and the user cancel
 * follow identical mechanics: send `job.cancel` to the agents running the
 * run's jobs, cancel queued dispatch rows, mark pending/queued jobs cancelled,
 * stamp the failure reason, and drive the run terminal when no agent work is
 * outstanding.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { JobQueue } from '../queue/job-queue.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const logger = createLogger({ prefix: 'cancel-run' });

export interface CancelRunDeps {
  db: Kysely<Database>;
  jobQueue: JobQueue;
  dispatcher: Dispatcher;
  registry: AgentRegistry;
  executionTracker: ExecutionTracker;
}

export interface CancelRunOptions {
  /** Force immediate SIGKILL on the agent (skip graceful hooks). */
  force?: boolean;
  /** Attribution stamped into execution_runs.cancelled_by. */
  cancelledBy?: string;
}

export interface CancelRunResult {
  /** Number of `job.cancel` messages dispatched to agents (running jobs). */
  agentsNotified: number;
  /** Number of pending/queued execution_jobs rows marked cancelled. */
  pendingCancelled: number;
}

/**
 * Cancel a whole run, recording `reason` on its cancelled jobs and (if not
 * already set) on the run's failure_reason. Sends `job.cancel` to every agent
 * holding a dispatched job for the run; cancels queued dispatch rows; marks
 * pending/queued jobs cancelled. When no agent had outstanding work, drives
 * the run to its terminal status immediately so the run does not linger in
 * `cancelling`.
 *
 * Idempotent against terminal runs: callers should pre-check terminal state
 * (the cancel route returns 409); the underlying UPDATEs are status-guarded so
 * a double-call is harmless.
 */
export async function cancelRunWithReason(
  deps: CancelRunDeps,
  runId: string,
  reason: string,
  options: CancelRunOptions = {},
): Promise<CancelRunResult> {
  const { db, jobQueue, dispatcher, registry, executionTracker } = deps;
  const force = options.force ?? false;

  // Notify agents running this run's jobs so in-flight work unwinds (graceful
  // hooks unless force).
  const dispatchedJobIds = await jobQueue.getDispatchedJobIdsByRunId(runId);
  let agentsNotified = 0;
  for (const jobId of dispatchedJobIds) {
    const agentId = dispatcher.getAgentIdForJob(jobId);
    if (!agentId) continue;
    const entry = registry.get(agentId);
    // Only an OPEN socket can actually receive the cancel. A socket that is
    // mid-close (CLOSING/CLOSED) is still in the registry until its close
    // handler unregisters it, and sending to it throws. Skip non-OPEN sockets
    // so the job is treated as orphaned (not counted as notified), letting the
    // no-outstanding-work sweep below drive the run terminal; wrap the send so
    // one bad socket cannot abort the whole cancellation and strand the run in
    // `cancelling`.
    if (entry?.ws?.readyState !== 1 /* OPEN */) continue;
    try {
      entry.ws.send(
        JSON.stringify({
          type: 'job.cancel' as const,
          messageId: randomUUID(),
          runId,
          jobId,
          reason,
          ...(force && { force: true }),
        }),
      );
      agentsNotified++;
    } catch (err) {
      logger.warn('Failed to send job.cancel to agent; treating job as orphaned', {
        runId,
        jobId,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Cancel pending/queued execution_jobs rows for the run.
  const pendingResult = await db
    .updateTable('execution_jobs')
    .set({
      status: ExecutionJobStatus.enum.cancelled,
      completed_at: new Date(),
      error_message: reason,
    })
    .where('run_id', '=', runId)
    .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
    .execute();
  const pendingCancelled = Number(pendingResult[0]?.numUpdatedRows ?? 0);

  // Cancel queued dispatch_queue entries for the run.
  await jobQueue.cancelByRunId(runId);

  // Stamp attribution + the cancellation reason. failure_reason is
  // clobber-guarded so a more specific cause already recorded wins.
  if (options.cancelledBy) {
    await db
      .updateTable('execution_runs')
      .set({ cancelled_by: options.cancelledBy })
      .where('run_id', '=', runId)
      .execute();
  }
  await db
    .updateTable('execution_runs')
    .set({ failure_reason: reason })
    .where('run_id', '=', runId)
    .where('failure_reason', 'is', null)
    .execute();

  // When no agent had outstanding work, the run won't get a later job.complete
  // to drive it terminal — finish it now from current job state. But a job can
  // be `dispatched`/`running` in execution_jobs while its agent has no live WS
  // (it never connected, died, or hasn't acked the dispatch yet — e.g. a
  // workflow timeout that fires within ~1s of dispatch, before the freshly
  // spawned agent connects). Such a row is orphaned: no agent will ever send
  // its `job.complete`, so the run can never complete and a periodic canceller
  // (the WorkflowDeadlineDetector) would re-fire forever. Cancel every
  // remaining non-terminal job row so completeRunIfAllJobsTerminal can finish.
  let orphansCancelled = 0;
  if (agentsNotified === 0) {
    const orphanResult = await db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.cancelled,
        completed_at: new Date(),
        error_message: reason,
      })
      .where('run_id', '=', runId)
      .where('status', 'not in', [...TERMINAL_JOB_STATES])
      .execute();
    orphansCancelled = Number(orphanResult[0]?.numUpdatedRows ?? 0);
    await executionTracker.completeRunIfAllJobsTerminal(runId);
  }

  logger.info('Cancelled run', {
    runId,
    agentsNotified,
    pendingCancelled,
    orphansCancelled,
    force,
  });
  return { agentsNotified, pendingCancelled };
}
