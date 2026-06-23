import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './045_host_properties.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig045_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 045_host_properties', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`.execute(db);
    return r.rows[0] ?? null;
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

  it('adds a NOT NULL jsonb host_properties column defaulting to {}', async () => {
    const col = await column('host_roster', 'host_properties');
    expect(col?.data_type).toBe('jsonb');
    expect(col?.is_nullable).toBe('NO');
    expect(col?.column_default).toContain('{}');
  });

  it('default {} applies on insert of a row that omits host_properties', async () => {
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
              VALUES ('mig045-default', 'static', '[]')`.execute(db);
    const r = await sql<{ host_properties: Record<string, unknown> }>`
      SELECT host_properties FROM public.host_roster WHERE agent_id='mig045-default'`.execute(db);
    expect(r.rows[0]?.host_properties).toEqual({});
  });

  it('down() drops and up() re-adds the column idempotently', async () => {
    await down(db);
    expect(await column('host_roster', 'host_properties')).toBeNull();
    await up(db);
    await up(db);
    expect(await column('host_roster', 'host_properties')).not.toBeNull();
  });
});
