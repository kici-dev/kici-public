import { type Kysely, sql } from 'kysely';

/**
 * Add `org_trust_policy.approval_expiry_seconds` (nullable INTEGER).
 *
 * The authoritative security-hold window, finer than `approval_expiry_hours` can express.
 * Nullable and deliberately NOT backfilled: NULL means "no seconds value written", and readers
 * fall back to `approval_expiry_hours * 3600`. A backfill would guess, and a NOT NULL default
 * would make a row written by an older build silently claim the default window instead of the
 * operator's hours. `contexts.hold_expiry_seconds` uses the same shape for the same reason.
 *
 * `approval_expiry_hours` stays: it is the only window an older peer reads and what a partial
 * write supplies, and dropping it (NOT NULL, no default) would break a rollback outright.
 *
 * Idempotent: guarded on column existence.
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
