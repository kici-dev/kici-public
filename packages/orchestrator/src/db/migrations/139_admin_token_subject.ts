import { type Kysely, sql } from 'kysely';

/**
 * Add `admin_tokens.subject TEXT`, nullable.
 *
 * `label` is free text and `role` says what a token may do, not who holds it,
 * so the two-layer RBAC guide's advice (one token per engineer, match the
 * orchestrator role to the dashboard role, revoke both on departure) needs a
 * holder field to be expressible.
 *
 * `subject` is the intended holder as the operator states it: an OIDC `sub`
 * or an email. The orchestrator cannot verify it and never treats it as an
 * authorization input; it is the join key the Platform's RBAC drift report
 * uses to compare a token against the org's dashboard membership.
 *
 * Nullable, no default, deliberately NOT backfilled: NULL is the `unlinked`
 * finding the report surfaces, and a token minted before this column has no
 * recorded holder. Idempotent.
 */
const COLUMN = 'subject';

export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'admin_tokens'
         AND column_name = ${COLUMN}
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.admin_tokens
      ADD COLUMN ${sql.raw(COLUMN)} TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.admin_tokens DROP COLUMN IF EXISTS ${sql.raw(COLUMN)}
  `.execute(db);
}
