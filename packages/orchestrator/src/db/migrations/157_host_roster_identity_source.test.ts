import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { down, up } from './157_host_roster_identity_source.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 157. Seeds `host_roster` BEFORE the
 * migration so the backfill runs over existing rows, the way it runs on every
 * upgraded customer database. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig157_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 157_host_roster_identity_source', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const sourceOf = async (agentId: string): Promise<string | undefined> => {
    const r = await sql<{ identity_source: string }>`
      SELECT identity_source FROM public.host_roster WHERE agent_id = ${agentId}
    `.execute(db);
    return r.rows[0]?.identity_source;
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
    const before = await migrateToPreviousMigration(db, import.meta.url);
    if (before.error) throw before.error;
    // A host whose agent registered (only an agent registration writes `platform`)
    // and a declared-only host.
    await sql`
      INSERT INTO public.host_roster (agent_id, lifecycle_class, labels, platform, arch)
      VALUES ('registered', 'static', '[]', 'linux', 'x64'),
             ('declared-only', 'static', '["role:db"]', NULL, NULL)
    `.execute(db);
    const after = await migrateToOwnMigration(db, import.meta.url);
    if (after.error) throw after.error;
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

  it('backfills a registered host as agent and a declared-only host as operator', async () => {
    // fails-when: the backfill is missing (both read operator) or keys on the
    // wrong column (e.g. connected_instance_id, NULL for both seeds).
    expect(await sourceOf('registered')).toBe('agent');
    // breaks-if-wrong: a declared-only host defaulting to platform would drop
    // every kici-admin-declared, never-connected host out of fan-out.
    expect(await sourceOf('declared-only')).toBe('operator');
  });

  it('is NOT NULL with the operator default', async () => {
    const r = await sql<{ is_nullable: string; column_default: string | null }>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'host_roster'
         AND column_name = 'identity_source'
    `.execute(db);
    expect(r.rows[0]?.is_nullable).toBe('NO');
    expect(r.rows[0]?.column_default).toContain('operator');
    await sql`INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
              VALUES ('fresh', 'static', '[]')`.execute(db);
    expect(await sourceOf('fresh')).toBe('operator');
  });

  it('rejects an unknown value', async () => {
    // fails-when: the CHECK constraint is missing.
    await expect(
      sql`UPDATE public.host_roster SET identity_source = 'dashboard' WHERE agent_id = 'fresh'`.execute(
        db,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('down() drops the column and up() restores it, idempotently', async () => {
    await down(db);
    const gone = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'host_roster' AND column_name = 'identity_source'
    `.execute(db);
    expect(gone.rows[0]?.n).toBe(0);
    await up(db);
    await up(db);
    expect(await sourceOf('registered')).toBe('agent');
  });
});
