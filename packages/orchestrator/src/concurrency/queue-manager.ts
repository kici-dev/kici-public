/**
 * The arbiter of `concurrency: { group, max }`.
 *
 * Every decision is a transaction against `concurrency_groups`, which is what
 * makes `max` mean the same thing across a restart and across every coordinator
 * in a cluster. A process-local map cannot: a restart came back with an empty
 * map and let a second run deploy alongside the one already deploying, and two
 * coordinators each held their own map so `max: 1` was never cluster-wide.
 * `concurrency: { group, max: 1 }` is the guard customers use to serialise
 * deploys and migrations, so "usually right" is not a useful guarantee.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import { TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'concurrency-queue' });

/** `concurrency_groups.status` values. */
export enum ConcurrencySlotStatus {
  Active = 'active',
  Queued = 'queued',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

/** A queued job returned from dequeue operations. */
export interface QueuedJob {
  id: string;
  groupKey: string;
  routingKey: string;
  runId: string;
  jobId: string;
}

/** Options for enqueueing a job. */
export interface EnqueueOptions {
  groupKey: string;
  routingKey: string;
  runId: string;
  jobId: string;
}

export class ConcurrencyQueueManager {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Serialise every arbitration for one (routingKey, groupKey) scope.
   *
   * A transaction-scoped advisory lock, so it is released on commit or
   * rollback with no cleanup path to get wrong. Counting active rows and
   * inserting one are two statements, and without the lock two coordinators
   * both read `count < max` and both insert — which is exactly the
   * double-deploy the cap exists to prevent.
   */
  private static async lockScope(
    trx: Transaction<Database>,
    groupKey: string,
    routingKey: string,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${routingKey}::${groupKey}`}))`.execute(trx);
  }

  /**
   * Try to take a slot in a concurrency group.
   *
   * Idempotent: a run that already holds an active slot re-acquires it without
   * consuming a second one, which the partial unique index on
   * `(routing_key, group_key, run_id) WHERE status = 'active'` also enforces at
   * the DB level.
   *
   * @returns whether this run holds a slot afterwards.
   */
  async acquireSlot(
    groupKey: string,
    routingKey: string,
    runId: string,
    jobId: string,
    opts: { max: number },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);

      const mine = await trx
        .selectFrom('concurrency_groups')
        .select(['id'])
        .where('group_key', '=', groupKey)
        .where('routing_key', '=', routingKey)
        .where('run_id', '=', runId)
        .where('status', '=', ConcurrencySlotStatus.Active)
        .executeTakeFirst();
      if (mine) return true;

      const active = await ConcurrencyQueueManager.activeRunIds(trx, groupKey, routingKey);
      if (active.length >= opts.max) return false;

