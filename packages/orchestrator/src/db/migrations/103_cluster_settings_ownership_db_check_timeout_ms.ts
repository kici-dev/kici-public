import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.ownership_db_check_timeout_ms` (nullable bigint).
 *
 * Deadline for a single database-backed agent-ownership lookup. The lookup runs
 * on the inbound path of every job-scoped agent frame whose in-memory ownership
 * check misses, so a slow database would otherwise stall the frame; past the
 * deadline the lookup resolves as undecided and the frame is refused without
 * counting an ownership violation.
 *
 * Cluster-global (every coordinator talks to the same database), so it lives on
 * `cluster_settings` rather than `org_settings`. NULL ⇒ the orchestrator's own
 * configured default applies.
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has the
 * column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'ownership_db_check_timeout_ms'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN ownership_db_check_timeout_ms BIGINT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ownership_db_check_timeout_ms`.execute(
    db,
  );
}
