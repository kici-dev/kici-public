import { type Kysely, sql } from 'kysely';

/**
 * Cold-store columns for `secret_audit_log` and `access_log`, and removal of `access_log`'s
 * `expires_at` hard delete.
 *
 * Both tables get the `archived_at` / `archive_object_key` pair (as in
 * `006_runs_jobs_steps_archived_at.ts`), set in the archive tx before the DELETE.
 *
 * `idx_secret_audit_log_routing_timestamp` lets the archiver's per-tenant scan use one index;
 * the single-column `idx_secret_audit_log_timestamp` would force a filter step. `access_log`'s
 * existing `access_log_org_created_idx (org_id, created_at DESC)` already serves its scan.
 *
 * `expires_at` drove a 90-day hard-delete sweep; cold-store archives `access_log` rows older
 * than 30 days instead, so keeping the column would double-evict rows or contradict that
 * contract. `down()` recreates it with a `now() + 90 days` default, best effort: rows inserted
 * after `up()` get no meaningful retention bound.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── secret_audit_log ────────────────────────────────────────────
  await sql`
    ALTER TABLE public.secret_audit_log
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_secret_audit_log_routing_timestamp
      ON public.secret_audit_log (routing_key, "timestamp")
  `.execute(db);

  // ── access_log ─────────────────────────────────────────────────
  await sql`
    ALTER TABLE public.access_log
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL
  `.execute(db);

  // Drop the TTL machinery — archive-then-delete replaces it.
  await sql`DROP INDEX IF EXISTS public.access_log_expires_idx`.execute(db);
  await sql`
    ALTER TABLE public.access_log
      DROP COLUMN IF EXISTS expires_at
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ── access_log ─────────────────────────────────────────────────
  // Best-effort recreate of expires_at (90-day default).
  await sql`
    ALTER TABLE public.access_log
      ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days')
  `.execute(db);

  // Drop the default once the column exists so application-side
  // inserts must populate it explicitly (matches the original schema).
  await sql`
    ALTER TABLE public.access_log
      ALTER COLUMN expires_at DROP DEFAULT
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS access_log_expires_idx
      ON public.access_log (expires_at)
  `.execute(db);

  await sql`
    ALTER TABLE public.access_log
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);

  // ── secret_audit_log ────────────────────────────────────────────
  await sql`DROP INDEX IF EXISTS public.idx_secret_audit_log_routing_timestamp`.execute(db);
  await sql`
    ALTER TABLE public.secret_audit_log
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);
}
