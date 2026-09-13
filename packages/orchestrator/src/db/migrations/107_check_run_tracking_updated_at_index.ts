import { type Kysely, sql } from 'kysely';

/**
 * Add `idx_check_run_tracking_updated_at` on `check_run_tracking (updated_at)`.
 *
 * `CheckRunTrackingStore.pruneStale` — the hourly retention sweep — filters
 * `WHERE updated_at < now() - <window>`. The table already carries two indexes
 * — the primary key on `(provider, owner, repo, sha, check_name)` and the
 * partial `idx_check_run_tracking_run_id` — but `updated_at` leads neither, so
 * that predicate can use neither and without this index every sweep
 * sequentially scans the whole table. The scan
 * is worst exactly where it hurts: a deployment that accumulated rows before
 * retention existed has the largest table and gets the scan hourly, on every
 * coordinator, since the cleanup tick is not leader-gated.
 *
 * Mirrors `idx_dispatch_queue_run_id` (migration 072) and
 * `idx_request_idempotency_created_at` (migration 068), both of which exist to
 * index a TTL sweep's prune predicate.
 *
 * Idempotent: `IF NOT EXISTS` makes a re-run a no-op.
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
