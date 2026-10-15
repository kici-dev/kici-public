import { type Kysely, sql } from 'kysely';

/**
 * Agent provenance on `execution_runs`: `triggered_by_agent_label` / `cancelled_by_agent_label`
 * hold the human-set agent name when an agent-kind credential (user agent PAT or org agent API
 * key) drove the trigger / cancel via the developer MCP server.
 *
 * Provenance only: the credential still inherits its principal's permissions. NULL for human /
 * webhook / system runs. Nullable, no backfill, idempotent.
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
  if (!(await colExists(db, 'execution_runs', 'triggered_by_agent_label'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN triggered_by_agent_label text`.execute(
      db,
    );
  }
  if (!(await colExists(db, 'execution_runs', 'cancelled_by_agent_label'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN cancelled_by_agent_label text`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS triggered_by_agent_label`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS cancelled_by_agent_label`.execute(
    db,
  );
}
