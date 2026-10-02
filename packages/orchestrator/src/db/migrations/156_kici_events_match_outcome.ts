import { type Kysely, sql } from 'kysely';

/**
 * Record how the event router resolved each internal event:
 *
 * - `match_outcome TEXT` — `matched`, `buffered`, `no-registration`,
 *   `no-target-repo`, `trust-blocked` or `no-trigger-match`.
 * - `matched_count INTEGER` — how many registrations the event was dispatched to.
 *
 * Both are written when the event is processed and are NULL before that, and
 * for rows processed before these columns existed. Nullable with no default,
 * so the ALTER is catalog-only on a large table.
 *
 * Idempotent: `ADD COLUMN IF NOT EXISTS`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.kici_events
              ADD COLUMN IF NOT EXISTS match_outcome TEXT,
              ADD COLUMN IF NOT EXISTS matched_count INTEGER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.kici_events
              DROP COLUMN IF EXISTS match_outcome,
              DROP COLUMN IF EXISTS matched_count`.execute(db);
}
