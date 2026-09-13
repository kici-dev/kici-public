import { type Kysely, sql } from 'kysely';

/**
 * Add the nullable `org_settings.backup_staleness_warn_hours INTEGER` column:
 * the per-org override for the DB-backup freshness diagnostic's WARN threshold.
 * NULL falls back to the cluster default (`config.backupStalenessWarnHours`,
 * 24h). Operators tune it per-org via `kici-admin org-settings backup-freshness`.
 *
 * Idempotent: guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'backup_staleness_warn_hours'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN backup_staleness_warn_hours INTEGER
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS backup_staleness_warn_hours
  `.execute(db);
}
