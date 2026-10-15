import { type Kysely, sql } from 'kysely';

/**
 * Batch-accumulation tables behind the `workflows_failed_batch` trigger.
 *
 * A `workflow_complete(failed)` event matching a `workflowsFailedBatch` registration buffers
 * the run into a durable window; the first failure opens it. The Raft-leader-only scanner
 * sweeps windows past `expires_at`, emits one `__workflows_failed_batch` event with the
 * buffered runs, and deletes the window (cascading its items).
 *
 * `UNIQUE(registration_id)` enforces one open window per subscribing workflow, so concurrent
 * failures append rather than open N windows. `routing_key` / `repo_identifier` are captured
 * at open time so the sweep need not re-read the registration index.
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'batch_accumulation_windows'
    ) AS exists
  `.execute(db);
  if (exists.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.batch_accumulation_windows (
      id                UUID PRIMARY KEY,
      customer_id       TEXT NOT NULL,
      registration_id   TEXT NOT NULL,
      routing_key       TEXT NOT NULL,
      repo_identifier   TEXT NOT NULL,
      accumulate_for_ms INTEGER NOT NULL,
      opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL
    )
  `.execute(db);

  // Open-once: at most one live window per subscribing registration.
  await sql`
    CREATE UNIQUE INDEX uq_batch_accumulation_windows_registration
      ON public.batch_accumulation_windows (registration_id)
  `.execute(db);
  // The leader sweep scans windows past their deadline.
  await sql`
    CREATE INDEX idx_batch_accumulation_windows_expires_at
      ON public.batch_accumulation_windows (expires_at)
  `.execute(db);

  await sql`
    CREATE TABLE public.batch_accumulation_items (
      id              UUID PRIMARY KEY,
      window_id       UUID NOT NULL
                        REFERENCES public.batch_accumulation_windows (id) ON DELETE CASCADE,
      run_id          TEXT NOT NULL,
      repo_identifier TEXT NOT NULL,
      workflow_name   TEXT NOT NULL,
      failure_class   TEXT,
      sender_username TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_batch_accumulation_items_window
      ON public.batch_accumulation_items (window_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.batch_accumulation_items`.execute(db);
  await sql`DROP TABLE IF EXISTS public.batch_accumulation_windows`.execute(db);
}
