import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.agent_id` (nullable text).
 *
 * The durable record of which agent a job was dispatched to. `ack_agent_id` clears when the
 * agent answers the dispatch; this column is written at dispatch and cleared only on requeue,
 * so a coordinator that never saw the dispatch (a new leader after failover) can still resolve
 * ownership of a live `dispatched` row from the database.
 *
 * No backfill: older rows keep a NULL owner and resolve to "not owned", as before.
 * Idempotent: guarded on column existence.
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
