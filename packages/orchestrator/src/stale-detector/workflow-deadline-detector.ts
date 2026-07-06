/**
 * WorkflowDeadlineDetector: periodic DB scanner enforcing the workflow-level
 * run deadline.
 *
 * A workflow `timeout` caps the whole run's wall-clock across all jobs.
 * Because jobs span multiple agents, the cap is a run-level deadline owned by
 * the orchestrator. This scanner finds non-terminal runs whose
 * `started_at + workflow_timeout_ms` has passed and cancels them through the
 * canonical run-cancel path, recording the distinct
 * TimeoutReason.workflow_timeout so the dashboard labels the run "timed out"
 * rather than a generic cancel.
 */

import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionRunStatus, TimeoutReason } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { JobQueue } from '../queue/job-queue.js';

const logger = createLogger({ prefix: 'workflow-deadline-detector' });

/**
 * Recency window for the deadline-bounded scan: a run stays in scope while its
 * deadline (`started_at + workflow_timeout_ms`) lapsed within this window. 24h is
 * the crash-recovery horizon — a run whose deadline lapsed while the orchestrator
 * was down for less than this is still caught by the immediate `start()` scan; a
 * deadline that lapsed longer ago is out of scope (separate stale-recovery concern).
 * The window bounds the DEADLINE, not `started_at`, so timeouts >= 24h are enforced.
 */
export const DEADLINE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WorkflowDeadlineDetectorDeps {
  db: Kysely<Database>;
  /**
   * Canonical "cancel this whole run with a reason" callback — the same
   * implementation the user-initiated `kici cancel` route uses
   * (cancelRunWithReason bound to the orchestrator's deps).
   */
  cancelRun: (runId: string, reason: string) => Promise<unknown>;
  jobQueue: JobQueue;
  /** How often to scan in ms. Default supplied by the caller (reuses the stale-detector interval). */
  scanIntervalMs: number;
}

export class WorkflowDeadlineDetector {
  private readonly db: Kysely<Database>;
  private readonly cancelRun: WorkflowDeadlineDetectorDeps['cancelRun'];
  private readonly jobQueue: JobQueue;
  private readonly scanIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WorkflowDeadlineDetectorDeps) {
    this.db = deps.db;
    this.cancelRun = deps.cancelRun;
    this.jobQueue = deps.jobQueue;
    this.scanIntervalMs = deps.scanIntervalMs;
  }

  /**
   * Start the detector: an immediate scan (crash recovery — catch runs that
   * blew their deadline while the orchestrator was down), then periodic scans.
   */
  async start(): Promise<void> {
    await this.scan();
    this.interval = setInterval(() => {
      this.scan().catch((err) =>
        logger.error('Workflow deadline scan error (interval)', { error: toErrorMessage(err) }),
      );
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run a single deadline scan: find non-terminal runs with a configured
   * workflow timeout whose `started_at + workflow_timeout_ms` has passed and
   * cancel each one.
   */
  async scan(): Promise<void> {
    try {
      const overdue = await this.buildOverdueQuery().execute();

      for (const run of overdue) {
        await this.cancelOverdueRun(run.run_id, Number(run.workflow_timeout_ms));
      }

      if (overdue.length > 0) {
        logger.info('Workflow deadline scan complete', { timedOutRuns: overdue.length });
      }
    } catch (err) {
      logger.error('Workflow deadline scan error', { error: toErrorMessage(err) });
    }
  }

  /**
   * Build the SELECT for overdue runs. Extracted so a unit test can compile the
   * exact predicate set (Kysely `.compile()`) and assert the deadline-recency
   * bound without a live database.
   *
   * Bound the scan to runs whose DEADLINE lapsed within the recency window:
   * overdue (deadline < now) AND recent (deadline > now - window). Bounding by
   * the deadline (`started_at + workflow_timeout_ms`) rather than `started_at`
   * keeps long-timeout runs (timeout >= the window, e.g. >= 24h) in scope once
   * overdue — a `started_at > (now - window)` guard silently excluded those
   * forever because their deadline only lapses after `started_at` has already
   * aged past the window — while still skipping runs whose deadline passed long
   * ago (already handled), preserving the "don't re-scan ancient history every
   * tick" performance intent.
   */
  private buildOverdueQuery() {
    const deadline = sql`started_at + (workflow_timeout_ms * interval '1 millisecond')`;
    return (
      this.db
        .selectFrom('execution_runs')
        .select(['run_id', 'workflow_timeout_ms', 'started_at'])
        .where('status', 'in', [
          ExecutionRunStatus.enum.pending,
          ExecutionRunStatus.enum.running,
          ExecutionRunStatus.enum.cancelling,
        ])
        .where('workflow_timeout_ms', 'is not', null)
        // deadline < now() — the run is overdue.
        .where(sql<boolean>`${deadline} < now()`)
        // deadline > now() - <recency window> — the deadline lapsed recently; replaces
        // the old started_at > (now - window) guard so long-timeout runs stay in scope.
        .where(
          sql<boolean>`${deadline} > now() - (${DEADLINE_RECENCY_WINDOW_MS} * interval '1 millisecond')`,
        )
    );
  }

  private async cancelOverdueRun(runId: string, timeoutMs: number): Promise<void> {
    const reason = `${TimeoutReason.enum.workflow_timeout}: run exceeded the workflow timeout of ${timeoutMs}ms`;
    logger.warn('Workflow run exceeded its deadline; cancelling', { runId, timeoutMs });

    // Cancel queued dispatch rows for this run, then drive the run + its
    // running jobs through the canonical cancel path with the distinct reason.
    await this.jobQueue.cancelByRunId(runId);
    await this.cancelRun(runId, reason);
  }
}
