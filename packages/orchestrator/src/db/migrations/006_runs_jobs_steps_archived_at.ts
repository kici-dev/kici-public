import { type Kysely, sql } from 'kysely';

/**
 * `execution_runs` / `execution_jobs` / `execution_steps` cold-store
 * schema additions.
 *
 * Phase C of the cold-storage archival system. See
 *
 * Each table gets `archived_at TIMESTAMPTZ NULL` and
 * `archive_object_key TEXT NULL` (set inside the archive tx before the
 * DELETE; survivors carry NULL — same pattern as Phase B's migration
 * 004 for `run_events`).
 *
 * Tenant column denormalization: the orchestrator side partitions by
 * `routing_key`, but only `execution_runs` carries the column today.
 * `execution_jobs` and `execution_steps` reference the run by `run_id`
 * and would otherwise need a 3-table JOIN at every archive cycle. We
 * denormalize `routing_key` onto both tables and backfill from the
 * existing run rows. Backfill is one-shot inside this migration. New
 * inserts must populate the column going forward (enforced at the
 * application layer in the same phase).
 *
 * The denormalized column is left NULLable for safety: if an insert
 * site is missed in the rollout, the row still lands in PG; the
 * cold-store adapter's `listEligiblePartitions` skips NULLs (no
 * tenant ⇒ no archive). A follow-up migration may tighten to NOT NULL
 * once we're confident every insert site is updated.
 *
 * Composite indexes added for the archiver's
 * `listEligiblePartitions` discovery query
 * (`GROUP BY routing_key, DATE(created_at)`):
 *
 *   - `idx_execution_runs_routing_key_created  (routing_key, created_at)`
 *   - `idx_execution_jobs_routing_key_created  (routing_key, created_at)`
 *   - `idx_execution_steps_routing_key_created (routing_key, created_at)`
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
