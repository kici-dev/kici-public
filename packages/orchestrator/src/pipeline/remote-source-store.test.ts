import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  getRemoteSource,
  provisionRemoteSource,
  remoteRoutingKeyFor,
} from './remote-source-store.js';
import { resolveOrgId } from './processor.js';
import type { Database } from '../db/types.js';

/**
 * Unit + real-Postgres integration test for the remote-source store. The
 * `remoteRoutingKeyFor` derivation is pure and always runs; the upsert /
 * resolution assertions are gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describe('remoteRoutingKeyFor', () => {
  it('derives a stable remote:<orgId> key', () => {
    expect(remoteRoutingKeyFor('org_abc')).toBe('remote:org_abc');
    expect(remoteRoutingKeyFor('org_xyz123')).toBe('remote:org_xyz123');
  });
});

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_remotesrc_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('remote-source-store (real DB)', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
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

  beforeEach(async () => {
    await db.deleteFrom('remote_sources').execute();
  });

  it('provisionRemoteSource upserts idempotently and updates cluster_id', async () => {
    await provisionRemoteSource(db, { orgId: 'org_abc', clusterId: 'c1' });
    await provisionRemoteSource(db, { orgId: 'org_abc', clusterId: 'c2' });
    const row = await getRemoteSource(db, 'org_abc');
    expect(row).toMatchObject({
      customer_id: 'org_abc',
      routing_key: 'remote:org_abc',
      cluster_id: 'c2',
    });
    const all = await db.selectFrom('remote_sources').selectAll().execute();
    expect(all).toHaveLength(1);
  });

  it('resolveOrgId resolves org from remote_sources when no webhook source matches', async () => {
    await provisionRemoteSource(db, { orgId: 'org_def456', clusterId: null });
    expect(await resolveOrgId(db, 'remote:org_def456')).toBe('org_def456');
    expect(await resolveOrgId(db, 'remote:org_missing')).toBe('__default__');
  });
});
