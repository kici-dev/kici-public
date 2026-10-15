import { type Kysely, sql } from 'kysely';

/**
 * The `pending_attestations` deferred-attestation outbox, plus an idempotency unique index on
 * `attestations`.
 *
 * When a provenance mint fails transiently, the agent freezes and DSSE-signs the statement at
 * build time, and the orchestrator records the envelope here instead of failing the job. A
 * Raft-leader-only retrier later mints the token, uploads the bundle, records one
 * `attestations` row and deletes the pending row; the `(run_id, job_id, subject_digest)` unique
 * index makes that idempotent across a cluster (ON CONFLICT DO NOTHING).
 *
 * `origin_kind` holds the non-`live` `AttestationOrigin` values (`deferred` /
 * `offline-backfill`); `created_at` anchors the true build time across a later mint.
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'pending_attestations'
    ) AS exists
  `.execute(db);
  if (exists.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.pending_attestations (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      job_id          TEXT NOT NULL,
      subject_name    TEXT NOT NULL,
      subject_digest  TEXT NOT NULL,
      audience        TEXT NOT NULL,
      dsse_envelope   JSONB NOT NULL,
      public_key      JSONB NOT NULL,
      media_type      TEXT NOT NULL,
      statement_hash  TEXT NOT NULL,
      origin_kind     TEXT NOT NULL,
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_attempt_at TIMESTAMPTZ,
      last_error      TEXT
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX uq_pending_attestations_run_job_subject
      ON public.pending_attestations (run_id, job_id, subject_digest)
  `.execute(db);
  await sql`
    CREATE INDEX idx_pending_attestations_created_at
      ON public.pending_attestations (created_at)
  `.execute(db);

  // Idempotent deferred fulfilment: at most one attestation per (run, job, subject).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attestations_run_job_subject
      ON public.attestations (run_id, job_id, subject_digest)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_attestations_run_job_subject`.execute(db);
  await sql`DROP TABLE IF EXISTS public.pending_attestations`.execute(db);
}
