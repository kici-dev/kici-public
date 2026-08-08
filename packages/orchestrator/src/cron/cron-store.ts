import type { Kysely, Transaction } from 'kysely';

import type { Database } from '../db/types.js';

type DbExecutor = Kysely<Database> | Transaction<Database>;

/**
 * In-memory cache key uniting a registration and one of its schedules.
 *
 * A workflow may declare several `schedule()` triggers, each tracked
 * independently in `cron_last_fired` keyed by (registration_id, schedule_key).
 * The space separator is unambiguous: a registration id is a UUID and a
 * schedule key is `${cronExpression}\n${timezone}` — neither contains a space
 * at the boundary that could collide.
 */
export function cronCacheKey(registrationId: string, scheduleKey: string): string {
  return `${registrationId} ${scheduleKey}`;
}

/**
 * DB persistence for cron last-fired tracking.
 *
 * Tracks the last time each (registration, schedule) was fired — a workflow
 * with multiple `schedule()` triggers has one row per distinct schedule.
 * Used by CronScheduler for fire-once-on-recovery after leader transitions.
 * Uses upsert (INSERT ON CONFLICT UPDATE) for atomic idempotent writes.
 */
export class CronStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Atomically claim a cron fire for one schedule of a registration: only
   * succeeds if no other orchestrator has already fired this (registration,
   * schedule) at a time >= firedAt.
   *
   * Uses INSERT ... ON CONFLICT with a WHERE guard so the upsert only writes
   * when `last_fired_at < firedAt` (or the row doesn't exist yet). The conflict
   * target is the composite key (registration_id, schedule_key) so two distinct
   * schedules of the same registration claim independently.
   *
   * Accepts an optional executor (Kysely DB handle or Transaction). The cron
   * fire path passes a Transaction so the claim and the subsequent
   * `kici_events` insert + `pg_notify` commit atomically — closing the
   * "claim succeeds but emit fails" silent-loss window that existed when
   * these were separate transactions.
   *
   * Returns true if this call won the race (the fire should proceed).
   * Returns false if another node already recorded a fire >= firedAt.
   */
  async tryClaimFire(
    registrationId: string,
    scheduleKey: string,
    firedAt: Date,
    executor: DbExecutor = this.db,
  ): Promise<boolean> {
    const result = await executor
      .insertInto('cron_last_fired')
      .values({
        registration_id: registrationId,
        schedule_key: scheduleKey,
        last_fired_at: firedAt,
      })
      .onConflict((oc) =>
        oc
          .columns(['registration_id', 'schedule_key'])
          .doUpdateSet({
            last_fired_at: firedAt,
            updated_at: new Date(),
          })
          .where('cron_last_fired.last_fired_at', '<', firedAt),
      )
      .executeTakeFirst();

    // If numInsertedOrUpdatedRows is 0, another node already claimed this fire
    return BigInt(result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Get all last-fired records as a Map keyed by `cronCacheKey(registrationId,
   * scheduleKey)`. Used for bulk loading during leader recovery.
   */
  async getAll(): Promise<Map<string, Date>> {
    const rows = await this.db.selectFrom('cron_last_fired').selectAll().execute();

    const map = new Map<string, Date>();
    for (const row of rows) {
      map.set(cronCacheKey(row.registration_id, row.schedule_key), row.last_fired_at);
    }
    return map;
  }
}
