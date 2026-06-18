import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import * as m026 from './026_event_log_lockfile_corrupt.js';

/**
 * Real-Postgres test for migration 026.
 *
 * Creates a uniquely-named throwaway database, runs every migration up to 026
 * via the production migration provider, and asserts that the event_log status
 * CHECK constraint accepts 'lockfile_corrupt' (and still rejects garbage). The
 * throwaway database is dropped in teardown.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips green when unset, fails loudly
 * when set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;

const describeDb = ADMIN_URL ? describe : describe.skip;

const TEST_DB = `kici_mig026_test_${process.pid}_${Date.now()}`;

/** Replace the database name in a connection URL. */
function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describe('migration 026 exports', () => {
  it('exports up and down', () => {
    expect(typeof m026.up).toBe('function');
    expect(typeof m026.down).toBe('function');
  });
});

describeDb('migration 026_event_log_lockfile_corrupt', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  // describeDb only runs when KICI_TEST_ADMIN_DATABASE_URL is set, so the
  // non-null assertion is safe inside the suite body.
  const adminUrl = ADMIN_URL!;

  /** Insert a row with the given status, returning whether it was accepted. */
  const statusAccepted = async (status: string): Promise<boolean> => {
    try {
      await sql`
        INSERT INTO event_log
          (org_id, delivery_id, routing_key, event, source, provider,
           payload_size_bytes, payload_hash, status)
        VALUES ('org123456789', ${`d-${status}-${Date.now()}`}, 'rk', 'push',
                'direct', 'github', 0, 'hash', ${status})
      `.execute(db);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }

    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 60_000);

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

  it("accepts status = 'lockfile_corrupt'", async () => {
    expect(await statusAccepted('lockfile_corrupt')).toBe(true);
  });

  it('still accepts the pre-existing statuses', async () => {
    expect(await statusAccepted('lockfile_missing')).toBe(true);
    expect(await statusAccepted('processed')).toBe(true);
  });

  it('still rejects an unknown status', async () => {
    expect(await statusAccepted('not_a_status')).toBe(false);
  });

  it('down() removes lockfile_corrupt from the allowed set', async () => {
    // The earlier "accepts" tests seeded lockfile_corrupt rows in this shared
    // throwaway DB. down() restores the narrower constraint, which a real
    // rollback can only do once no surviving row uses the retired status — so
    // clear them first (the operator-side prerequisite this test exercises).
    await sql`DELETE FROM event_log WHERE status = 'lockfile_corrupt'`.execute(db);
    await m026.down(db);
    expect(await statusAccepted('lockfile_corrupt')).toBe(false);
    // up() restores it (and is idempotent).
    await m026.up(db);
    await m026.up(db);
    expect(await statusAccepted('lockfile_corrupt')).toBe(true);
  });
});
