import { type Kysely, sql } from 'kysely';

/**
 * Index `access_log.agent_label` (column added by migration 058) so the
 * operator-facing agent filter (`kici-admin access-log list --agent-label`,
 * the dashboard "agent name" filter) does an indexed exact-match lookup
 * instead of a scan. Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS access_log_agent_label_idx ON public.access_log (agent_label)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS access_log_agent_label_idx`.execute(db);
}
