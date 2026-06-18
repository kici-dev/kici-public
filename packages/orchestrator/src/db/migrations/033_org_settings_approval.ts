import { type Kysely, sql } from 'kysely';

/**
 * Add the two approval-policy columns to `org_settings`:
 *
 * - `approval_expiry_seconds INTEGER NOT NULL DEFAULT 86400` — how long a held
 *   approval element waits before it expires (and its run/job/step is
 *   rejected). One day by default. An SDK `requireApproval` `timeout` overrides
 *   this per element; otherwise this per-org value applies.
 * - `allow_self_approval BOOLEAN NOT NULL DEFAULT true` — whether the user who
 *   triggered a run may also approve its held elements. Operators turn it off
 *   to enforce four-eyes review.
 *
 * Both are cluster-configurable per org via `kici-admin org-settings approval`
 * and the orchestrator admin route. Idempotent: a re-run on a DB that already
 * has the columns is a no-op (each column is guarded independently).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colExists = async (column: string): Promise<boolean> => {
    const res = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'org_settings'
           AND column_name = ${column}
      ) AS exists
    `.execute(db);
    return res.rows[0]?.exists ?? false;
  };

  if (!(await colExists('approval_expiry_seconds'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN approval_expiry_seconds INTEGER NOT NULL DEFAULT 86400
    `.execute(db);
  }

  if (!(await colExists('allow_self_approval'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN allow_self_approval BOOLEAN NOT NULL DEFAULT true
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS approval_expiry_seconds
  `.execute(db);
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS allow_self_approval
  `.execute(db);
}
