import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.agent_id` (nullable text).
 *
 * The durable record of which agent a job was dispatched to. `ack_agent_id` is
 * cleared the moment the agent answers the dispatch, so it cannot answer "who
 * owns this job?" for the rest of the job's life; this column is written at
 * dispatch and cleared only on requeue, so a coordinator that never saw the
 * dispatch — a freshly-elected leader after a failover — can still resolve
 * ownership of a live `dispatched` row straight from the database.
 *
 * Nullable with no backfill: a row dispatched before this migration keeps a NULL
 * owner and resolves to "not owned", which is the behaviour it already had.
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has the
 * column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'dispatch_queue'
         AND column_name = 'agent_id'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.dispatch_queue ADD COLUMN agent_id TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS agent_id`.execute(db);
}
