/**
 * GateDeadlineDetector: periodic DB scanner enforcing an invoke gate's own
 * job-level `timeout`.
 *
 * A gate runs no steps on an agent, so the agent-side job timeout can never fire
 * for it. Instead the orchestrator owns the gate deadline: this scanner finds
 * non-terminal `gate` jobs whose `timeout_ms` has elapsed since the gate began
 * summoning and fails each one. Failing the gate drives its downstream `needs`
 * cascade through the normal job-status path; the summoned source-repo runs are
 * the repos' own runs and are left untouched.
 *
 * The gate's timeout clock is `ready_at` (when the needs scheduler released it to
 * summon), falling back to `created_at` for a root gate that never carried a
 * `ready_at`.
 */

import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionJobStatus, TERMINAL_JOB_STATES, TimeoutReason } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { JobKind } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const logger = createLogger({ prefix: 'gate-deadline-detector' });

/**
 * Recency window for the deadline-bounded scan, mirroring the workflow deadline
 * detector: a gate stays in scope while its deadline lapsed within this window,
 * which keeps long-timeout gates enforced while skipping ancient history.
 */
export const GATE_DEADLINE_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface GateDeadlineDetectorDeps {
  db: Kysely<Database>;
  /** Used to fail an overdue gate through the canonical job-status path. */
  executionTracker: Pick<ExecutionTracker, 'onJobStatus'>;
  /** How often to scan in ms (reuses the stale-detector interval). */
  scanIntervalMs: number;
}

export class GateDeadlineDetector {
  private readonly db: Kysely<Database>;
  private readonly executionTracker: GateDeadlineDetectorDeps['executionTracker'];
  private readonly scanIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: GateDeadlineDetectorDeps) {
    this.db = deps.db;
    this.executionTracker = deps.executionTracker;
    this.scanIntervalMs = deps.scanIntervalMs;
  }

  /** Start the detector: an immediate crash-recovery scan, then periodic scans. */
  async start(): Promise<void> {
    await this.scan();
    this.interval = setInterval(() => {
      this.scan().catch((err) =>
        logger.error('Gate deadline scan error (interval)', { error: toErrorMessage(err) }),
      );
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Find non-terminal gates past their timeout and fail each one. */
  async scan(): Promise<void> {
    try {
      const overdue = await this.buildOverdueQuery().execute();
      for (const gate of overdue) {
        await this.failOverdueGate(gate.run_id, gate.job_id, Number(gate.timeout_ms));
      }
      if (overdue.length > 0) {
        logger.info('Gate deadline scan complete', { timedOutGates: overdue.length });
      }
    } catch (err) {
      logger.error('Gate deadline scan error', { error: toErrorMessage(err) });
    }
  }

  /**
   * Build the SELECT for overdue gates. Extracted so a unit test can compile the
   * exact predicate set (Kysely `.compile()`) without a live database. A gate is
   * overdue when `coalesce(ready_at, created_at) + timeout_ms` is in the past;
   * the recency bound keeps the scan off ancient history each tick.
   */
  private buildOverdueQuery() {
    const deadline = sql`coalesce(ready_at, created_at) + (timeout_ms * interval '1 millisecond')`;
    return this.db
      .selectFrom('execution_jobs')
      .select(['run_id', 'job_id', 'timeout_ms'])
      .where('job_kind', '=', JobKind.Gate)
      .where('status', 'not in', [...TERMINAL_JOB_STATES])
      .where('timeout_ms', 'is not', null)
      .where(sql<boolean>`${deadline} < now()`)
      .where(
        sql<boolean>`${deadline} > now() - (${GATE_DEADLINE_RECENCY_WINDOW_MS} * interval '1 millisecond')`,
      );
  }

  private async failOverdueGate(runId: string, jobId: string, timeoutMs: number): Promise<void> {
    logger.warn('Invoke gate exceeded its timeout; failing', { runId, jobId, timeoutMs });
    // There is no dedicated `timed_out` job status — a gate that blew its timeout
    // fails (a failure-classed terminal that cascades through `needs`), carrying
    // the job_timeout reason. The summoned source-repo runs are not cancelled.
    await this.executionTracker.onJobStatus(
      runId,
      jobId,
      ExecutionJobStatus.enum.failed,
      Date.now(),
      undefined,
      { error: `${TimeoutReason.enum.job_timeout}: gate exceeded its timeout of ${timeoutMs}ms` },
    );
  }
}
