/**
 * The arbiter of `concurrency: { group, max }`.
 *
 * Every decision is a transaction against `concurrency_groups`, so `max` holds
 * across a restart and across every coordinator in a cluster. A process-local
 * map cannot: a restart empties it and lets a second run deploy alongside the
 * first, and each coordinator would hold its own map. Customers use
 * `max: 1` to serialise deploys and migrations, so "usually right" is not enough.
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
   * Serialise every arbitration for one (routingKey, groupKey) scope. A
   * transaction-scoped advisory lock, released on commit or rollback with no
   * cleanup path. Without it two coordinators both read `count < max` and both
   * insert — the double-deploy the cap exists to prevent.
   */
  private static async lockScope(
    trx: Transaction<Database>,
    groupKey: string,
    routingKey: string,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${routingKey}::${groupKey}`}))`.execute(trx);
  }

  /**
   * Idempotent: a run already holding an active slot re-acquires it without
   * consuming a second, also enforced by the partial unique index on
   * `(routing_key, group_key, run_id) WHERE status = 'active'`.
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
   * The runs holding an active slot, oldest first. A run whose `execution_runs`
   * row is terminal is excluded and its slot released in the same transaction:
   * a coordinator crash between run finish and slot release leaks the slot, and
   * on a `max: 1` deploy gate that blocks every later deploy forever.
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

  /** Active run ids reconciled against `execution_runs`. Caller holds the scope lock. */
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

  /** Promote the oldest queued job of a group to active; null when none is queued. */
  async dequeueNext(groupKey: string, routingKey: string): Promise<QueuedJob | null> {
    return this.db.transaction().execute(async (trx) => {
      // Promotion writes the active set, so it serialises against `acquireSlot`,
      // which could otherwise count the active rows mid-promotion.
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);
      return ConcurrencyQueueManager.promoteOldestQueued(trx, groupKey, routingKey);
    });
  }

  /** Promote the oldest queued waiter to `active`. Caller holds the scope lock. */
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

  /** Called when a job finishes (success/failed/cancelled). */
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
   * Release the run's slot and return the promoted next queued job, if any —
   * the caller dispatches it.
   */
  async onJobComplete(
    groupKey: string,
    routingKey: string,
    runId: string,
  ): Promise<QueuedJob | null> {
    return this.db.transaction().execute(async (trx) => {
      await ConcurrencyQueueManager.lockScope(trx, groupKey, routingKey);

      // Release and promote in ONE locked transaction. Split in two, a third
      // run's `acquireSlot` can take the freed slot between them, and the
      // promotion then adds a second active row under `max: 1`. Together, a
      // concurrent acquire sees the same active count before and after, and a
      // coordinator dying mid-release cannot leave the slot freed but unassigned.
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
