import { type Kysely, sql } from 'kysely';

/**
 * Add `idx_dispatch_queue_run_id` on `dispatch_queue (run_id)`.
 *
 * `failByRunId`, `cancelByRunId`, and `getDispatchedJobIdsByRunId` all filter
 * `WHERE run_id = ?`. Without this index every run-failure cascade and cancel
 * does a full-table scan over the whole dispatch history, each scan holding a
 * pooled connection longer than necessary. The terminal-row retention sweep
 * (`pruneTerminalDispatchRows`) also benefits from cheaper row lookup.
 *
 * Idempotent: `IF NOT EXISTS` makes a re-run a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_run_id
      ON public.dispatch_queue (run_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_dispatch_queue_run_id`.execute(db);
}