      await trx
        .insertInto('concurrency_groups')
        .values({
          group_key: groupKey,
          run_id: runId,
          job_id: jobId,
          routing_key: routingKey,
          status: ConcurrencySlotStatus.Active,
        })
        .execute();
      return true;
    });
  }

  /** Release this run's slot in a group. No-op when it holds none. */
  async releaseSlot(groupKey: string, routingKey: string, runId: string): Promise<void> {
    await this.markCompleted(runId, groupKey, routingKey);
  }

  /**
   * The runs holding an active slot, oldest first.
   *
   * A run whose `execution_runs` row is already terminal is excluded and its
   * slot is released in the same transaction. A slot outlives its run whenever
   * the release path did not run — a coordinator crash between "the run
   * finished" and "the slot was released" — and a leaked slot on a `max: 1`
   * deploy gate blocks every later deploy forever.
   */
  async getActiveRuns(groupKey: string, routingKey: string): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);
      return ConcurrencyQueueManager.activeRunIds(trx, groupKey, routingKey);
    });
  }

  /** The oldest active run, which `cancelInProgress` supersedes. */
  async getOldestRun(groupKey: string, routingKey: string): Promise<string | null> {
    const active = await this.getActiveRuns(groupKey, routingKey);
    return active[0] ?? null;
  }

  /**
   * Active run ids for a scope, reconciled against `execution_runs`. Must be
   * called with the scope lock already held.
   */
  private static async activeRunIds(
    trx: Transaction<Database>,
    groupKey: string,
    routingKey: string,
  ): Promise<string[]> {
    const rows = await trx
      .selectFrom('concurrency_groups')
      .select(['id', 'run_id'])
      .where('group_key', '=', groupKey)
      .where('routing_key', '=', routingKey)
      .where('status', '=', ConcurrencySlotStatus.Active)
      .orderBy('created_at', 'asc')
      .execute();
    if (rows.length === 0) return [];

    const finished = await trx
      .selectFrom('execution_runs')
      .select(['run_id'])
      .where(
        'run_id',
        'in',
        rows.map((r) => r.run_id),
      )
      .where('status', 'in', [...TERMINAL_RUN_STATES])
      .execute();
    if (finished.length === 0) return rows.map((r) => r.run_id);

    const stale = new Set(finished.map((r) => r.run_id));
    const leaked = rows.filter((r) => stale.has(r.run_id));
    await trx
      .updateTable('concurrency_groups')
      .set({ status: ConcurrencySlotStatus.Completed, completed_at: new Date() })
      .where(
        'id',
        'in',
        leaked.map((r) => r.id),
      )
      .execute();
    logger.info('Released concurrency slots held by finished runs', {
      groupKey,
      routingKey,
      released: leaked.length,
    });
    return rows.filter((r) => !stale.has(r.run_id)).map((r) => r.run_id);
  }

  /**
   * Enqueue a job that is waiting for a concurrency slot.
   * Inserts a row with status='queued' into concurrency_groups.
   */
  async enqueue(opts: EnqueueOptions): Promise<void> {
    await this.db
      .insertInto('concurrency_groups')
      .values({
        group_key: opts.groupKey,
        run_id: opts.runId,
        job_id: opts.jobId,
        routing_key: opts.routingKey,
        status: ConcurrencySlotStatus.Queued,
      })
      .execute();

    logger.info('Job enqueued for concurrency group', {
      groupKey: opts.groupKey,
      routingKey: opts.routingKey,
      runId: opts.runId,
      jobId: opts.jobId,
    });
  }

  /**
   * Dequeue the oldest queued job for a concurrency group.
   * Returns null if no queued jobs exist.
   */
  async dequeueNext(groupKey: string, routingKey: string): Promise<QueuedJob | null> {
    return this.db.transaction().execute(async (trx) => {
      // Same scope lock every other arbitration takes. Promoting a waiter is a
      // write to the active set, so it has to serialize against `acquireSlot`
      // or an acquire can count the active rows in the middle of a promotion.
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);
      return ConcurrencyQueueManager.promoteOldestQueued(trx, groupKey, routingKey);
    });
  }

  /**
   * Promote the oldest queued waiter to `active`. Must be called with the scope
   * lock already held.
   */
  private static async promoteOldestQueued(
    trx: Transaction<Database>,
    groupKey: string,
    routingKey: string,
  ): Promise<QueuedJob | null> {
    {
      const row = await trx
        .selectFrom('concurrency_groups')
        .selectAll()
        .where('group_key', '=', groupKey)
        .where('routing_key', '=', routingKey)
        .where('status', '=', ConcurrencySlotStatus.Queued)
        .orderBy('created_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!row) return null;

      // Update status to active within the same transaction
      await trx
        .updateTable('concurrency_groups')
        .set({ status: ConcurrencySlotStatus.Active })
        .where('id', '=', row.id)
        .execute();

      return {
        id: row.id,
        groupKey: row.group_key,
        routingKey: row.routing_key,
        runId: row.run_id,
        jobId: row.job_id,
      };
    }
  }

  /**
   * Cancel all queued entries for a run.
   * Marks them as 'cancelled' with a completion timestamp.
   */
  async cancelQueued(runId: string): Promise<void> {
    await this.db
      .updateTable('concurrency_groups')
      .set({
        status: ConcurrencySlotStatus.Cancelled,
        completed_at: new Date(),
      })
      .where('run_id', '=', runId)
      .where('status', '=', ConcurrencySlotStatus.Queued)
      .execute();

    logger.info('Cancelled queued concurrency entries', { runId });
  }

  /**
   * Mark a concurrency group entry as completed.
   * Called when a job finishes (success/failed/cancelled).
   */
  async markCompleted(runId: string, groupKey: string, routingKey: string): Promise<void> {
    await this.db
      .updateTable('concurrency_groups')
      .set({
        status: ConcurrencySlotStatus.Completed,
        completed_at: new Date(),
      })
      .where('run_id', '=', runId)
      .where('group_key', '=', groupKey)
      .where('routing_key', '=', routingKey)
      .where('status', '=', ConcurrencySlotStatus.Active)
      .execute();
  }

  /**
   * Handle job completion: mark completed and return next queued job if any.
   * This is the main coordination point: when a slot opens, the next
   * queued job should be dispatched.
   */
  async onJobComplete(
    groupKey: string,
    routingKey: string,
    runId: string,
  ): Promise<QueuedJob | null> {
    return this.db.transaction().execute(async (trx) => {
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);

      // Release and promote in ONE locked transaction. As two transactions the
      // pair is not net-zero on the active set: between them a third run's
      // `acquireSlot` takes the lock, counts the freed slot as available and
      // inserts, and the promotion below then adds a second active row under
      // `max: 1`. Held together under the lock, a concurrent acquire sees the
      // active count either wholly before or wholly after, and it is the same
      // number both times. It also closes the crash window — a coordinator that
      // dies mid-release cannot leave the slot freed but unassigned.
      await trx
        .updateTable('concurrency_groups')
        .set({ status: ConcurrencySlotStatus.Completed, completed_at: new Date() })
        .where('run_id', '=', runId)
        .where('group_key', '=', groupKey)
        .where('routing_key', '=', routingKey)
        .where('status', '=', ConcurrencySlotStatus.Active)
        .execute();

      return ConcurrencyQueueManager.promoteOldestQueued(trx, groupKey, routingKey);
    });
  }
}
