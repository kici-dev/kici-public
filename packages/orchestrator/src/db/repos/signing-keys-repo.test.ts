import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import type { Database } from '../types.js';
import { OrchestratorSigningKeyRepo, type UpsertActiveInput } from './signing-keys-repo.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_skr_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function input(kid: string, over: Partial<UpsertActiveInput> = {}): UpsertActiveInput {
  return {
    kid,
    public_jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', alg: 'ES256', use: 'sig', kid },
    encrypted_private_jwk: `enc-${kid}`,
    alg: 'ES256',
    signer_kind: 'db',
    key_ref: null,
    ...over,
  };
}

describeDb('OrchestratorSigningKeyRepo', () => {
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
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('activate → rotate demotes prior active to retiring; listTrusted returns both oldest-first', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    expect(await repo.upsertActive(input('kid-1'))).toBe(true);
    expect((await repo.getActiveRow())?.kid).toBe('kid-1');

    expect(await repo.upsertActive(input('kid-2'))).toBe(true);
    const active = await repo.getActiveRow();
    expect(active?.kid).toBe('kid-2');

    const trusted = await repo.listTrusted();
    expect(trusted.map((r) => r.kid)).toEqual(['kid-1', 'kid-2']);
    expect(trusted.find((r) => r.kid === 'kid-1')?.status).toBe('retiring');
    expect(trusted.find((r) => r.kid === 'kid-2')?.status).toBe('active');
    // db custody persists the wrapped private half
    expect(trusted.find((r) => r.kid === 'kid-2')?.encrypted_private_jwk).toBe('enc-kid-2');
  });

  it('re-activating the same active kid is a no-op', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-a'));
    expect(await repo.upsertActive(input('kid-a'))).toBe(false);
  });

  it('revoke removes a kid from listTrusted and refuses reactivation', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-x'));
    await repo.revoke('kid-x', 'compromised');
    const trusted = await repo.listTrusted();
    expect(trusted.map((r) => r.kid)).not.toContain('kid-x');
    await expect(repo.upsertActive(input('kid-x'))).rejects.toThrow(/revoked/);
  });

  it('retire moves a retiring key to retired (still trusted)', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    await repo.upsertActive(input('kid-r1'));
    await repo.upsertActive(input('kid-r2')); // demotes r1 → retiring
    await repo.retire('kid-r1');
    const trusted = await repo.listTrusted();
    expect(trusted.find((r) => r.kid === 'kid-r1')?.status).toBe('retired');
  });
});
