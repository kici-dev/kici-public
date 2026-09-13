import { type Kysely, sql } from 'kysely';

/**
 * Add the `attestations` table for build-provenance bundles.
 *
 * When a workflow step calls `ctx.attestProvenance`, the agent uploads the
 * signed KiCI bundle to object storage under
 * `provenance/{run_id}/{job_id}/{subject_digest}.kici.json` and the
 * orchestrator records one row here so the dashboard can list and fetch
 * attestations per run/job.
 *
 * Idempotent: a re-run on a DB that already has the table is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'attestations'
    ) AS exists
  `.execute(db);
  if (tableCheck.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.attestations (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      job_id          TEXT NOT NULL,
      subject_name    TEXT NOT NULL,
      subject_digest  TEXT NOT NULL,
      storage_key     TEXT NOT NULL,
      mode            TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_attestations_run_job
      ON public.attestations (run_id, job_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.attestations`.execute(db);
}
