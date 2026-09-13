import { type Kysely, sql } from 'kysely';

/**
 * Cold-store chunk index — Phase 2 (cold-store purge).
 *
 * One row per archived chunk that the GC sweep can later purge from S3.
 * Inserted inside the same transaction as `markArchivedAndDelete` so a
 * chunk is either fully recorded (S3 + index + rollup + audit) or fully
 * absent (no orphan rows).
 *
 * Schema notes:
 *
 * - `chunk_id` is the deterministic 16-hex chunk filename stem; primary
 *   key is `(db, table_name, chunk_id)` so the framework can `DELETE`
 *   without scanning. The `db` column matches `cold_store_chunk_counts`
 *   (always `'orchestrator'` here, included for shape parity with the
 *   Platform-side migration).
 * - `bucket` is the S3 prefix segment (`'30d'` / `'180d'` / `'1y'` /
 *   `'2y'` / `'forever'`). Carried for `cold-store list-chunks` /
 *   `list-purgeable` filtering.
 * - `max_cold_days` is the row-level retention horizon — TEXT to
 *   accommodate both numeric values and the literal `'forever'`. The
 *   GC sweep checks `max_cold_days != 'forever' AND now() > archived_at
 *   + (max_cold_days || ' days')::interval`.
 * - `object_key` is the full S3 key of the data chunk; the GC sweep
 *   uses this to issue `DeleteObject` directly without recomputing the
 *   key from the prefix.
 *
 * Pre-Phase-2 chunks (v1 manifest) are NOT in this table — they live
 * forever. Adapters that don't opt into per-bucket archival via
 * `coldTtlDays` don't insert here either.
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

  // Purge-sweep predicate covers: (table_name, max_cold_days != 'forever',
  // archived_at). Partial index excludes 'forever' rows entirely so the
  // sweep scans only what it can purge.
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
