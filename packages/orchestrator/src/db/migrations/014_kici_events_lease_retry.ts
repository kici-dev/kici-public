import { type Kysely, sql } from 'kysely';

/**
 * Add lease + retry + DLQ columns to `kici_events` so the EventRouter can
 * deliver events at-least-once with bounded retries and a visible
 * dead-letter queue.
 *
 * Before this migration, EventRouter used `claimForProcessing` (UPDATE
 * processed=true WHERE processed=false RETURNING *) and dispatched after
 * the row was already marked processed. If `onEventMatched` threw, the
 * event was silently lost. Same loss surface for cron fires, since
 * `tryClaimFire` and `eventStore.write` were two separate transactions:
 * a crash between them advanced `cron_last_fired.last_fired_at` without
 * persisting the event row.
 *
 * After this migration:
 *  - `claimed_at`, `claimed_by`: lease-based claim. Replaces the
 *    "flip processed=true upfront" pattern. A lease is taken on dispatch,
 *    released on success (processed=true) or failure (cleared + retry scheduled).
 *  - `attempts`: incremented on each lease attempt. Enables bounded retry.
 *  - `last_error`: most recent dispatch failure message (truncated by
 *    application code to 4 KB).
 *  - `next_retry_at`: earliest moment the leader-only retry scanner should
 *    re-publish `pg_notify` for this event.
 *  - `dlq_at`, `dlq_reason`: terminal DLQ marker. Once `dlq_at IS NOT NULL`
 *    the row is no longer eligible for lease/retry. Surfaced in the
 *    dashboard admin DLQ page.
 *
 * Partial indexes keep these new lookups cheap without blowing up the index
 * size on the hot path (most rows are processed=true and irrelevant to the
 * scanner).
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.kici_events
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS claimed_by TEXT,
      ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_error TEXT,
      ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dlq_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dlq_reason TEXT
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_kici_events_retry_due
      ON public.kici_events (next_retry_at)
      WHERE processed = false
        AND dlq_at IS NULL
        AND next_retry_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_kici_events_lease_expired
      ON public.kici_events (claimed_at)
      WHERE processed = false
        AND dlq_at IS NULL
        AND claimed_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_kici_events_dlq
      ON public.kici_events (dlq_at DESC)
      WHERE dlq_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_kici_events_dlq`.execute(db);
  await sql`DROP INDEX IF EXISTS public.idx_kici_events_lease_expired`.execute(db);
  await sql`DROP INDEX IF EXISTS public.idx_kici_events_retry_due`.execute(db);
  await sql`
    ALTER TABLE public.kici_events
      DROP COLUMN IF EXISTS dlq_reason,
      DROP COLUMN IF EXISTS dlq_at,
      DROP COLUMN IF EXISTS next_retry_at,
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS claimed_by,
      DROP COLUMN IF EXISTS claimed_at
  `.execute(db);
}
