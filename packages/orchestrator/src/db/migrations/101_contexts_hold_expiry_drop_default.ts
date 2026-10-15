import { type Kysely, sql } from 'kysely';

/**
 * Give the context hold expiry a single default, and retire the stored zeroes.
 *
 * `contexts.hold_expiry_seconds` carried `DEFAULT 86400` while read-side
 * fallbacks and the docs used 3600 (24 h when created without an expiry, 1 h
 * when cleared). Dropping the DDL default, rather than moving it to 3600, sends
 * both paths to NULL and `DEFAULT_HOLD_EXPIRY_SECONDS`, so they cannot drift.
 *
 * The backfill pairs with rejecting a zero expiry at the write boundary: a
 * stored `0` puts every hold's deadline at now, so it expires before a reviewer
 * can act. Validation stops only new zeroes, and no CLI path surfaces old ones.
 *
 * Idempotent: dropping an absent default is a no-op and the UPDATE matches no
 * rows on a second run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.contexts ALTER COLUMN hold_expiry_seconds DROP DEFAULT`.execute(db);
  await sql`UPDATE public.contexts SET hold_expiry_seconds = NULL WHERE hold_expiry_seconds = 0`.execute(
    db,
  );
}

/**
 * Restore the column's original default.
 *
 * Deliberately asymmetric: zeroed rows are NOT recreated. They now look like a
 * deliberate NULL, and a `0` would resume cancelling every hold on its context.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.contexts ALTER COLUMN hold_expiry_seconds SET DEFAULT 86400`.execute(
    db,
  );
}
