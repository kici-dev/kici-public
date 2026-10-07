/**
 * Indexes built after boot, outside the migration set.
 *
 * A migration cannot build an index without locking the table it indexes.
 * Kysely runs the whole pending batch inside one transaction and offers no
 * per-migration opt-out, and PostgreSQL rejects `CREATE INDEX CONCURRENTLY`
 * inside a transaction block outright — so a migration's only option is a
 * plain `CREATE INDEX`, which holds an exclusive lock for the whole build. On
 * a table holding millions of rows that is a multi-minute outage bolted onto
 * an upgrade.
 *
 * So an index on a table that scales with run volume goes here instead. Each
 * entry is built `CONCURRENTLY` on its own connection with no statement
 * timeout, under an advisory lock distinct from the migration lock, after the
 * server is already serving. `IF NOT EXISTS` makes every build idempotent, and
 * a failed build retries on the next boot.
 *
 * A repository check enforces that new indexes on those tables land here
 * rather than in a migration. The build itself is `deferred-index-build.ts`;
 * this module holds only the list, so a CLI can read it without loading the
 * orchestrator's metrics.
 */
export interface DeferredIndex {
  /** Index name, matching the one the SQL creates. */
  name: string;
  /** A single `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement. */
  sql: string;
}

/**
 * Every index the retention sweep and the age-based readers depend on.
 *
 * Each one supports a `... < cutoff` scan that would otherwise walk the whole
 * table on every cleanup tick. The tables already carry indexes for their
 * serving-path queries; these cover the aging path, whose predicate is not
 * prefixed by an organization or routing key.
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
    // The one index here that serves a WRITE rather than a scan.
    // `execution_runs.parent_run_id` is a self-referencing foreign key with no
    // index, so every DELETE of a run makes PostgreSQL run the referencing-side
    // check `SELECT 1 FROM execution_runs WHERE $1 = parent_run_id` as a
    // sequential scan — once per deleted row. At 5,000 rows a batch that is
    // 5,000 full scans in one statement, which the serving pool's 30s
    // statement_timeout cancels long before it finishes, so run retention never
    // makes progress. Partial because a rerun is rare: the FK check compares
    // with a strict operator, which the planner proves implies the predicate,
    // so it uses the index (verified against PostgreSQL 18: Seq Scan before,
    // Index Scan after). The retention sweep's own parent guard reads it too.
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
