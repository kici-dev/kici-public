import { type Kysely, sql } from 'kysely';

/**
 * Normalize non-positive `concurrency_limit` values, which wedge the workflow-install gate in
 * an unreleasable hold, to NULL, so the column holds only NULL (unlimited) or a positive
 * integer. The write boundary rejects them and the gate treats them as unlimited.
 * Idempotent; down() is a no-op.
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
