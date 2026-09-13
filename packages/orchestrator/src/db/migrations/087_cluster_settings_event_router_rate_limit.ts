import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.event_router_rate_limit_per_workflow_per_minute` (nullable INTEGER).
 *
 * Fleet-wide per-(source routing key + event) sliding-window rate limit (events/minute) for the event router. NULL → cluster default (`config.eventRouterRateLimitPerWorkflowPerMinute`, `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE`).
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has
 * the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'event_router_rate_limit_per_workflow_per_minute'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN event_router_rate_limit_per_workflow_per_minute INTEGER`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS event_router_rate_limit_per_workflow_per_minute`.execute(
    db,
  );
}
