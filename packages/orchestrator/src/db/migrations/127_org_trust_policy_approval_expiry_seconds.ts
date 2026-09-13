import { type Kysely, sql } from 'kysely';

/**
 * Add `org_trust_policy.approval_expiry_seconds` (nullable INTEGER).
 *
 * The authoritative security-hold window, at the granularity the existing
 * `approval_expiry_hours` cannot express. Nullable rather than NOT NULL with a
 * default, and deliberately NOT backfilled: NULL means "no seconds value was
 * ever written", and every reader falls back to `approval_expiry_hours * 3600`
 * for such a row. A backfill would have to guess, and a NOT NULL default would
 * make a row written by an older build — which does not know the column —
 * silently claim the default window instead of the hours the operator set.
 *
 * The same shape `contexts.hold_expiry_seconds` already uses for the same
 * reason: "null = unset, the default window applies".
 *
 * `approval_expiry_hours` is kept. It is not dead — it is still the only window
 * an older peer can read, and it is still what a partial write supplies — so
 * dropping it would be a destructive schema change against a protected surface
 * and would break a rollback outright (the column is NOT NULL with no default).
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has
 * the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_trust_policy'
         AND column_name = 'approval_expiry_seconds'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.org_trust_policy ADD COLUMN approval_expiry_seconds INTEGER`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.org_trust_policy DROP COLUMN IF EXISTS approval_expiry_seconds`.execute(
    db,
  );
}
