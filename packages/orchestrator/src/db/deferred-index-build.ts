/**
 * Builds the deferred indexes (`deferred-indexes.ts`) after boot, each one
 * `CONCURRENTLY` on its own connection.
 */
import type pg from 'pg';
import { createLogger, type Logger } from '@kici-dev/shared';
import { deferredIndexBuildsTotal } from '../metrics/prometheus.js';
import { DEFERRED_INDEXES, type DeferredIndex } from './deferred-indexes.js';

const defaultLogger = createLogger({ prefix: 'deferred-index' });

/**
 * Distinct from the migrator's `543210001`: an index build must not block, or
 * be blocked by, a peer applying migrations.
 */
export const DEFERRED_INDEX_LOCK_KEY = 543210002;

/**
 * Drop a leftover invalid index before rebuilding it.
 *
 * An interrupted `CREATE INDEX CONCURRENTLY` leaves an invalid index that the
 * planner ignores and `IF NOT EXISTS` skips, so without this the first failed
 * build would turn the "retries on the next boot" contract into a no-op.
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
 * The connection comes straight from `pg`, not the serving pool:
 * `CREATE INDEX CONCURRENTLY` runs outside a transaction with no statement
 * timeout, and a long build would otherwise hold a serving connection.
 *
 * `pg_try_advisory_lock`, not the blocking form: when a peer is already
 * building, this instance has nothing to wait for.
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
