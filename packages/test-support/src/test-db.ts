/**
 * The shared real-PostgreSQL suite harness: a throwaway database per suite,
 * created, migrated and dropped around it, plus the teardown helper the drop uses.
 */
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';

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

/** Env var that points the real-Postgres suites at an admin connection. */
export const TEST_DB_GATE_ENV = 'KICI_TEST_ADMIN_DATABASE_URL';

/** The admin connection string, or undefined when no database is configured. */
export function testDbAdminUrl(): string | undefined {
  return process.env[TEST_DB_GATE_ENV];
}

/** `url` with its database path replaced by `dbName`. */
export function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export interface TestDb<DB> {
  readonly db: Kysely<DB>;
  readonly pool: pg.Pool;
  readonly url: string;
  readonly name: string;
}

export interface UseTestDbOptions {
  /** Database-name prefix; the pid and a timestamp are appended. */
  prefix: string;
  /** Migrations applied after creation. Omit for a bare database. */
  provider?: MigrationProvider;
  /** Hook timeout for create + migrate and for drop. */
  timeoutMs?: number;
  /** Maximum connections in the suite's pool (pg's default when omitted). */
  poolMax?: number;
}

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

async function withAdminPool<T>(adminUrl: string, fn: (admin: pg.Pool) => Promise<T>): Promise<T> {
  const admin = new pg.Pool({ connectionString: adminUrl });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/**
 * Create a throwaway database before the enclosing suite, migrate it, and drop
 * it after. Returns a getter, because the handle exists only once `beforeAll`
 * ran. Call it inside a `describe` that is skipped when {@link testDbAdminUrl}
 * is unset; {@link describeWithTestDb} does both. Like that helper, its name
 * is a database marker for `scripts/db-test-postgres-support.ts`.
 */
export function useTestDb<DB>(opts: UseTestDbOptions): () => TestDb<DB> {
  const timeout = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const name = `${opts.prefix}_${process.pid}_${Date.now()}`;
  let handle: TestDb<DB> | undefined;

  beforeAll(async () => {
    const adminUrl = testDbAdminUrl();
    if (!adminUrl) {
      throw new Error(`${TEST_DB_GATE_ENV} is unset; wrap the suite in describeWithTestDb`);
    }
    await withAdminPool(adminUrl, (admin) => admin.query(`CREATE DATABASE "${name}"`));
    const url = withDatabase(adminUrl, name);
    const pool = new pg.Pool({ connectionString: url, max: opts.poolMax });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    handle = { db, pool, url, name };
    if (opts.provider) {
      const { error } = await new Migrator({ db, provider: opts.provider }).migrateToLatest();
      if (error) throw error;
    }
  }, timeout);

  afterAll(async () => {
    await handle?.db.destroy();
    // Kysely ends the pool only if it ever connected through it, so a suite
    // that queries the pool directly would leave an idle client for the
    // terminate below to kill mid-teardown.
    if (handle && !handle.pool.ending) await handle.pool.end();
    const adminUrl = testDbAdminUrl();
    if (!adminUrl) return;
    await withAdminPool(adminUrl, async (admin) => {
      await terminateTestDbBackends(admin, name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    });
  }, timeout);

  return () => {
    if (!handle) {
      throw new Error(`test database ${name} is not ready; call the getter inside a test or hook`);
    }
    return handle;
  };
}

/**
 * A `describe` that runs only when a test database is configured, with a
 * migrated throwaway database for its tests. Its name is also a marker
 * `scripts/db-test-postgres-support.ts` looks for in the source text to start
 * a database for the run, so call it by name, never through an alias.
 */
export function describeWithTestDb<DB>(
  name: string,
  opts: UseTestDbOptions,
  body: (getDb: () => TestDb<DB>) => void,
): void {
  const run = testDbAdminUrl() ? describe : describe.skip;
  run(name, () => {
    body(useTestDb<DB>(opts));
  });
}
