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
 * `hack/check-migration-safety.ts` enforces that new indexes on those tables
 * land here rather than in a migration.
 */
import type pg from 'pg';
import { createLogger, type Logger } from '@kici-dev/shared';
import { deferredIndexBuildsTotal } from '../metrics/prometheus.js';

const defaultLogger = createLogger({ prefix: 'deferred-index' });

/**
 * Distinct from the migrator's `543210001`: an index build must not block, or
 * be blocked by, a peer applying migrations.
 */
export const DEFERRED_INDEX_LOCK_KEY = 543210002;

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
];

/**
 * Drop a leftover invalid index before rebuilding it.
 *
 * An interrupted `CREATE INDEX CONCURRENTLY` leaves the index in place marked
 * invalid: it is not used by the planner, and `IF NOT EXISTS` sees it and
 * skips. Without this, the very first failed build would make the retry a
 * permanent no-op — the opposite of the "retries on the next boot" contract.
 */
export async function dropIfInvalid(
  client: Pick<pg.Client, 'query'>,
  name: string,
  logger: Logger,
): Promise<void> {
  const res = await client.query<{ invalid: boolean }>(
    `SELECT NOT i.indisvalid AS invalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1`,
    [name],
  );
  if (!res.rows[0]?.invalid) return;
  logger.warn(`Dropping invalid index ${name} left by an interrupted build`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
}

export interface BuildDeferredIndexesResult {
  built: string[];
  failed: string[];
}

/**
 * Build every deferred index on one dedicated connection.
 *
 * The connection is taken straight from `pg` rather than from the serving
 * pool: `CREATE INDEX CONCURRENTLY` must run outside a transaction and must
 * not inherit a statement timeout, and a concurrent build on a large table
 * would otherwise hold a serving connection for its whole duration.
 *
 * The advisory lock is `pg_try_advisory_lock`, not the blocking form: when a
 * peer is already building, this instance has nothing to wait for.
 */
export async function buildDeferredIndexes(
  databaseUrl: string,
  opts?: { logger?: Logger; indexes?: ReadonlyArray<DeferredIndex>; pg?: typeof import('pg') },
): Promise<BuildDeferredIndexesResult> {
  const logger = opts?.logger ?? defaultLogger;
  const indexes = opts?.indexes ?? DEFERRED_INDEXES;
  const driver = opts?.pg ?? (await import('pg')).default;

  const result: BuildDeferredIndexesResult = { built: [], failed: [] };
  if (indexes.length === 0) return result;

  const client: pg.Client = new driver.Client({
    connectionString: databaseUrl,
    statement_timeout: 0,
  });
  await client.connect();
  try {
    const held = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [DEFERRED_INDEX_LOCK_KEY],
    );
    if (!held.rows[0]?.locked) {
      logger.info('Deferred index build already running on a peer; skipping');
      return result;
    }
    try {
      for (const index of indexes) {
        const started = Date.now();
        try {
          await dropIfInvalid(client, index.name, logger);
          await client.query(index.sql);
          result.built.push(index.name);
          deferredIndexBuildsTotal.add(1, { name: index.name, outcome: 'ok' });
          logger.info(`Deferred index ${index.name} ready (${Date.now() - started}ms)`);
        } catch (err) {
          result.failed.push(index.name);
          deferredIndexBuildsTotal.add(1, { name: index.name, outcome: 'error' });
          logger.warn(`Deferred index ${index.name} failed; retrying on next boot`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DEFERRED_INDEX_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
  return result;
}
