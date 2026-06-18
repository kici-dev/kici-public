import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './041_wave_gated.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig041_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 041_wave_gated', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const colExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='execution_jobs' AND column_name=${name}) AS exists`.execute(
      db,
    );
    return r.rows[0]?.exists ?? false;
  };
  const indexExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname=${name}) AS exists`.execute(db);
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

  it('adds wave_gated + policy columns + the wave index', async () => {
    expect(await colExists('wave_gated')).toBe(true);
    expect(await colExists('wave_max_parallel')).toBe(true);
    expect(await colExists('wave_fail_fast')).toBe(true);
    expect(await indexExists('idx_execution_jobs_wave')).toBe(true);
  });

  it('wave_gated is NOT NULL with a false default', async () => {
    const r = await sql<{ column_default: string | null; is_nullable: string }>`
      SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='execution_jobs' AND column_name='wave_gated'`.execute(
      db,
    );
    expect(r.rows[0]?.is_nullable).toBe('NO');
    expect(r.rows[0]?.column_default).toMatch(/false/);
  });

  it('down() drops the columns + index, up() recreates idempotently', async () => {
    await down(db);
    expect(await colExists('wave_gated')).toBe(false);
    expect(await colExists('wave_max_parallel')).toBe(false);
    expect(await colExists('wave_fail_fast')).toBe(false);
    expect(await indexExists('idx_execution_jobs_wave')).toBe(false);
    await up(db);
    await up(db);
    expect(await colExists('wave_gated')).toBe(true);
    expect(await colExists('wave_max_parallel')).toBe(true);
    expect(await colExists('wave_fail_fast')).toBe(true);
    expect(await indexExists('idx_execution_jobs_wave')).toBe(true);
  });
});
