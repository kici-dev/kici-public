import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { createLogger } from '@kici-dev/core';

/** Where a pg connection error surfaced. */
export type PgPoolErrorSource = 'idle-pool' | 'client';

/**
 * Outcome of a single pool acquire.
 *
 * `'timeout'` means the caller waited the pool's full `connectionTimeoutMillis`
 * and was refused a connection — a load condition. A backend that cannot be
 * reached rejects with a connection error instead and is deliberately NOT
 * reported here; that is a different condition with a different owner.
 */
export type PoolAcquireOutcome = 'ok' | 'timeout';

export interface CreatePoolOptions {
  /** Extra pg.Pool config merged over the connection string (e.g. max, connectionTimeoutMillis). */
  config?: Omit<pg.PoolConfig, 'connectionString'>;
  /**
   * Optional hook invoked after the built-in log line on every absorbed
   * connection error (e.g. to increment a metrics counter). Additive — it
   * never replaces the log.
   */
  onError?: (err: Error, source: PgPoolErrorSource) => void;
  /**
   * Optional hook invoked once per `pool.connect()` acquire on this pool, with
   * the outcome and how long the caller waited.
   *
   * Only the promise form of `connect` is instrumented, so an acquire made via
   * `pool.query(...)` is NOT reported — pg implements `query` on top of the
   * callback form of `connect`. The exclusion is symmetric (neither outcome is
   * reported), so a ratio derived from this hook stays well-formed; but work
   * whose acquires must be counted has to go through `pool.connect()`, as
   * Kysely's PostgresDialect does.
   *
   * Opt-in: a pool created without it behaves exactly as before. A consumer
   * that derives a load signal from acquire outcomes wires it on the pool whose
   * saturation actually matters to it — one hook shared across unrelated pools
   * would attribute one pool's exhaustion to another pool's traffic.
   */
  onAcquire?: (outcome: PoolAcquireOutcome, waitedMs: number) => void;
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

  if (options?.onAcquire) {
    const report = options.onAcquire;
    const original = pool.connect.bind(pool);
    // Only the promise form is instrumented. `connect` is overloaded — pg also
    // accepts a callback — and the callback form is delegated untouched, since
    // Kysely's PostgresDialect (the consumer whose acquires carry the load
    // signal) uses the promise form exclusively.
    //
    // `pool.query(...)` is therefore not instrumented either: pg implements it
    // on top of the callback form (`this.connect((err, client) => …)`), so its
    // acquires reach neither the numerator nor the denominator of any ratio
    // derived from this hook. Route work that must be counted through
    // `pool.connect()`.
    pool.connect = function connect(this: pg.Pool, cb?: unknown) {
      if (typeof cb === 'function') return (original as (c: unknown) => unknown)(cb);
      const startedAt = Date.now();
      return original().then(
        (client) => {
          // A throwing hook must never break the acquire it observes.
          try {
            report('ok', Date.now() - startedAt);
          } catch {
            /* an observability hook may not fail the thing it observes */
          }
          return client;
        },
        (err: unknown) => {
          try {
            // Only a genuine acquire timeout is a load signal. A connection
            // error means the backend is unreachable, which is a different
            // condition — `isPoolAcquireTimeout` exists to keep them apart.
            if (isPoolAcquireTimeout(err)) report('timeout', Date.now() - startedAt);
          } catch {
            /* as above — the original rejection is what the caller must see */
          }
          throw err;
        },
      );
    } as typeof pool.connect;
  }

  return pool;
}

/**
 * node-postgres rejects a pool-acquire timeout (the `connectionTimeoutMillis`
 * window elapsed with no free connection) with this exact message. It is the
 * only signal pg exposes to tell "pool busy (load)" apart from "backend
 * unreachable". Centralized here + covered by one unit test so a pg-version
 * bump that changes the string fails loudly in one place.
 */
export function isPoolAcquireTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'timeout exceeded when trying to connect';
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
