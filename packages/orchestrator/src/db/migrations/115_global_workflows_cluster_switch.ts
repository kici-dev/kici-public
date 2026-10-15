import { type Kysely, sql } from 'kysely';

/**
 * Moves the global-workflows master switch from `org_settings` to `cluster_settings`. Whether
 * any repo may register or dispatch a global workflow (one repo's workflow run on other repos'
 * events, optionally with elevated access to source-repo secrets) is an operator decision, so
 * it lives on the fleet-wide row `kici-admin cluster-settings` reaches, not a per-org row an
 * org admin flips from the dashboard.
 *
 * Deliberately NOT back-filled: copying any per-org opt-in forward would enable globals
 * fleet-wide for orgs whose operator never chose it. NULL resolves to
 * `KICI_GLOBAL_WORKFLOWS_ENABLED` (default false), so globals stay off until an operator runs:
 *
 *   kici-admin cluster-settings set --global-workflows-enabled true
 *
 * Nullable BOOLEAN, per the `NULL ⇒ configured default` contract of every `cluster_settings`
 * knob. Idempotent.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'cluster_settings', 'global_workflows_enabled'))) {
    await sql`ALTER TABLE public.cluster_settings ADD COLUMN global_workflows_enabled BOOLEAN`.execute(
      db,
    );
  }
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS global_workflows_enabled`.execute(
    db,
  );
}

/**
 * Restores the org column as NOT NULL DEFAULT false. The per-org values `up` dropped are
 * unrecoverable, so every org comes back at the opt-in default.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'org_settings', 'global_workflows_enabled'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN global_workflows_enabled BOOLEAN NOT NULL DEFAULT false
    `.execute(db);
  }
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS global_workflows_enabled`.execute(
    db,
  );
}
