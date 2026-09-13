import { type Kysely, sql } from 'kysely';

/**
 * Add `admin_tokens.subject TEXT`, nullable.
 *
 * `admin_tokens` had no field tying a token to a person: `label` is free text
 * and `role` says what the token may do, not who holds it. So the operational
 * advice in the two-layer RBAC guide — one token per engineer, match the
 * orchestrator role to the dashboard role, revoke both on departure — was not
 * merely unchecked, it was not expressible.
 *
 * `subject` records the intended holder as the operator states it: an OIDC
 * `sub` or an email. The orchestrator cannot verify it and never treats it as
 * an authorization input; it is the join key the Platform's RBAC drift report
 * uses to compare a token against the org's dashboard membership.
 *
 * Nullable, no default, and deliberately NOT backfilled. NULL is the
 * `unlinked` finding the report exists to surface: every token minted before
 * this column existed genuinely has no recorded holder, and inventing one
 * would hide exactly the condition an operator needs to see.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so
 * a re-run is a no-op.
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
