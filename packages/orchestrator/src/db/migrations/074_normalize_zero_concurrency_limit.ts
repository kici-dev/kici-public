import { type Kysely, sql } from 'kysely';

/**
 * Normalize degenerate context concurrency limits. A `concurrency_limit` of 0
 * (or any non-positive value) is meaningless — it wedged the workflow-install
 * gate into an unreleasable concurrency hold. The write boundary now rejects it
 * and the gate treats it as unlimited; this migration cleans up any pre-existing
 * rows so the column only ever holds NULL (unlimited) or a positive integer.
 * Idempotent; down() is a no-op (a normalized 0 cannot — and should not — be
 * restored).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE public.contexts SET concurrency_limit = NULL WHERE concurrency_limit <= 0`.execute(
    db,
  );
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op: a normalized 0 cannot be restored, and reintroducing a degenerate
  // value would reopen the unreleasable-hold bug.
}
