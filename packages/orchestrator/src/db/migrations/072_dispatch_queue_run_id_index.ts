import { type Kysely, sql } from 'kysely';

/**
 * `failByRunId`, `cancelByRunId` and `getDispatchedJobIdsByRunId` filter on `run_id`; without
 * this index each run-failure cascade and cancel full-scans the dispatch history while holding
 * a pooled connection. `pruneTerminalDispatchRows` also uses it. Idempotent.
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
