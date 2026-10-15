import { type Kysely, sql } from 'kysely';

/**
 * Deadline for one DB-backed agent-ownership lookup, which runs inbound on every job-scoped
 * agent frame that misses the in-memory check. Past it the lookup is undecided and the frame
 * is refused without counting an ownership violation, so a slow DB cannot stall the frame.
 *
 * On `cluster_settings` because every coordinator shares the database. NULL ⇒ the
 * orchestrator's configured default.
 *
 * Idempotent: guarded on column existence.
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
