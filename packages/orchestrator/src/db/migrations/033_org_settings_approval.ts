import { type Kysely, sql } from 'kysely';

/**
 * Add the approval-policy columns to `org_settings`:
 *
 * - `approval_expiry_seconds INTEGER NOT NULL DEFAULT 86400` — how long a held
 *   approval element waits before it expires and its run/job/step is rejected.
 *   An SDK `requireApproval` `timeout` overrides it per element.
 * - `allow_self_approval BOOLEAN NOT NULL DEFAULT true` — whether a run's
 *   triggering user may approve its held elements; off enforces four-eyes review.
 *
 * Set per org via `kici-admin org-settings approval` and the orchestrator admin
 * route. Idempotent: each column is guarded independently.
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
