/**
 * Real-Postgres coverage for the commit a registration's dependency-cache key
 * was written for. The key must survive a round trip through the real columns,
 * and a write that moves the row's commit without the key (what a writer from
 * before the key columns does) must leave the row with no usable key. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import type { LockWorkflow } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { RegistrationStore } from './registration-store.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_reg_dep_key_${process.pid}_${Date.now()}`;

const REPO = 'org/ci';
const ROUTING_KEY = 'github:42';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function lockWorkflow(name: string): LockWorkflow {
  return {
    name,
    triggers: [{ _type: 'push', repos: ['org/*'] }],
    jobs: [],
  } as unknown as LockWorkflow;
}

describeDb('RegistrationStore dependency-cache key against a real database', () => {
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
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
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

  async function register(store: RegistrationStore, name: string, sha: string, lock: string) {
    await store.replaceAll(
      REPO,
      [lockWorkflow(name)],
      ROUTING_KEY,
      {},
      {
        customerId: 'org-1',
        commitSha: sha,
        depCacheKey: { lockfileHash: lock, siblingsDigest: `siblings-${sha}` },
      },
    );
  }

  async function keyOf(store: RegistrationStore, name: string) {
    const rows = await store.getByRoutingKeyAndRepo(ROUTING_KEY, REPO);
    const row = rows.find((r) => r.workflow_name === name);
    return { commitSha: row?.commitSha, lockfileHash: row?.lockfileHash };
  }

  it("uses a key written with the row's current commit", async () => {
    const store = new RegistrationStore(db);
    await register(store, 'current', 'a1', 'lock-a1');

    // breaks-if-wrong: a registration written by a current writer keeps its key
    expect(await keyOf(store, 'current')).toEqual({ commitSha: 'a1', lockfileHash: 'lock-a1' });
  });

  it('drops the key once a writer that does not know it moves the commit', async () => {
    const store = new RegistrationStore(db);
    await register(store, 'moved', 'a0', 'lock-a0');
    // An older orchestrator or kici-admin rewrites the entry at a1 and leaves the key columns.
    await sql`
      UPDATE workflow_registrations SET commit_sha = 'a1', updated_at = now()
       WHERE workflow_name = 'moved'
    `.execute(db);

    // fails-when: the a0 lock file's key is used for the a1 lock entry, so a global run
    // restores dependencies built for a lock file it does not execute
    expect(await keyOf(store, 'moved')).toEqual({ commitSha: 'a1', lockfileHash: null });

    // breaks-if-wrong: the next current write restores the key at its own commit
    await register(store, 'moved', 'a2', 'lock-a2');
    expect(await keyOf(store, 'moved')).toEqual({ commitSha: 'a2', lockfileHash: 'lock-a2' });
  });
});
