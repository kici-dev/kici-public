import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../../db/migration-provider.js';
import type { Database } from '../../db/types.js';
import { OrchestratorSigningKeyRepo } from '../../db/repos/signing-keys-repo.js';
import { SigningKeyStatus } from '../../oidc/signing-key-status.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';
import { generateInitialSigningKey } from './signing-key.js';

/**
 * `kici-admin signing-key generate` creates the initial key only while no key
 * is active. Orchestrator nodes create the same key on their own, so the
 * command must lose cleanly to a node that got there first.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_skg_test_${process.pid}_${Date.now()}`;
const MASTER_KEY = '0'.repeat(64);

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('generateInitialSigningKey', () => {
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
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('orchestrator_signing_keys').execute();
  });

  async function rows() {
    return db.selectFrom('orchestrator_signing_keys').select(['kid', 'status']).execute();
  }

  it('creates and activates the key when none is active', async () => {
    // breaks-if-wrong: the initial key must still be created on an empty table.
    const outcome = await generateInitialSigningKey(new OrchestratorSigningKeyRepo(db), MASTER_KEY);
    expect(outcome.created).toBe(true);
    expect(await rows()).toEqual([
      { kid: outcome.created ? outcome.kid : '', status: SigningKeyStatus.enum.active },
    ]);
  });

  it('reports the key a node activated first and leaves it active', async () => {
    // A node created the key after the command's check found none.
    const repo = new OrchestratorSigningKeyRepo(db);
    const first = await generateInitialSigningKey(repo, MASTER_KEY);
    const nodeKid = first.created ? first.kid : '';

    const outcome = await generateInitialSigningKey(repo, MASTER_KEY);
    // fails-when: generate activates unconditionally — it demotes the key the
    // nodes already signed with and memoized.
    expect(outcome).toEqual({ created: false, activeKid: nodeKid });
    expect(await rows()).toEqual([{ kid: nodeKid, status: SigningKeyStatus.enum.active }]);
  });
});
