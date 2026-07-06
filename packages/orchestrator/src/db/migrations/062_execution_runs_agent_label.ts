import { type Kysely, sql } from 'kysely';

/**
 * Add the agent-provenance columns to `execution_runs`:
 *
 *  - `triggered_by_agent_label` — the human-set agent name when the run was
 *    triggered through an agent-kind credential (user agent PAT or org agent
 *    API key) via the developer MCP server.
 *  - `cancelled_by_agent_label` — likewise for a cancellation driven through an
 *    agent credential.
 *
 * The label is provenance only (the credential still inherits its principal's
 * permissions). NULL for ordinary human / webhook / system-driven runs.
 * Nullable, no backfill, idempotent.
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
