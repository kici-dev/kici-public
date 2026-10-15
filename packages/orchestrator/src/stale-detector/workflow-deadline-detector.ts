/**
 * Periodic DB scanner enforcing the workflow `timeout`: a run-level wall-clock deadline the
 * orchestrator owns because jobs span multiple agents. It cancels non-terminal runs past
 * `started_at + workflow_timeout_ms` through the canonical run-cancel path with
 * TimeoutReason.workflow_timeout, so the dashboard labels the run "timed out", not cancelled.
 */

import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionRunStatus, TimeoutReason } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { JobQueue } from '../queue/job-queue.js';

const logger = createLogger({ prefix: 'workflow-deadline-detector' });

/**
 * A run is in scope while its deadline lapsed within this window: the 24h crash-recovery
 * horizon for the immediate `start()` scan; older lapses are a separate stale-recovery
 * concern. It bounds the DEADLINE, not `started_at`, so timeouts >= 24h are enforced.
 */
export const DEADLINE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WorkflowDeadlineDetectorDeps {
  db: Kysely<Database>;
  /** cancelRunWithReason bound to the orchestrator's deps, as the `kici cancel` route uses. */
  cancelRun: (runId: string, reason: string, options: { force: boolean }) => Promise<unknown>;
  jobQueue: JobQueue;
  /** Milliseconds; the caller reuses the stale-detector interval. */
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

  /** An immediate scan catches deadlines that lapsed while the orchestrator was down. */
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

  async scan(): Promise<void> {
    try {
      const overdue = await this.buildOverdueQuery().execute();

      for (const run of overdue) {
        await this.cancelOverdueRun(
          run.run_id,
          Number(run.workflow_timeout_ms),
          run.cancel_force === true,
        );
      }

      if (overdue.length > 0) {
        logger.info('Workflow deadline scan complete', { timedOutRuns: overdue.length });
      }
    } catch (err) {
      logger.error('Workflow deadline scan error', { error: toErrorMessage(err) });
    }
  }

  /**
   * Separate so a unit test can `.compile()` the exact predicates without a live database.
   *
   * Overdue (deadline < now) AND recent (deadline > now - window). A
   * `started_at > (now - window)` guard would exclude timeouts >= the window forever, since
   * their deadline lapses only after `started_at` aged past it; the deadline bound still skips
   * long-past deadlines, so ancient history is not re-scanned every tick.
   */
  private buildOverdueQuery() {
    const deadline = sql`started_at + (workflow_timeout_ms * interval '1 millisecond')`;
    return (
      this.db
        .selectFrom('execution_runs')
        .select(['run_id', 'workflow_timeout_ms', 'started_at', 'cancel_force'])
        .where('status', 'in', [
          ExecutionRunStatus.enum.pending,
          ExecutionRunStatus.enum.running,
          ExecutionRunStatus.enum.cancelling,
        ])
        .where('workflow_timeout_ms', 'is not', null)
        // Overdue, but lapsed within the recency window.
        .where(sql<boolean>`${deadline} < now()`)
        .where(
          sql<boolean>`${deadline} > now() - (${DEADLINE_RECENCY_WINDOW_MS} * interval '1 millisecond')`,
        )
    );
  }

  /**
   * A run a forced cancel already reached (`cancel_force`) is cancelled with
   * `force` again, so a deadline scan never turns that cancel graceful.
   */
  private async cancelOverdueRun(runId: string, timeoutMs: number, force: boolean): Promise<void> {
    const reason = `${TimeoutReason.enum.workflow_timeout}: run exceeded the workflow timeout of ${timeoutMs}ms`;
    logger.warn('Workflow run exceeded its deadline; cancelling', { runId, timeoutMs });

    await this.jobQueue.cancelByRunId(runId);
    await this.cancelRun(runId, reason, { force });
  }
}
