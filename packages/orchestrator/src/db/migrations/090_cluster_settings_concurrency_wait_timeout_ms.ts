import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.concurrency_wait_timeout_ms`: the fleet-wide agent concurrency-slot wait
 * timeout (ms), pushed to the agent on `job.dispatch`. NULL is the cluster default
 * (`config.concurrencyWaitTimeoutMs`, `KICI_CONCURRENCY_WAIT_TIMEOUT_MS`). Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'concurrency_wait_timeout_ms'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN concurrency_wait_timeout_ms BIGINT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS concurrency_wait_timeout_ms`.execute(
    db,
  );
}
