import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { createLogger } from '@kici-dev/core';

/** Where a pg connection error surfaced. */
export type PgPoolErrorSource = 'idle-pool' | 'client';

export interface CreatePoolOptions {
  /** Extra pg.Pool config merged over the connection string (e.g. max, connectionTimeoutMillis). */
  config?: Omit<pg.PoolConfig, 'connectionString'>;
  /**
   * Optional hook invoked after the built-in log line on every absorbed
   * connection error (e.g. to increment a metrics counter). Additive — it
   * never replaces the log.
   */
  onError?: (err: Error, source: PgPoolErrorSource) => void;
}

// Lazy so importing this module never constructs a logger as a side effect
// (the admin CLIs import it on every invocation).
let poolLogger: ReturnType<typeof createLogger> | undefined;
function getPoolLogger(): ReturnType<typeof createLogger> {
  poolLogger ??= createLogger({ prefix: 'pg-pool' });
  return poolLogger;
}

/**
 * Create PostgreSQL connection pool.
 *
 * Always attaches error handlers for both idle pooled clients (the pool's
 * own 'error' event) and checked-out clients (per-client 'error' via the
 * 'connect' hook). Without them, a terminated backend — e.g. a Postgres
 * leader switchover — escalates to an uncaughtException and a full process
 * restart. The broken connection is logged and discarded; pg replaces it on
 * the next acquire. In-flight query failures still reject to their callers.
 */
export function createPool(databaseUrl: string, options?: CreatePoolOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, ...options?.config });

  // An idle-client error fires both the per-client listener and the pool's
  // 'error' event with the same Error object — dedupe so each dead
  // connection is reported once.
  const seen = new WeakSet<Error>();
  const handle = (err: Error, source: PgPoolErrorSource): void => {
    if (seen.has(err)) return;
    seen.add(err);
    getPoolLogger().warn('Discarded broken pg connection', {
      source,
      error: err.message,
      stack: err.stack,
    });
    options?.onError?.(err, source);
  };

  pool.on('error', (err) => handle(err, 'idle-pool'));
  pool.on('connect', (client) => {
    client.on('error', (err) => handle(err, 'client'));
  });

  return pool;
}

/**
 * Create Kysely database instance (PostgreSQL only).
 *
 * Generic over the database type so each consumer can provide
 * its own schema type (e.g., orchestrator Database vs Platform Database).
 */
export function createDb<T>(pool: pg.Pool): Kysely<T> {
  const dialect = new PostgresDialect({ pool });
  return new Kysely<T>({ dialect });
}
