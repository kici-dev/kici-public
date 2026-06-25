import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './052_host_reach_metadata.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig052_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 052_host_reach_metadata', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
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

  it('adds the four nullable reach columns', async () => {
    const address = await column('host_roster', 'address');
    expect(address?.data_type).toBe('text');
    expect(address?.is_nullable).toBe('YES');

    const sshUser = await column('host_roster', 'ssh_user');
    expect(sshUser?.data_type).toBe('text');
    expect(sshUser?.is_nullable).toBe('YES');

    const sshPort = await column('host_roster', 'ssh_port');
    expect(sshPort?.data_type).toBe('integer');
    expect(sshPort?.is_nullable).toBe('YES');

    const sshKeySecret = await column('host_roster', 'ssh_key_secret');
    expect(sshKeySecret?.data_type).toBe('text');
    expect(sshKeySecret?.is_nullable).toBe('YES');
  });

  it('persists reach metadata on insert', async () => {
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels, address, ssh_user, ssh_port, ssh_key_secret)
              VALUES ('mig052-reach', 'static', '[]', '10.0.0.7', 'root', 2222, 'prod/bootstrap/ssh')`.execute(
      db,
    );
    const r = await sql<{
      address: string;
      ssh_user: string;
      ssh_port: number;
      ssh_key_secret: string;
    }>`
      SELECT address, ssh_user, ssh_port, ssh_key_secret
        FROM public.host_roster WHERE agent_id='mig052-reach'`.execute(db);
    expect(r.rows[0]).toEqual({
      address: '10.0.0.7',
      ssh_user: 'root',
      ssh_port: 2222,
      ssh_key_secret: 'prod/bootstrap/ssh',
    });
  });

  it('down() drops and up() re-adds the columns idempotently', async () => {
    await down(db);
    expect(await column('host_roster', 'address')).toBeNull();
    expect(await column('host_roster', 'ssh_key_secret')).toBeNull();
    await up(db);
    await up(db);
    expect(await column('host_roster', 'address')).not.toBeNull();
    expect(await column('host_roster', 'ssh_key_secret')).not.toBeNull();
  });
});
