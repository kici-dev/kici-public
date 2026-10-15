import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { EventLogStatus } from '@kici-dev/engine';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m141 from './141_event_log_shed.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 141, on a throwaway database migrated through 141.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips green when unset, fails loudly
 * when set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;

const describeDb = ADMIN_URL ? describe : describe.skip;

const TEST_DB = `kici_mig141_test_${process.pid}_${Date.now()}`;

/** Replace the database name in a connection URL. */
function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describe('migration 141 exports', () => {
  it('exports up and down', () => {
    expect(typeof m141.up).toBe('function');
    expect(typeof m141.down).toBe('function');
  });
});

/**
 * The CHECK constraint must name every member of the engine status enum the writer uses; an
 * enum member with no migration behind it is rejected by Postgres at write time on every
 * cluster, and this DB-free check catches that at authoring time. It reads the migration
 * source, not a copy of the list, so the two sides stay independent.
 */
describe('migration 141 covers the whole EventLogStatus vocabulary', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./141_event_log_shed.ts', import.meta.url)),
    'utf8',
  );
  const upBody = source.slice(source.indexOf('export async function up'), source.indexOf('down('));

  it.each(EventLogStatus.options)("names '%s' in the head constraint", (status) => {
    expect(upBody).toContain(`'${status}'::text`);
  });

  it('does not name a status the enum never defines', () => {
    // Positive control: the assertion above passes by reading real text, not
    // because `toContain` matches anything.
    expect(upBody).not.toContain(`'not_a_status'::text`);
  });
});

describeDb('migration 141_event_log_shed', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  // Safe: describeDb only runs when KICI_TEST_ADMIN_DATABASE_URL is set.
  const adminUrl = ADMIN_URL!;

  /** Insert a row with the given status, returning whether it was accepted. */
  const statusAccepted = async (status: string): Promise<boolean> => {
    try {
      await sql`
        INSERT INTO event_log
          (org_id, delivery_id, routing_key, event, source, provider,
           payload_size_bytes, payload_hash, status)
        VALUES ('org123456789', ${`d-${status}-${Date.now()}`}, 'rk', 'push',
                'relay', 'github', 0, 'hash', ${status})
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

    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});

    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it("accepts status = 'shed'", async () => {
    expect(await statusAccepted('shed')).toBe(true);
  });

  it('still accepts the pre-existing statuses', async () => {
    expect(await statusAccepted('lockfile_corrupt')).toBe(true);
    expect(await statusAccepted('lockfile_missing')).toBe(true);
    expect(await statusAccepted('processed')).toBe(true);
  });

  it('still rejects an unknown status', async () => {
    expect(await statusAccepted('not_a_status')).toBe(false);
  });

  it('down() removes shed from the allowed set', async () => {
    // down() restores the narrower constraint, which a real rollback can only do once no row
    // uses the retired status: clear the rows the earlier tests seeded first.
    await sql`DELETE FROM event_log WHERE status = 'shed'`.execute(db);
    await m141.down(db);
    expect(await statusAccepted('shed')).toBe(false);
    // up() restores it (and is idempotent).
    await m141.up(db);
    await m141.up(db);
    expect(await statusAccepted('shed')).toBe(true);
  });
});
