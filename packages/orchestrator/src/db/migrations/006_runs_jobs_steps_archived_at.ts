import { type Kysely, sql } from 'kysely';

/**
 * Cold-store columns for `execution_runs` / `execution_jobs` / `execution_steps`.
 *
 * Each table gets `archived_at` and `archive_object_key` (both NULL), set inside the archive tx
 * before the DELETE; survivors carry NULL, as `run_events` does in the Platform's schema.
 *
 * The archiver partitions by `routing_key`, which only `execution_runs` carried; jobs and steps
 * get it denormalized (avoiding a 3-table JOIN per archive cycle) with a one-shot backfill from
 * their runs. New inserts must populate it (enforced at the application layer). It stays
 * NULLable so a missed insert site still lands; `listEligiblePartitions` skips NULL tenants.
 *
 * The `(routing_key, created_at)` indexes serve the archiver's `listEligiblePartitions` query
 * (`GROUP BY routing_key, DATE(created_at)`).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── execution_runs ─────────────────────────────────────────────
  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runs_routing_key_created
      ON public.execution_runs (routing_key, created_at)
  `.execute(db);

  // ── execution_jobs ─────────────────────────────────────────────
  await sql`
    ALTER TABLE public.execution_jobs
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL,
      ADD COLUMN routing_key         TEXT        NULL
  `.execute(db);

  // One-shot backfill from execution_runs.run_id → routing_key.
  await sql`
    UPDATE public.execution_jobs AS j
    SET    routing_key = r.routing_key
    FROM   public.execution_runs AS r
    WHERE  r.run_id = j.run_id
      AND  j.routing_key IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_jobs_routing_key_created
      ON public.execution_jobs (routing_key, created_at)
  `.execute(db);

  // ── execution_steps ────────────────────────────────────────────
  await sql`
    ALTER TABLE public.execution_steps
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL,
      ADD COLUMN routing_key         TEXT        NULL
  `.execute(db);

  await sql`
    UPDATE public.execution_steps AS s
    SET    routing_key = r.routing_key
    FROM   public.execution_runs AS r
    WHERE  r.run_id = s.run_id
      AND  s.routing_key IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_steps_routing_key_created
      ON public.execution_steps (routing_key, created_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_execution_steps_routing_key_created`.execute(db);
  await sql`
    ALTER TABLE public.execution_steps
      DROP COLUMN IF EXISTS routing_key,
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);

  await sql`DROP INDEX IF EXISTS public.idx_execution_jobs_routing_key_created`.execute(db);
  await sql`
    ALTER TABLE public.execution_jobs
      DROP COLUMN IF EXISTS routing_key,
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);

  await sql`DROP INDEX IF EXISTS public.idx_execution_runs_routing_key_created`.execute(db);
  await sql`
    ALTER TABLE public.execution_runs
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);
}
