import { type Kysely, sql } from 'kysely';

/**
 * Cold-store chunk index: one row per archived chunk the GC sweep can later
 * purge from S3. Written in the `markArchivedAndDelete` transaction, so a chunk
 * is fully recorded (S3 + index + rollup + audit) or fully absent.
 *
 * - `chunk_id` is the deterministic 16-hex chunk filename stem; the primary key
 *   `(db, table_name, chunk_id)` lets the framework `DELETE` without scanning.
 *   `db` is always `'orchestrator'` here, for shape parity with
 *   `cold_store_chunk_counts` and the Platform-side migration.
 * - `bucket` is the S3 prefix segment (`'30d'` / `'180d'` / `'1y'` / `'2y'` /
 *   `'forever'`), for `cold-store list-chunks` / `list-purgeable` filtering.
 * - `max_cold_days` is the row-level retention horizon, TEXT to hold numbers
 *   and `'forever'`. The GC sweep checks `max_cold_days != 'forever' AND
 *   now() > archived_at + (max_cold_days || ' days')::interval`.
 * - `object_key` is the chunk's full S3 key, so the GC sweep calls
 *   `DeleteObject` without recomputing it.
 *
 * V1-manifest chunks are NOT here — they live forever — nor are chunks from
 * adapters that do not opt into per-bucket archival via `coldTtlDays`.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE public.cold_store_chunks (
      db              TEXT        NOT NULL,
      table_name      TEXT        NOT NULL,
      tenant_id       TEXT        NOT NULL,
      chunk_id        TEXT        NOT NULL,
      bucket          TEXT        NOT NULL,
      partition_date  DATE        NOT NULL,
      archived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      gzip_bytes      BIGINT      NOT NULL,
      row_count       BIGINT      NOT NULL,
      max_cold_days   TEXT        NOT NULL,
      object_key      TEXT        NOT NULL,
      PRIMARY KEY (db, table_name, chunk_id)
    )
  `.execute(db);

  // Partial index for the purge sweep: excluding 'forever' rows means it scans
  // only what it can purge.
  await sql`
    CREATE INDEX cold_store_chunks_purge_idx
      ON public.cold_store_chunks (table_name, archived_at)
      WHERE max_cold_days != 'forever'
  `.execute(db);

  // For per-tenant CLI listings (`cold-store list-chunks --tenant X`).
  await sql`
    CREATE INDEX cold_store_chunks_tenant_idx
      ON public.cold_store_chunks (db, table_name, tenant_id, archived_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.cold_store_chunks`.execute(db);
}
