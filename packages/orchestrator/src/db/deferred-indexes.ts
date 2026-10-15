/**
 * Indexes built after boot, outside the migration set.
 *
 * Kysely runs the pending batch in one transaction with no per-migration opt-out, and PostgreSQL
 * rejects `CREATE INDEX CONCURRENTLY` inside a transaction block, so a migration can only use a
 * plain `CREATE INDEX`: an exclusive lock for the whole build, a multi-minute upgrade outage on a
 * table of millions of rows.
 *
 * So an index on a table that scales with run volume goes here. Each entry is built
 * `CONCURRENTLY` on its own connection with no statement timeout, under an advisory lock distinct
 * from the migration lock, after the server is serving. `IF NOT EXISTS` makes every build
 * idempotent, and a failed build retries on the next boot.
 *
 * A repository check enforces that new indexes on those tables land here. The build is
 * `deferred-index-build.ts`; this module holds only the list, so a CLI can read it without
 * loading the orchestrator's metrics.
 */
export interface DeferredIndex {
  /** Index name, matching the one the SQL creates. */
  name: string;
  /** A single `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement. */
  sql: string;
}

/**
 * Every index the retention sweep and the age-based readers depend on: each supports a
 * `... < cutoff` scan that would otherwise walk the whole table every cleanup tick. Serving-path
 * indexes exist already; these cover the aging path, whose predicate has no org or routing-key
 * prefix.
 */
export const DEFERRED_INDEXES: ReadonlyArray<DeferredIndex> = [
  {
    name: 'execution_runs_status_created_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_runs_status_created_at_idx
            ON public.execution_runs USING btree (status, created_at)`,
  },
  {
    name: 'execution_jobs_created_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_jobs_created_at_idx
            ON public.execution_jobs USING btree (created_at)`,
  },
  {
    name: 'execution_steps_created_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_steps_created_at_idx
            ON public.execution_steps USING btree (created_at)`,
  },
  {
    name: 'event_log_received_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_log_received_at_idx
            ON public.event_log USING btree (received_at)`,
  },
  {
    name: 'access_log_created_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS access_log_created_at_idx
            ON public.access_log USING btree (created_at)`,
  },
  {
    name: 'held_runs_status_created_at_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS held_runs_status_created_at_idx
            ON public.held_runs USING btree (status, created_at)`,
  },
  {
    // Serves a WRITE, not a scan. Without it, every run DELETE makes PostgreSQL check the
    // self-referencing `parent_run_id` FK with a sequential scan per deleted row: a 5,000-row
    // batch is 5,000 full scans, which the serving pool's 30s statement_timeout cancels, so run
    // retention never progresses. Partial because a rerun is rare: the FK check's strict
    // operator lets the planner prove the predicate (PostgreSQL 18: Seq Scan before, Index Scan
    // after). The retention sweep's own parent guard reads it too.
    name: 'execution_runs_parent_run_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_runs_parent_run_id_idx
            ON public.execution_runs USING btree (parent_run_id)
         WHERE parent_run_id IS NOT NULL`,
  },
  {
    // `kici-admin event show` lists the runs an internal event dispatched,
    // which is a `delivery_id` lookup on a table that grows with run volume.
    name: 'execution_runs_delivery_id_idx',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS execution_runs_delivery_id_idx
            ON public.execution_runs USING btree (delivery_id)`,
  },
];
