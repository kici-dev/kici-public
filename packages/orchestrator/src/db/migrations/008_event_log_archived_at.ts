import { type Kysely, sql } from 'kysely';

/**
 * `event_log` cold-store schema: adds the `archived_at` /
 * `archive_object_key` pair `007_audit_logs_archived_at.ts` added elsewhere
 * (set inside the archive transaction before the DELETE; survivors carry
 * NULL) and removes the `expires_at`-based 30-day hard delete.
 *
 * `idx_event_log_routing_received` exists because the cold-store partitions
 * `event_log` by `routing_key` (NOT NULL here, so no synthetic-tenant
 * fallback); `event_log_org_received_idx` is keyed by `org_id` and does not
 * serve the per-tenant archiver scan.
 *
 * Rows older than 30 days are now archived rather than deleted; the per-row
 * `payload_key` blob is retained indefinitely so the dashboard
 * delivery-detail page can still load the body of archived deliveries.
 *
 * `down()` recreates `expires_at` defaulting to `now() + 30 days` — best
 * effort; rows inserted between `up()` and `down()` get no meaningful
 * retention bound.
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

  // Drop the TTL machinery — archive-then-delete replaces it.
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
