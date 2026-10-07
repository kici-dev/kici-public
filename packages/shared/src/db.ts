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
 * SQLSTATEs that mean "this connection was killed", not "the database is
 * unavailable": `57P01` admin_shutdown (`pg_terminate_backend`, a leader
 * demotion) and `57P02` crash_shutdown. `57P03` cannot_connect_now is left
 * out on purpose — that one is the database refusing new work.
 */
const BROKEN_CONNECTION_SQLSTATES = new Set(['57P01', '57P02']);

/** node-postgres' own messages for a socket that died under a pooled client. */
const BROKEN_CONNECTION_MESSAGES = [
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
];

/**
 * True when a query failed because the pooled connection it ran on was already
 * dead. After a switchover, Postgres terminates every idle backend, but a
 * pooled client only learns of it when it reads the FATAL message. A query that
 * acquires the client in that gap fails, while a fresh connection would
 * succeed. The pool discards the client either way.
 */
export function isBrokenConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (BROKEN_CONNECTION_SQLSTATES.has(code)) return true;
    // Class 08: connection exceptions.
    if (code.startsWith('08')) return true;
    if (code === 'ECONNRESET' || code === 'EPIPE') return true;
  }
  return BROKEN_CONNECTION_MESSAGES.includes(err.message);
}

/**
 * How many times {@link retryOnBrokenConnection} runs the probe. A switchover
 * kills every idle client at once, so more than one dead client can be handed
 * out before the pool has discarded them all. Each failed attempt fails fast
 * on a dead socket, so the bound costs almost nothing.
 */
export const BROKEN_CONNECTION_ATTEMPTS = 3;

/**
 * Run a database probe again when it failed only because its pooled
 * connection was already dead. Any other error (unreachable host, acquire
 * timeout, a real query error) is rethrown at once, so a real outage is never
 * hidden and never slowed down. Meant for readiness probes, whose question is
 * "can this process reach its database now". It is not for writes: a write
 * that failed mid-flight may have been applied.
 */
export async function retryOnBrokenConnection<T>(probe: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await probe();
    } catch (err) {
      if (attempt >= BROKEN_CONNECTION_ATTEMPTS || !isBrokenConnectionError(err)) throw err;
    }
  }
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

/** How long {@link closeDatabase} waits for in-flight queries before it closes anyway. */
export const DEFAULT_DB_DRAIN_TIMEOUT_MS = 5_000;

const DB_DRAIN_POLL_MS = 25;

/** What {@link closeDatabase} found when its drain window ended. */
export interface CloseDatabaseResult {
  /** Connections still checked out or connecting, plus acquires still queued, when the window ended. */
  busyAtDeadline: number;
}

/** Make every later `pool.connect()` fail at once, in both its promise and callback forms. */
function refuseNewAcquires(pool: pg.Pool): void {
  pool.connect = function connect(cb?: unknown) {
    const err = new Error('the database is closing');
    if (typeof cb === 'function') {
      process.nextTick(() => (cb as (e: Error) => void)(err));
      return undefined;
    }
    return Promise.reject(err);
  } as typeof pool.connect;
}

/**
 * Close a Kysely database and the pg pool it runs on, without hanging.
 *
 * Kysely's PostgresDriver.destroy() drops its pool reference and then calls
 * pool.end(). An acquire whose pool.connect() is still pending at that moment
 * gets a client it can no longer wrap, so the client is never released, and
 * pool.end(), which waits for every client, never returns. So this refuses new
 * acquires first, waits for the in-flight ones to finish and every checked-out
 * client to come back, and destroys the database only then.
 *
 * A query that outlives `drainTimeoutMs` is logged by count and left running:
 * the process exits after its shutdown, and PostgreSQL ends the backend when
 * the connection closes.
 */
export async function closeDatabase(
  db: { destroy(): Promise<void> },
  pool: pg.Pool,
  options: { drainTimeoutMs?: number } = {},
): Promise<CloseDatabaseResult> {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DB_DRAIN_TIMEOUT_MS;
  refuseNewAcquires(pool);
  const busy = () => pool.totalCount - pool.idleCount + pool.waitingCount;
  const deadline = Date.now() + drainTimeoutMs;
  while (busy() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DB_DRAIN_POLL_MS));
  }
  const busyAtDeadline = busy();
  if (busyAtDeadline > 0) {
    getPoolLogger().warn('Closing the database with connections still in use', {
      busy: busyAtDeadline,
      drainTimeoutMs,
    });
    // pool.end() waits for the busy clients, so it is not awaited: the process
    // exits after its shutdown whether or not they come back.
    void db.destroy().catch(() => {});
    return { busyAtDeadline };
  }
  await db.destroy();
  return { busyAtDeadline: 0 };
}
