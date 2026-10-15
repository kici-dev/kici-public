import { type Kysely, sql } from 'kysely';

/**
 * Add `idx_check_run_tracking_updated_at` on `check_run_tracking (updated_at)`.
 *
 * The hourly retention sweep `CheckRunTrackingStore.pruneStale` filters
 * `WHERE updated_at < now() - <window>`, and `updated_at` leads neither the primary key
 * `(provider, owner, repo, sha, check_name)` nor the partial `idx_check_run_tracking_run_id`, so
 * without this index every sweep scans the whole table — hourly, on every coordinator (the
 * cleanup tick is not leader-gated), and worst on deployments that accumulated rows before
 * retention existed.
 *
 * Mirrors `idx_dispatch_queue_run_id` (072) and `idx_request_idempotency_created_at` (068), which
 * also index a TTL sweep's prune predicate. Idempotent (`IF NOT EXISTS`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_check_run_tracking_updated_at
      ON public.check_run_tracking (updated_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_check_run_tracking_updated_at`.execute(db);
}
