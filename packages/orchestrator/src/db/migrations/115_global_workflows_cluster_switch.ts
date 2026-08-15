import { type Kysely, sql } from 'kysely';

/**
 * Move the global-workflows master switch from `org_settings` to
 * `cluster_settings`.
 *
 * The switch decides whether any repo may register or dispatch a global
 * workflow — a workflow defined in one repo that runs against events emitted by
 * other repos in the org, optionally with elevated access to source-repo
 * secrets. That is an operator-held decision, so it belongs on the fleet-wide
 * row an operator reaches through `kici-admin cluster-settings`, not on a
 * per-org row an org admin can flip from the dashboard.
 *
 * Deliberately NOT back-filled. Copying `EXISTS(SELECT 1 FROM org_settings
 * WHERE global_workflows_enabled)` into the new column would silently carry a
 * per-org opt-in forward into a fleet-wide one — enabling globals for orgs
 * whose operator never chose it. The new column starts NULL, which resolves to
 * the orchestrator's configured default (`KICI_GLOBAL_WORKFLOWS_ENABLED`,
 * default false), so global workflows are off until an operator opts in:
 *
 *   kici-admin cluster-settings set --global-workflows-enabled true
 *
 * BOOLEAN and nullable, matching the `NULL ⇒ configured default` contract every
 * other `cluster_settings` knob follows.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
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
 * Restores the org column with its original NOT NULL DEFAULT false. A rollback
 * cannot recover the per-org values the up-migration dropped — they are gone —
 * so every org comes back at the opt-in default.
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
