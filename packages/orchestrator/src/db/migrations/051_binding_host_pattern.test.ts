import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './051_binding_host_pattern.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig051_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 051_binding_host_pattern', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<string[]> => {
    const r = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='environment_bindings'`.execute(db);
    return r.rows.map((x) => x.column_name).sort();
  };

  const hostPatternDefault = async (): Promise<string | null> => {
    const r = await sql<{ column_default: string | null }>`
      SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='environment_bindings'
          AND column_name='host_pattern'`.execute(db);
    return r.rows[0]?.column_default ?? null;
  };

  const uniqueIndexCols = async (): Promise<string[][]> => {
    const r = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='environment_bindings'
          AND indexdef ILIKE '%UNIQUE%'`.execute(db);
    return r.rows.map(
      (x) =>
        x.indexdef
          .match(/\(([^)]*)\)/)?.[1]
          ?.split(',')
          .map((s) => s.trim()) ?? [],
    );
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

  it('adds host_pattern defaulting to **', async () => {
    expect(await columns()).toContain('host_pattern');
    expect(await hostPatternDefault()).toContain("'**'");
  });

  it('backfills existing rows to ** and extends the unique key to include host_pattern', async () => {
    await sql`INSERT INTO public.environments (id, org_id, name, type)
              VALUES ('11111111-1111-1111-1111-111111111111','org-a','prod','fixed')`.execute(db);
    // First binding with default host_pattern.
    await sql`INSERT INTO public.environment_bindings (org_id, environment_id, scope_pattern)
              VALUES ('org-a','11111111-1111-1111-1111-111111111111','prod/shared/**')`.execute(db);
    const backfilled = await sql<{ host_pattern: string }>`
      SELECT host_pattern FROM public.environment_bindings
        WHERE scope_pattern='prod/shared/**'`.execute(db);
    expect(backfilled.rows[0]?.host_pattern).toBe('**');

    // Same (env, scope) but a different host_pattern is now allowed by the 3-col unique.
    await sql`INSERT INTO public.environment_bindings (org_id, environment_id, scope_pattern, host_pattern)
              VALUES ('org-a','11111111-1111-1111-1111-111111111111','prod/shared/**','box-00002')`.execute(
      db,
    );
    // A duplicate of the 3-tuple is rejected.
    await expect(
      sql`INSERT INTO public.environment_bindings (org_id, environment_id, scope_pattern, host_pattern)
              VALUES ('org-a','11111111-1111-1111-1111-111111111111','prod/shared/**','box-00002')`.execute(
        db,
      ),
    ).rejects.toThrow();

    const indexes = await uniqueIndexCols();
    expect(indexes.some((cols) => cols.includes('host_pattern'))).toBe(true);
  });

  it('down() removes the column and up() is idempotent', async () => {
    // down() restores the 2-column unique, which the host-specific rows seeded
    // above would violate — drop the per-host row first so down() can succeed.
    await sql`DELETE FROM public.environment_bindings WHERE host_pattern <> '**'`.execute(db);
    await down(db);
    expect(await columns()).not.toContain('host_pattern');
    await up(db);
    await up(db);
    expect(await columns()).toContain('host_pattern');
  });
});
