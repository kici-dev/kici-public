import { type Kysely, sql } from 'kysely';

/**
 * Durable overflow buffer for shed webhook-ingest deliveries.
 *
 * When the ingest admission controller sheds a delivery (429 / shed_retry_later),
 * the ingest path additively persists it here. A background replayer re-injects
 * the oldest `buffered` rows through normal ingest once capacity recovers.
 *
 * `status` is constrained to the OverflowStatus enum; `source_kind` to
 * OverflowSourceKind. The `(status, captured_at)` index backs the FIFO drain.
 *
 * Idempotent: a re-run on a DB that already has the table is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'ingest_overflow_buffer'
    ) AS exists
  `.execute(db);
  if (tableCheck.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.ingest_overflow_buffer (
      id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      delivery_id     TEXT        NOT NULL,
      routing_key     TEXT        NOT NULL,
      source_kind     TEXT        NOT NULL,
      provider        TEXT,
      event           TEXT        NOT NULL,
      action          TEXT,
      body            TEXT        NOT NULL,
      meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      replay_attempts INTEGER     NOT NULL DEFAULT 0,
      status          TEXT        NOT NULL DEFAULT 'buffered',
      last_error      TEXT
    )
  `.execute(db);

  await sql`
    CREATE INDEX ingest_overflow_buffer_status_captured_idx
      ON public.ingest_overflow_buffer (status, captured_at)
  `.execute(db);

  await sql`
    CREATE INDEX ingest_overflow_buffer_delivery_idx
      ON public.ingest_overflow_buffer (delivery_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.ingest_overflow_buffer`.execute(db);
}
