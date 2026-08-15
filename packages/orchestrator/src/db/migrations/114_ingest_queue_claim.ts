import { type Kysely, sql } from 'kysely';

/**
 * Claim bookkeeping for the durable ingest queue.
 *
 * Two additive, nullable columns:
 *
 * - `ingest_overflow_buffer.claimed_at` — when a row moved `buffered` →
 *   `replaying`. A worker that dies mid-pipeline leaves its row in `replaying`
 *   with nothing to move it back, so the drain pass reclaims a row whose claim
 *   is older than the timeout below. The claim clock has to be its own column:
 *   `captured_at` orders the FIFO drain, so an old row picked up first would
 *   read as instantly stale and be reclaimed out from under a live worker.
 * - `cluster_settings.ingest_overflow_claim_timeout_ms` — how long a claim may
 *   stand before the drain pass reclaims it. NULL means the orchestrator's
 *   configured default applies. It must exceed the longest a single delivery's
 *   pipeline can legitimately run (a build phase alone is capped at
 *   `cacheBuildTimeoutMs`), or a reclaim would re-run work still in flight.
 *
 * Idempotent: each column is guarded on existence, so a re-run is a no-op.
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
