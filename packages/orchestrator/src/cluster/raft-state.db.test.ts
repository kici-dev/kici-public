import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { RaftStateStore } from './raft-state.js';

/**
 * Real-Postgres coverage for the save a leaving coordinator makes: the cluster
 * shares one raft_state row, so that save must not overwrite a newer term the
 * remaining coordinators wrote after it announced it was leaving.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_raft_state_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('RaftStateStore against Postgres', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
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
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('raft_state').execute();
  });

  // fails-when: the leaving node's save overwrites the term and leader the
  // remaining coordinators elected after it announced it was leaving.
  it('keeps a newer term when a leaving node saves an older one', async () => {
    const store = new RaftStateStore({ db });
    await store.save({ currentTerm: 6, votedFor: 'orch-b', leaderId: 'orch-b' });

    await store.saveUnlessNewerTerm({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });

    expect(await store.load()).toEqual({
      currentTerm: 6,
      votedFor: 'orch-b',
      leaderId: 'orch-b',
    });
  });

  // breaks-if-wrong: the last coordinator to leave still records its state.
  it('writes when the stored term is not newer', async () => {
    const store = new RaftStateStore({ db });
    await store.save({ currentTerm: 5, votedFor: 'orch-a', leaderId: 'orch-a' });

    await store.saveUnlessNewerTerm({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });

    expect(await store.load()).toEqual({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });
  });

  // breaks-if-wrong: a cluster with no row yet gets one.
  it('inserts the row when none exists', async () => {
    const store = new RaftStateStore({ db });

    await store.saveUnlessNewerTerm({ currentTerm: 2, votedFor: null, leaderId: null });

    expect(await store.load()).toEqual({ currentTerm: 2, votedFor: null, leaderId: null });
  });
});
