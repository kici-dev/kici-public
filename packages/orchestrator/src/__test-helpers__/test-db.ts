/**
 * Teardown helper for tests that create their own PostgreSQL database.
 */
import type pg from 'pg';

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;

/**
 * Terminate whatever backends still hold `dbName`, after first waiting for
 * the connections the test itself closed to finish closing.
 *
 * `pool.end()` — and Kysely's `destroy()`, which calls it — resolves as soon
 * as every client has SENT its Terminate message, not when its socket has
 * closed. A `pg_terminate_backend` issued inside that window delivers a FATAL
 * `57P01` to a client that is mid-shutdown and no longer carries an error
 * listener, and that surfaces as an uncaught exception that fails the whole
 * test file after every test in it passed. So this polls `pg_stat_activity`
 * until the database has no backend left (bounded by `timeoutMs`), and
 * terminates only what is still there — a connection the test never closed.
 */
export async function terminateTestDbBackends(
  admin: pg.Pool,
  dbName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const countSql =
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()';
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ n: number }>(countSql, [dbName]);
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [dbName],
  );
}
