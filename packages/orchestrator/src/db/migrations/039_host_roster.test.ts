import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './039_host_roster.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig039_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 039_host_roster', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=${name}) AS exists`.execute(db);
    return r.rows[0]?.exists ?? false;
  };
  const columns = async (): Promise<string[]> => {
    const r = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='host_roster'`.execute(db);
    return r.rows.map((x) => x.column_name).sort();
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

  it('creates host_roster with expected columns', async () => {
    expect(await tableExists('host_roster')).toBe(true);
    expect(await columns()).toEqual(
      [
        'agent_id',
        'connected_instance_id',
        'created_at',
        'hostname',
        'id',
        'labels',
        'last_seen',
        'lifecycle_class',
        'platform',
        'arch',
        'token_id',
        'updated_at',
      ].sort(),
    );
  });

  it('enforces unique agent_id', async () => {
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
              VALUES ('a1','static','[]')`.execute(db);
    await expect(
      sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
              VALUES ('a1','ephemeral','[]')`.execute(db),
    ).rejects.toThrow();
  });

  it('rejects an invalid lifecycle_class', async () => {
    await expect(
      sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
              VALUES ('a2','bogus','[]')`.execute(db),
    ).rejects.toThrow();
  });

  it('down() drops and up() recreates idempotently', async () => {
    await down(db);
    expect(await tableExists('host_roster')).toBe(false);
    await up(db);
    await up(db);
    expect(await tableExists('host_roster')).toBe(true);
  });
});
