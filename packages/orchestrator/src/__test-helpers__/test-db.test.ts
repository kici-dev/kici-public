import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TestDbBackendsRemainError, terminateTestDbBackends } from './test-db.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_test_db_helper_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function backendCount(admin: pg.Pool): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [TEST_DB],
  );
  return rows[0].n;
}

describeDb('terminateTestDbBackends', () => {
  let admin: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  }, 60_000);

  afterAll(async () => {
    await terminateTestDbBackends(admin, TEST_DB);
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await admin.end();
  }, 60_000);

  // fails-when: the helper terminates before the closing client is gone — the
  // client's own end handshake then races a FATAL 57P01, which is the crash
  // this helper exists to remove. Observed here as the pool-level 'error'
  // event a terminated idle client raises.
  it('waits for a client that is closing on its own and terminates nothing', async () => {
    const pool = new pg.Pool({ connectionString: withDatabase(ADMIN_URL!, TEST_DB), max: 1 });
    const poolErrors: Error[] = [];
    pool.on('error', (err) => poolErrors.push(err));
    await pool.query('SELECT 1');
    expect(await backendCount(admin)).toBe(1);

    // Not awaited: pool.end() resolves once Terminate is SENT, which is exactly
    // the window a premature pg_terminate_backend lands in.
    const ending = pool.end();
    await terminateTestDbBackends(admin, TEST_DB);
    await ending;

    expect(await backendCount(admin)).toBe(0);
    expect(poolErrors).toEqual([]);
  });

  // breaks-if-wrong: a connection the test never closes must still be
  // terminated, or DROP DATABASE blocks forever on it.
  it('terminates a connection nobody closes once the wait times out', async () => {
    const client = new pg.Client({ connectionString: withDatabase(ADMIN_URL!, TEST_DB) });
    const clientErrors: Error[] = [];
    client.on('error', (err) => clientErrors.push(err));
    await client.connect();
    expect(await backendCount(admin)).toBe(1);

    const started = Date.now();
    await terminateTestDbBackends(admin, TEST_DB, { timeoutMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    expect(await backendCount(admin)).toBe(0);
    await expect(client.query('SELECT 1')).rejects.toThrow();
    await client.end().catch(() => undefined);
  });
});

/**
 * A pool double answering the backend-count query from `counts` in order (the
 * last value repeats) and recording each terminate.
 */
function scriptedPool(counts: number[]) {
  const calls: string[] = [];
  let next = 0;
  const pool = {
    query: async (text: string) => {
      if (text.includes('pg_terminate_backend')) {
        calls.push('terminate');
        return { rows: [] };
      }
      const n = counts[Math.min(next, counts.length - 1)];
      next += 1;
      calls.push(`count:${n}`);
      return { rows: [{ n }] };
    },
  };
  return { pool: pool as unknown as pg.Pool, calls };
}

describe('terminateTestDbBackends — after the terminate', () => {
  it('returns only once the terminated backends have left pg_stat_activity', async () => {
    // Still listed at the deadline, then still listed right after the terminate.
    const { pool, calls } = scriptedPool([1, 1, 1, 0]);
    await terminateTestDbBackends(pool, 'db', { timeoutMs: 0 });
    // fails-when: the helper returns right after pg_terminate_backend, so DROP DATABASE races the exit
    expect(calls).toEqual(['terminate', 'count:1', 'count:1', 'count:1', 'count:0']);
  });

  it('throws naming the remaining backends when they never exit', async () => {
    const { pool, calls } = scriptedPool([2]);
    const done = terminateTestDbBackends(pool, 'db', { timeoutMs: 0, exitTimeoutMs: 60 });
    // fails-when: the post-terminate wait is unbounded, or gives up silently and lets DROP run blind
    await expect(done).rejects.toBeInstanceOf(TestDbBackendsRemainError);
    await expect(done).rejects.toThrow(/2 backend/);
    expect(calls[0]).toBe('terminate');
  });

  it('neither terminates nor waits when no backend is left', async () => {
    const { pool, calls } = scriptedPool([0]);
    await terminateTestDbBackends(pool, 'db');
    // breaks-if-wrong: a database already empty must return after one count, with no terminate
    expect(calls).toEqual(['count:0']);
  });
});
