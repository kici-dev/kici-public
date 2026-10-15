import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.backup_staleness_warn_hours`: the per-org WARN threshold for the DB-backup
 * freshness diagnostic, set via `kici-admin org-settings backup-freshness`. NULL is the cluster
 * default (`config.backupStalenessWarnHours`, 24h). Idempotent.
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
