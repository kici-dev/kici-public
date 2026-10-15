import { type Kysely, sql } from 'kysely';

/**
 * Lease + retry + DLQ columns on `kici_events`, so the EventRouter delivers
 * events at-least-once with bounded retries and a visible dead-letter queue.
 * Marking a row processed before dispatch lost the event when
 * `onEventMatched` threw, and a crash between the cron fire claim and the
 * event write advanced `cron_last_fired.last_fired_at` with no event row.
 *
 *  - `claimed_at`, `claimed_by`: a lease taken on dispatch, released on
 *    success (processed=true) or failure (cleared + retry scheduled).
 *  - `attempts`: incremented per lease attempt; bounds retries.
 *  - `last_error`: latest dispatch failure (truncated by the app to 4 KB).
 *  - `next_retry_at`: earliest moment the leader-only retry scanner
 *    re-publishes `pg_notify` for this event.
 *  - `dlq_at`, `dlq_reason`: terminal DLQ marker; a row with
 *    `dlq_at IS NOT NULL` is never leased or retried again. Shown on the
 *    dashboard admin DLQ page.
 *
 * Partial indexes skip the hot-path processed=true rows. Idempotent.
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
