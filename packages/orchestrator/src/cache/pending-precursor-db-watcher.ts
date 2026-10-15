/**
 * The shared-database channel for pending precursor jobs.
 *
 * The dispatch queue is cluster-wide, so a build / init / dynamic-eval job this
 * coordinator dispatched may be claimed by an agent on a sibling coordinator.
 * The sibling persists the terminal `job.status` (status plus
 * `execution_jobs.precursor_result`) and relays nothing: between coordinators
 * the shared row IS the report. Without this, local trackers wait out their own
 * timeout on a job the fleet already finished.
 *
 * While any tracker awaits a job, this watcher polls exactly those rows and
 * hands each terminal one to `settlePendingPrecursor`, the same function the
 * local agent socket uses, so the channels cannot disagree on "finished". A job
 * the socket settled is no longer tracked; a non-terminal row is re-read next
 * tick.
 *
 * Only builds, inits and dynamic evals ride this channel. A pre-run global eval
 * round writes no `execution_jobs` row; its own wait ceiling bounds it.
 */

import { sql, type Kysely } from 'kysely';
import type { InitFailure } from '@kici-dev/engine';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { PendingBuildTracker } from './pending-builds.js';
import type { PendingDynamicTracker } from './pending-dynamics.js';
import type { PendingInitTracker } from './pending-inits.js';
import { settlePendingPrecursor } from './precursor-result.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'pending-precursor-db-watcher' });

/**
 * Re-read interval while anything is pending. Short, because it is the latency
 * a cross-coordinator build adds before real jobs dispatch; the query is one
 * primary-key lookup per tracked job and runs only while a tracker is
 * non-empty, so an idle coordinator pays nothing.
 */
export const DEFAULT_PRECURSOR_DB_POLL_MS = 2_000;

/** `dispatch_queue.id` is a uuid column, so anything else was never a row in it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendingPrecursorDbWatcherDeps {
  db: Kysely<Database>;
  pendingBuilds?: Pick<PendingBuildTracker, 'has' | 'resolve' | 'reject' | 'trackedJobIds'>;
  pendingInits?: Pick<PendingInitTracker, 'has' | 'resolve' | 'reject' | 'trackedJobIds'>;
  pendingDynamics?: Pick<PendingDynamicTracker, 'has' | 'resolve' | 'reject' | 'trackedJobIds'>;
  /**
   * Syncs this coordinator's in-memory job status with the settled row; the
   * agent frame went to the sibling, and without this the run's completion
   * check here reads the job as pending forever.
   */
  executionTracker?: { updateInMemoryJob(runId: string, jobId: string, status: string): void };
  /** Defaults to {@link DEFAULT_PRECURSOR_DB_POLL_MS}. */
  intervalMs?: number;
}

export class PendingPrecursorDbWatcher {
  private readonly deps: PendingPrecursorDbWatcherDeps;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  /**
   * Terminal rows with nothing to settle on — a `success` with no precursor
   * marker, which a coordinator that predates `precursor_result` writes. Logged
   * once per job, not per tick; the waiter's own timeout bounds it.
   */
  private readonly warnedNoPayload = new Set<string>();

  constructor(deps: PendingPrecursorDbWatcherDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? DEFAULT_PRECURSOR_DB_POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      runDetached(logger, 'Pending precursor DB watcher tick', () => this.tick());
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('Pending precursor DB watcher started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('Pending precursor DB watcher stopped');
  }

  /** The job ids any tracker currently awaits, de-duplicated. */
  private trackedJobIds(): string[] {
    const { pendingBuilds, pendingInits, pendingDynamics } = this.deps;
    return [
      ...new Set([
        ...(pendingBuilds?.trackedJobIds() ?? []),
        ...(pendingInits?.trackedJobIds() ?? []),
        ...(pendingDynamics?.trackedJobIds() ?? []),
      ]),
    ].filter((id) => UUID.test(id));
  }

  /**
   * Settle every tracked job's terminal row; returns how many settled. Never
   * throws — a read fault costs one tick. Single-flight, so a slow read cannot
   * stack ticks.
   */
  async tick(): Promise<number> {
    if (this.tickInFlight) return 0;
    const ids = this.trackedJobIds();
    if (ids.length === 0) return 0;
    this.tickInFlight = true;
    try {
      const rows = await this.deps.db
        .selectFrom('dispatch_queue as dq')
        .innerJoin('execution_jobs as ej', (join) =>
          join
            .onRef('ej.run_id', '=', sql`dq.run_id::uuid`)
            .onRef('ej.job_id', '=', sql`dq.id::text`),
        )
        .select([
          'dq.id as job_id',
          'dq.run_id',
          'ej.status',
          'ej.precursor_result',
          'ej.error_message',
          'ej.init_failure',
        ])
        .where('dq.id', 'in', ids)
        .where('ej.status', 'in', [...TERMINAL_JOB_STATES])
        .execute();

      let settled = 0;
      for (const row of rows) {
        const data: Record<string, unknown> = {
          ...(row.precursor_result ?? {}),
          ...(row.error_message ? { error: row.error_message } : {}),
          ...(row.init_failure ? { initFailure: row.init_failure as InitFailure } : {}),
        };
        const didSettle = settlePendingPrecursor(
          {
            pendingBuilds: this.deps.pendingBuilds,
            pendingInits: this.deps.pendingInits,
            pendingDynamics: this.deps.pendingDynamics,
          },
          { jobId: row.job_id, state: row.status, data },
        );
        if (!didSettle) {
          if (!this.warnedNoPayload.has(row.job_id)) {
            this.warnedNoPayload.add(row.job_id);
            logger.warn('Terminal shared row carries no precursor payload; waiter not settled', {
              runId: row.run_id,
              jobId: row.job_id,
              status: row.status,
            });
          }
          continue;
        }
        this.warnedNoPayload.delete(row.job_id);
        settled++;
        this.deps.executionTracker?.updateInMemoryJob(row.run_id, row.job_id, row.status);
        logger.info('Pending precursor settled from the shared row', {
          runId: row.run_id,
          jobId: row.job_id,
          status: row.status,
        });
      }
      return settled;
    } catch (err) {
      logger.warn('Pending precursor DB read failed; retrying next tick', {
        tracked: ids.length,
        error: toErrorMessage(err),
      });
      return 0;
    } finally {
      this.tickInFlight = false;
    }
  }
}
