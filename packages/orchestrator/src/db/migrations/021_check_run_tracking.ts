import { type Kysely, sql } from 'kysely';

/**
 * `check_run_tracking`: `CheckRunReporter` state keyed per (provider, owner, repo, sha,
 * check_name). Per-process maps reset on a replacement coord (Raft leader switch / coord crash)
 * and left GitHub check runs stuck in `queued` forever. `run_id` is indexed for cleanup.
 *
 * Progress-timer debounce state is NOT persisted: a timer is recreated when an update arrives
 * and the row's `updated_at` is older than the debounce window.
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

  await sql`
    CREATE INDEX idx_check_run_tracking_run_id
      ON public.check_run_tracking (run_id)
      WHERE run_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.check_run_tracking`.execute(db);
}
