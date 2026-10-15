import { type Kysely, sql } from 'kysely';

/**
 * Add the `request_idempotency` claim table, making run-minting dashboard
 * requests (`run.rerun.request`, `run.manual_schedule.request`) idempotent on
 * the Platform `requestId`. HA coordinator siblings share one DB, so when the
 * relay fails over and re-sends to a sibling, the atomic `INSERT … ON CONFLICT
 * DO NOTHING` on `request_id` lets one coordinator win; the loser returns the
 * winner's `new_run_id`. The cleanup tick prunes rows after 1h (far past the
 * ~10s request budget).
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await tableExists(db, 'request_idempotency');
  if (exists) return;
  await db.schema
    .createTable('request_idempotency')
    .addColumn('request_id', 'text', (c) => c.primaryKey())
    .addColumn('new_run_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // Index the prune predicate (created_at) for the TTL sweep.
  await db.schema
    .createIndex('idx_request_idempotency_created_at')
    .on('request_idempotency')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('request_idempotency').ifExists().execute();
}

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ${table}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}
