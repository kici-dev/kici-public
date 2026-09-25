/**
 * Teardown helper for tests that create their own PostgreSQL database.
 */
import type pg from 'pg';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;

const COUNT_SQL =
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()';

/** Backends still hold the database after they were terminated and waited on. */
export class TestDbBackendsRemainError extends Error {
  constructor(
    readonly dbName: string,
    readonly remaining: number,
  ) {
    super(
      `${remaining} backend(s) still hold database "${dbName}" after pg_terminate_backend; ` +
        'refusing to let DROP DATABASE run against them',
    );
    this.name = 'TestDbBackendsRemainError';
  }
}

async function countBackends(admin: pg.Pool, dbName: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(COUNT_SQL, [dbName]);
  return rows[0].n;
}

/** Poll until no backend holds `dbName`; resolve false if `timeoutMs` passes first. */
async function waitForNoBackends(
  admin: pg.Pool,
  dbName: string,
  timeoutMs: number,
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await countBackends(admin, dbName);
  while (remaining > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    remaining = await countBackends(admin, dbName);
  }
  return { drained: remaining === 0, remaining };
}

/**
 * Terminate whatever backends still hold `dbName`, after first waiting for
 * the connections the test itself closed to finish closing, then wait for the
 * terminated backends to exit.
 *
 * `pool.end()` — and Kysely's `destroy()`, which calls it — resolves as soon
 * as every client has SENT its Terminate message, not when its socket has
 * closed. A `pg_terminate_backend` issued inside that window delivers a FATAL
 * `57P01` to a client that is mid-shutdown and no longer carries an error
 * listener, and that surfaces as an uncaught exception that fails the whole
 * test file after every test in it passed. So this polls `pg_stat_activity`
 * until the database has no backend left (bounded by `timeoutMs`), and
 * terminates only what is still there — a connection the test never closed.
 *
 * A terminated backend stays in `pg_stat_activity` until it has exited, and
 * `DROP DATABASE` fails while it is listed. So after the terminate this polls
 * again until the count is zero, bounded by `exitTimeoutMs`, and throws
 * {@link TestDbBackendsRemainError} if the bound passes.
 */
export async function terminateTestDbBackends(
  admin: pg.Pool,
  dbName: string,
  opts: { timeoutMs?: number; exitTimeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if ((await countBackends(admin, dbName)) === 0) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [dbName],
  );
  const exited = await waitForNoBackends(
    admin,
    dbName,
    opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
  );
  // fails-when: a terminated backend never exits, so DROP DATABASE would fail on it
  if (!exited.drained) throw new TestDbBackendsRemainError(dbName, exited.remaining);
}
