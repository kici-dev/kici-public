import { type Kysely, sql } from 'kysely';

/**
 * Trigram (pg_trgm) index on access_log.error_message for the federated
 * Activity page's full-text search (`q` parameter).
 *
 * Matches the Platform counterpart in `008_audit_log_trigram.ts` which
 * indexes `audit_log.details::text`.
 *
 * Idempotent: `CREATE EXTENSION IF NOT EXISTS` and `CREATE INDEX IF NOT
 * EXISTS` are both safe to re-run. No CONCURRENTLY because Kysely runs
 * migrations inside a transaction; the lock is brief on a sampled table.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS access_log_error_message_trgm_idx
      ON public.access_log
      USING gin (error_message gin_trgm_ops)
      WHERE error_message IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.access_log_error_message_trgm_idx`.execute(db);
}
