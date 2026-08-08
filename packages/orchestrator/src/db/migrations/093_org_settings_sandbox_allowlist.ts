import { type Kysely, sql } from 'kysely';

/**
 * Add the per-org container-sandbox escape-hatch allow-list to `org_settings`:
 *
 * - `sandbox_allowed_capabilities TEXT[]` (nullable) — the Linux capabilities a
 *   workflow may request via the SDK `sandbox: { capabilities }` field. NULL /
 *   absent reads as `[]` (deny every capability request).
 * - `sandbox_allow_host_network BOOLEAN` (nullable) — whether a workflow may
 *   request `sandbox: { network: 'host' }`. NULL / absent reads as `false`
 *   (deny host networking).
 *
 * Both default to the safe deny-all posture with zero operator action; the
 * operator opts in per capability / for host networking via
 * `kici-admin org-settings sandbox-allowlist`.
 *
 * Idempotent: a re-run on a DB that already has a column skips that column.
 */
async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'sandbox_allowed_capabilities'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN sandbox_allowed_capabilities TEXT[]
    `.execute(db);
  }
  if (!(await columnExists(db, 'sandbox_allow_host_network'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN sandbox_allow_host_network BOOLEAN
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS sandbox_allowed_capabilities
  `.execute(db);
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS sandbox_allow_host_network
  `.execute(db);
}
