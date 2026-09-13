import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './101_contexts_hold_expiry_drop_default.js';

/**
 * Real-Postgres test for migration 101: asserts the `hold_expiry_seconds` DDL
 * default is dropped so an omitted column lands NULL, that stored zeroes are
 * backfilled to NULL while real values are untouched, that `up` is idempotent,
 * and that `down` restores the default without resurrecting the zeroes. Gated
 * on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig101_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 101_contexts_hold_expiry_drop_default', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  /**
   * Insert a context, omitting `hold_expiry_seconds` entirely when no value is
   * given so the column's own default decides. `org_id` and `name` are the only
   * NOT NULL columns without a default.
   */
  const insertContext = async (name: string, holdExpiry?: number | null): Promise<void> => {
    if (holdExpiry === undefined) {
      await sql`INSERT INTO public.contexts (org_id, name) VALUES ('org-mig101', ${name})`.execute(
        db,
      );
    } else {
      await sql`
        INSERT INTO public.contexts (org_id, name, hold_expiry_seconds)
        VALUES ('org-mig101', ${name}, ${holdExpiry})
      `.execute(db);
    }
  };

  const holdExpiryOf = async (name: string): Promise<number | null> => {
    const r = await sql<{ hold_expiry_seconds: number | null }>`
      SELECT hold_expiry_seconds FROM public.contexts WHERE name = ${name}
    `.execute(db);
    return r.rows[0].hold_expiry_seconds;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  beforeEach(async () => {
    // Every case starts from the pre-migration schema, so `up` is what each
    // one exercises.
    await sql`DELETE FROM public.contexts WHERE org_id = 'org-mig101'`.execute(db);
    await down(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('drops the default, so a context created without an expiry lands NULL', async () => {
    await insertContext('before-up');
    expect(await holdExpiryOf('before-up')).toBe(86400);

    await up(db);
    await insertContext('after-up');

    expect(await holdExpiryOf('after-up')).toBeNull();
  });

  it('backfills a stored zero to NULL and leaves a real value alone', async () => {
    await insertContext('zeroed', 0);
    await insertContext('nine-hundred', 900);

    await up(db);

    expect(await holdExpiryOf('zeroed')).toBeNull();
    expect(await holdExpiryOf('nine-hundred')).toBe(900);
  });

  it('is idempotent — running up twice changes nothing', async () => {
    await insertContext('zeroed', 0);
    await insertContext('nine-hundred', 900);

    await up(db);
    await up(db);
    await insertContext('after-two-ups');

    expect(await holdExpiryOf('zeroed')).toBeNull();
    expect(await holdExpiryOf('nine-hundred')).toBe(900);
    expect(await holdExpiryOf('after-two-ups')).toBeNull();
  });

  it('down restores the default without resurrecting the zeroed rows', async () => {
    await insertContext('zeroed', 0);

    await up(db);
    await down(db);
    await insertContext('after-down');

    expect(await holdExpiryOf('after-down')).toBe(86400);
    expect(await holdExpiryOf('zeroed')).toBeNull();
  });
});
