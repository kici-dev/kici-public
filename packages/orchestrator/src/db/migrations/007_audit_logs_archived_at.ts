import { type Kysely, sql } from 'kysely';

/**
 * `secret_audit_log` and `access_log` cold-store schema additions, plus
 * the removal of `access_log`'s `expires_at`-based hard delete.
 *
 * Phase D of the cold-storage archival system. See
 *
 * Both tables get the same `archived_at TIMESTAMPTZ NULL` /
 * `archive_object_key TEXT NULL` pair that Phase B added to `run_events`
 * (`packages/platform/src/db/migrations/004_run_events_archived_at.ts`)
 * and Phase C added to `execution_runs` / `execution_jobs` /
 * `execution_steps` (`006_runs_jobs_steps_archived_at.ts`). Set inside
 * the archive transaction before the DELETE; survivors carry NULL.
 *
 * `secret_audit_log` gets a composite
 * `idx_secret_audit_log_routing_timestamp (routing_key, timestamp)` so
 * the archiver's per-tenant scan can use a single index. The existing
 * `idx_secret_audit_log_timestamp` is single-column and would force a
 * filter step.
 *
 * `access_log` already has `access_log_org_created_idx (org_id,
 * created_at DESC)`, which is sufficient for the per-tenant scan
 * (range scans use either direction).
 *
 * Drops `access_log.expires_at` column and `access_log_expires_idx`.
 * Until Phase D, `expires_at` powered a 90-day hard-delete sweep in
 * `packages/orchestrator/src/audit/access-log.ts:cleanup` (called from
 * `packages/orchestrator/src/queue/cleanup.ts:runCleanup` step 5). With
 * cold-store, `access_log` rows older than 30 days are archived rather
 * than deleted, so the TTL becomes effectively "forever". Keeping the
 * column would mean either (a) double-evicting rows or (b) silently
 * mismatching the new contract. Drop it.
 *
 * Per the project's "no backward compatibility (pre-release)" rule,
 * `down()` recreates `expires_at` with a default of `now() + 90 days`
 * — best effort; rows inserted between `up()` and a hypothetical
 * `down()` would not have meaningful retention bounds. Acceptable for
 * staging.
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

  // Drop the TTL machinery — Phase D replaces it with archive-then-delete.
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
