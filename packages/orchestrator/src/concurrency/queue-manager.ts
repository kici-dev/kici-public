/**
 * DB-backed concurrency queue manager.
 *
 * Persists queued jobs to the concurrency_groups table and dequeues
 * the oldest queued job when a slot opens. Works with ConcurrencyGroupTracker
 * for slot-based coordination.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'concurrency-queue' });

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
        status: 'queued',
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
   * Record an active slot in the DB for persistence across restarts.
   */
  async recordActive(opts: EnqueueOptions): Promise<void> {
    await this.db
      .insertInto('concurrency_groups')
      .values({
        group_key: opts.groupKey,
        run_id: opts.runId,
        job_id: opts.jobId,
        routing_key: opts.routingKey,
        status: 'active',
      })
      .execute();
  }

  /**
   * Dequeue the oldest queued job for a concurrency group.
   * Returns null if no queued jobs exist.
   */
  async dequeueNext(groupKey: string, routingKey: string): Promise<QueuedJob | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('concurrency_groups')
        .selectAll()
        .where('group_key', '=', groupKey)
        .where('routing_key', '=', routingKey)
        .where('status', '=', 'queued')
        .orderBy('created_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();

      if (!row) return null;

      // Update status to active within the same transaction
      await trx
        .updateTable('concurrency_groups')
        .set({ status: 'active' })
        .where('id', '=', row.id)
        .execute();

      return {
        id: row.id,
        groupKey: row.group_key,
        routingKey: row.routing_key,
        runId: row.run_id,
        jobId: row.job_id,
      };
    });
  }

  /**
   * Cancel all queued entries for a run.
   * Marks them as 'cancelled' with a completion timestamp.
   */
  async cancelQueued(runId: string): Promise<void> {
    await this.db
      .updateTable('concurrency_groups')
      .set({
        status: 'cancelled',
        completed_at: new Date(),
      })
      .where('run_id', '=', runId)
      .where('status', '=', 'queued')
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
        status: 'completed',
        completed_at: new Date(),
      })
      .where('run_id', '=', runId)
      .where('group_key', '=', groupKey)
      .where('routing_key', '=', routingKey)
      .where('status', '=', 'active')
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
    // Mark current as completed
    await this.markCompleted(runId, groupKey, routingKey);

    // Check for next queued job
    return this.dequeueNext(groupKey, routingKey);
  }

  /**
   * Load all active entries from DB for hydrating the in-memory tracker.
   * Called on orchestrator startup.
   */
  async loadActiveEntries(): Promise<
    Array<{ groupKey: string; routingKey: string; runId: string }>
  > {
    const rows = await this.db
      .selectFrom('concurrency_groups')
      .selectAll()
      .where('status', '=', 'active')
      .execute();

    return rows.map((row) => ({
      groupKey: row.group_key,
      routingKey: row.routing_key,
      runId: row.run_id,
    }));
  }
}
