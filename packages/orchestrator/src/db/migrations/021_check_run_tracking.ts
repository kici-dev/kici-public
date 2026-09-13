import { type Kysely, sql } from 'kysely';

/**
 * Add `check_run_tracking` table for HA-safe check-run state persistence.
 *
 * The `CommitStatusReporter` previously held all of its check-run bookkeeping
 * in per-process `Map`s. Under HA (Raft leader switch / coord crash) those
 * maps reset to empty on the replacement coord, leaving GitHub check runs
 * stuck in `queued` forever.
 *
 * Single composite-keyed table per (provider, owner, repo, sha, check_name):
 *
 *   - `check_run_id`            replaces in-memory `checkRunIds`.
 *   - `build_creation_state`    replaces `pendingBuildCreations` Promise map.
 *   - `step_progress_json`      replaces `stepProgress` array map.
 *   - `in_progress_sent_at`     replaces `inProgressSent` boolean map.
 *   - `run_id`                  indexed; replaces `runIdToKeys` reverse map.
 *
 * Progress-timer debounce state (the `progressTimers` Map) is NOT persisted —
 * timers are recreated on demand when an update arrives and the row's
 * `updated_at` is older than the debounce window.
 *
 * Idempotent: a re-run on a DB that already has the table is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'check_run_tracking'
    ) AS exists
  `.execute(db);
  if (tableCheck.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.check_run_tracking (
      provider              TEXT NOT NULL,
      owner                 TEXT NOT NULL,
      repo                  TEXT NOT NULL,
      sha                   TEXT NOT NULL,
      check_name            TEXT NOT NULL,
      check_run_id          BIGINT,
      build_creation_state  TEXT,
      step_progress_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
      in_progress_sent_at   TIMESTAMPTZ,
      run_id                TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, owner, repo, sha, check_name)
    )
  `.execute(db);

  // Index for cleanup-by-run-id (replaces the runIdToKeys reverse map).
  await sql`
    CREATE INDEX idx_check_run_tracking_run_id
      ON public.check_run_tracking (run_id)
      WHERE run_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.check_run_tracking`.execute(db);
}
