import { afterAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { ColdStoreTableConfig } from './config.js';
import { PgTableAdapterBase } from './pg-table-adapter.js';

const DEFAULTS: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 1,
  minChunkBytes: 2,
  maxChunkBytes: 3,
  maxRowsPerCycle: 4,
  enabled: true,
};

const NAMESPACE = `cold-store|test|${process.pid}`;

class TestAdapter extends PgTableAdapterBase<unknown> {
  constructor(kdb: Kysely<unknown>, overrides?: Partial<ColdStoreTableConfig>) {
    super(kdb, NAMESPACE, DEFAULTS, overrides);
  }

  static coerce<T>(parsed: T, field: keyof T): void {
    PgTableAdapterBase.coerceDate(parsed, field);
  }
}

describe('PgTableAdapterBase config and coerceDate', () => {
  const kdb = {} as unknown as Kysely<unknown>;

  it('merges overrides over the defaults, and an absent override keeps the defaults', () => {
    // fails-when: the merge drops a default or ignores an override
    expect(new TestAdapter(kdb, { warmTtlDays: 7 }).config).toEqual({
      ...DEFAULTS,
      warmTtlDays: 7,
    });
    expect(new TestAdapter(kdb).config).toEqual(DEFAULTS);
  });

  it('turns an ISO string field into a Date and leaves a Date or null alone', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      created_at: '2026-10-04T00:00:00.000Z' as unknown as Date,
      started_at: date,
      completed_at: null as Date | null,
    };
    TestAdapter.coerce(row, 'created_at');
    TestAdapter.coerce(row, 'started_at');
    TestAdapter.coerce(row, 'completed_at');
    expect(row.created_at).toEqual(new Date('2026-10-04T00:00:00.000Z'));
    expect(row.started_at).toBe(date);
    expect(row.completed_at).toBeNull();
  });
});

// Real-Postgres proof of the partition lock. Gated on KICI_TEST_ADMIN_DATABASE_URL.
// Advisory locks need no schema, so the suite uses the admin database as is;
// the namespace carries the pid so a concurrent run never shares a key.
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

describeDb('PgTableAdapterBase.withPartitionLock (real Postgres)', () => {
  // pg_try_advisory_lock is per session: the outer holder pins one pooled
  // connection, so a concurrent holder needs a second one to test the lock
  // rather than wait for the connection.
  const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  const kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  afterAll(() => kdb.destroy());

  it('returns null for a concurrent holder of the same partition and runs a different partition', async () => {
    const a = new TestAdapter(kdb);
    const b = new TestAdapter(kdb);
    let inner: unknown = 'unset';
    let other: unknown = 'unset';
    const outer = await a.withPartitionLock(
      { tenantId: 't', partitionDate: '2026-10-04' },
      async () => {
        // fails-when: a second concurrent holder of the same partition is not refused (null)
        inner = await b.withPartitionLock(
          { tenantId: 't', partitionDate: '2026-10-04' },
          async () => 'ran',
        );
        // breaks-if-wrong: a different partition must still acquire while the first is held
        other = await b.withPartitionLock(
          { tenantId: 't', partitionDate: '2026-10-05' },
          async () => 'ok',
        );
        return 'outer';
      },
    );
    expect(outer).toBe('outer');
    expect(inner).toBeNull();
    expect(other).toBe('ok');
  });

  it('keys the lock on hashtext of namespace|tenant|date', async () => {
    // fails-when: the key format drifts from `<namespace>|<tenantId>|<partitionDate>`
    let probed: boolean | undefined;
    await new TestAdapter(kdb).withPartitionLock(
      { tenantId: 'tn', partitionDate: '2026-10-04' },
      async () => {
        const res = await pool.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
          [`${NAMESPACE}|tn|2026-10-04`],
        );
        probed = res.rows[0]?.locked;
      },
    );
    expect(probed).toBe(false);
  });

  it('releases the lock after fn resolves and after fn throws', async () => {
    const a = new TestAdapter(kdb);
    const part = { tenantId: 't', partitionDate: '2026-10-06' };
    expect(await a.withPartitionLock(part, async () => 1)).toBe(1);
    await expect(
      a.withPartitionLock(part, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // fails-when: the finally-unlock is skipped, so the session keeps the lock
    // and a different session is refused. A dedicated client guarantees a
    // different session: an advisory lock is re-entrant within its own.
    const probe = new pg.Client({ connectionString: ADMIN_URL });
    await probe.connect();
    const res = await probe.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`${NAMESPACE}|t|2026-10-06`],
    );
    expect(res.rows[0]?.locked).toBe(true);
    await probe.end();
  });
});
