import { type Kysely, sql } from 'kysely';

/**
 * `event_log` cold-store schema additions plus removal of the
 * `expires_at`-based 30-day hard delete.
 *
 * Phase E of the cold-storage archival system. See
 *  §10
 * Phase E.
 *
 * Adds the same `archived_at TIMESTAMPTZ NULL` /
 * `archive_object_key TEXT NULL` pair Phase D added on this side
 * (`007_audit_logs_archived_at.ts`). Set inside the archive
 * transaction before the DELETE; survivors carry NULL.
 *
 * Adds `idx_event_log_routing_received` on `(routing_key, received_at)`
 * because the orchestrator-side cold-store partitions `event_log` by
 * `routing_key` (NOT NULL on this table; no synthetic-tenant fallback
 * is needed). The existing `event_log_org_received_idx` is keyed by
 * `org_id`, fine for dashboard queries but not the per-tenant
 * archiver scan.
 *
 * Drops `event_log.expires_at` and the matching
 * `event_log_expires_at_idx` index. Until Phase E, `expires_at`
 * powered the 30-day hard-delete sweep in
 * `packages/orchestrator/src/webhook/event-log.ts:cleanup`, called
 * from `packages/orchestrator/src/queue/cleanup.ts:runCleanup` step 4
 * (which also deleted the per-row `payload_key` blob from object
 * storage). With cold-store, rows older than 30 days are archived
 * rather than deleted; the per-row `payload_key` blob is retained
 * indefinitely so the dashboard delivery-detail page can still load
 * the body for archived deliveries.
 *
 * Per the project's "no backward compatibility (pre-release)" rule,
 * `down()` recreates `expires_at` with a default of `now() + 30 days`
 * — best effort; rows inserted between `up()` and a hypothetical
 * `down()` would not have meaningful retention bounds.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.event_log
      ADD COLUMN archived_at         TIMESTAMPTZ NULL,
      ADD COLUMN archive_object_key  TEXT        NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_event_log_routing_received
      ON public.event_log (routing_key, received_at)
  `.execute(db);

  // Drop the TTL machinery — Phase E replaces it with archive-then-delete.
  await sql`DROP INDEX IF EXISTS public.event_log_expires_at_idx`.execute(db);
  await sql`
    ALTER TABLE public.event_log
      DROP COLUMN IF EXISTS expires_at
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Best-effort recreate of expires_at (30-day default).
  await sql`
    ALTER TABLE public.event_log
      ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS event_log_expires_at_idx
      ON public.event_log (expires_at)
  `.execute(db);

  await sql`DROP INDEX IF EXISTS public.idx_event_log_routing_received`.execute(db);

  await sql`
    ALTER TABLE public.event_log
      DROP COLUMN IF EXISTS archive_object_key,
      DROP COLUMN IF EXISTS archived_at
  `.execute(db);
}
