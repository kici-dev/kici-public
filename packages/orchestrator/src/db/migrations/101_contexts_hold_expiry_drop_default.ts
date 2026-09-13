import { type Kysely, sql } from 'kysely';

/**
 * Give the context hold expiry a single default, and retire the stored zeroes.
 *
 * `contexts.hold_expiry_seconds` carried `DEFAULT 86400` while every read-side
 * fallback and the operator docs used 3600 — so a context created without an
 * expiry held for 24 h, and one whose expiry was cleared held for 1 h. Dropping
 * the DDL default (rather than moving it to 3600) makes both paths land on NULL
 * and resolve through `DEFAULT_HOLD_EXPIRY_SECONDS`, so the two cannot drift
 * apart again.
 *
 * The backfill is the other half of rejecting a zero expiry at the write
 * boundary: a stored `0` puts every hold's deadline at the current instant, so
 * the hold is swept to `expired` before a reviewer can act. Validation alone
 * only stops new zeroes arriving; these rows already exist and there was no CLI
 * path to notice them.
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
 * Deliberately asymmetric: the zeroed rows are NOT recreated. After the
 * backfill they are indistinguishable from a deliberate NULL, and a row put
 * back to `0` would resume cancelling every hold on its context — so a
 * rollback keeps them on the fallback rather than re-breaking them.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.contexts ALTER COLUMN hold_expiry_seconds SET DEFAULT 86400`.execute(
    db,
  );
}
