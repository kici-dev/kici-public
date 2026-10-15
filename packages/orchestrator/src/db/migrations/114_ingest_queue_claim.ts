import { type Kysely, sql } from 'kysely';

/**
 * Claim bookkeeping for the durable ingest queue.
 *
 * - `ingest_overflow_buffer.claimed_at` — when a row moved `buffered` → `replaying`. A worker
 *   that dies mid-pipeline strands its row in `replaying`, so the drain pass reclaims claims
 *   older than the timeout below. It must be its own clock: `captured_at` orders the FIFO
 *   drain, so an old row would read as instantly stale and be reclaimed from a live worker.
 * - `cluster_settings.ingest_overflow_claim_timeout_ms` — that timeout; NULL → the configured
 *   default. It must exceed the longest legitimate pipeline run (a build phase alone is capped
 *   at `cacheBuildTimeoutMs`), or a reclaim re-runs in-flight work.
 *
 * Idempotent: each column is guarded on existence.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'ingest_overflow_buffer', 'claimed_at'))) {
    await sql`ALTER TABLE public.ingest_overflow_buffer ADD COLUMN claimed_at TIMESTAMPTZ`.execute(
      db,
    );
  }
  if (!(await columnExists(db, 'cluster_settings', 'ingest_overflow_claim_timeout_ms'))) {
    await sql`
      ALTER TABLE public.cluster_settings ADD COLUMN ingest_overflow_claim_timeout_ms INTEGER
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ingest_overflow_claim_timeout_ms
  `.execute(db);
  await sql`
    ALTER TABLE public.ingest_overflow_buffer DROP COLUMN IF EXISTS claimed_at
  `.execute(db);
}
