import { type Kysely, sql } from 'kysely';

/**
 * Cold-store chunk counter table.
 *
 * Tracks per-(db, table, tenant) archived-chunk metadata so the
 * `cold_store_chunks_total` Prometheus gauge and the
 * `kici-admin cold-store list-chunks` CLI can report totals without
 * issuing S3 LIST calls (expensive + rate-limited).
 *
 * Phase A creates the table empty; the cold-store archiver
 * (Phase B+) updates it transactionally with every successful chunk
 * write via `INSERT ... ON CONFLICT (db, table_name, tenant_id) DO
 * UPDATE SET chunk_count = chunk_count + EXCLUDED.chunk_count, ...`.
 *
 * sections 5 and 8.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE public.cold_store_chunk_counts (
      db                TEXT        NOT NULL,
      table_name        TEXT        NOT NULL,
      tenant_id         TEXT        NOT NULL,
      chunk_count       BIGINT      NOT NULL DEFAULT 0,
      total_bytes       BIGINT      NOT NULL DEFAULT 0,
      total_rows        BIGINT      NOT NULL DEFAULT 0,
      last_archived_at  TIMESTAMPTZ,
      PRIMARY KEY (db, table_name, tenant_id)
    )
  `.execute(db);

  // Fast aggregation for the "by table" gauge.
  await sql`
    CREATE INDEX cold_store_chunk_counts_table_idx
      ON public.cold_store_chunk_counts (db, table_name)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.cold_store_chunk_counts`.execute(db);
}
