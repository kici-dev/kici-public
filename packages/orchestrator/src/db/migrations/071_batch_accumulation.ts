import { type Kysely, sql } from 'kysely';

/**
 * Add the batch-accumulation tables that back the `workflows_failed_batch`
 * trigger.
 *
 * When a `workflow_complete(failed)` event matches a `workflowsFailedBatch`
 * registration, the orchestrator buffers the failed run into a durable window
 * instead of dispatching now. The first failure opens the window (`opened_at`);
 * the Raft-leader-only scanner sweeps windows past `expires_at`, emits one
 * `__workflows_failed_batch` event carrying the buffered runs, and deletes the
 * window (cascading its items).
 *
 * `batch_accumulation_windows` holds one open window per subscribing workflow —
 * `UNIQUE(registration_id)` enforces open-once so concurrent failures append to
 * the same window rather than opening N of them. `routing_key` /
 * `repo_identifier` are captured at open time so the leader sweep can emit the
 * batch event without re-reading the registration index.
 *
 * `batch_accumulation_items` holds the buffered failed runs, deleted with their
 * window via `ON DELETE CASCADE`.
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
