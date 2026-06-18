import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './042_dispatch_queue_patterns.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig042_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 042_dispatch_queue_patterns', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const colExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='dispatch_queue' AND column_name=${name}) AS exists`.execute(
      db,
    );
    return r.rows[0]?.exists ?? false;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('adds runs_on_patterns and exclude_patterns columns', async () => {
    expect(await colExists('runs_on_patterns')).toBe(true);
    expect(await colExists('exclude_patterns')).toBe(true);
  });

  it('both columns are NOT NULL with a [] jsonb default', async () => {
    const r = await sql<{
      column_name: string;
      column_default: string | null;
      is_nullable: string;
    }>`
      SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='dispatch_queue'
          AND column_name IN ('runs_on_patterns', 'exclude_patterns')
        ORDER BY column_name`.execute(db);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.is_nullable).toBe('NO');
      expect(row.column_default).toMatch(/\[\]/);
    }
  });

  it('down() drops the columns, up() recreates idempotently', async () => {
    await down(db);
    expect(await colExists('runs_on_patterns')).toBe(false);
    expect(await colExists('exclude_patterns')).toBe(false);
    await up(db);
    await up(db);
    expect(await colExists('runs_on_patterns')).toBe(true);
    expect(await colExists('exclude_patterns')).toBe(true);
  });
});
