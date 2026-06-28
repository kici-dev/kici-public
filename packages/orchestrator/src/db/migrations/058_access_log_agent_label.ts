import { type Kysely, sql } from 'kysely';

/**
 * Add `access_log.agent_label text` — the human-set name of the agent that
 * performed the action, when the actor authenticated with an agent-kind PAT.
 *
 * Queryable column (not just baked into `actor_meta`) so an operator can filter
 * the access log by agent. NULL for ordinary human / API-key / system actors.
 * Nullable, no backfill. Idempotent.
 */
async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'access_log', 'agent_label'))) {
    await sql`ALTER TABLE public.access_log ADD COLUMN agent_label text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.access_log DROP COLUMN IF EXISTS agent_label`.execute(db);
}
