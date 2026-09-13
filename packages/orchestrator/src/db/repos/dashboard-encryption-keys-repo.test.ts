import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import type { Database } from '../types.js';
import {
  DashboardEncryptionKeyRepo,
  type UpsertActiveEncryptionKeyInput,
} from './dashboard-encryption-keys-repo.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_dek_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function input(kid: string): UpsertActiveEncryptionKeyInput {
  return {
    kid,
    public_jwk: { kty: 'OKP', crv: 'X25519', x: `x-${kid}`, use: 'enc', kid },
    encrypted_private_key: `enc-${kid}`,
  };
}

describeDb('DashboardEncryptionKeyRepo', () => {
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

  it('activates a key; getActiveRow + getByKid resolve it', async () => {
    const repo = new DashboardEncryptionKeyRepo(db);
    expect(await repo.upsertActive(input('kid-1'))).toBe(true);
    expect((await repo.getActiveRow())?.kid).toBe('kid-1');
    expect((await repo.getByKid('kid-1'))?.encrypted_private_key).toBe('enc-kid-1');
    expect(await repo.getByKid('nope')).toBeNull();
  });

  it('rotation demotes the prior active to revoked but keeps it resolvable by kid', async () => {
    const repo = new DashboardEncryptionKeyRepo(db);
    expect(await repo.upsertActive(input('kid-2'))).toBe(true);
    const active = await repo.getActiveRow();
    expect(active?.kid).toBe('kid-2');

    // The rotated-out kid-1 leaves the published JWKS but stays resolvable.
    const nonRevoked = await repo.listNonRevoked();
    expect(nonRevoked.map((r) => r.kid)).toEqual(['kid-2']);
    const rotated = await repo.getByKid('kid-1');
    expect(rotated?.status).toBe('revoked');
    // listServed still returns the revoked key so in-flight browsers decrypt.
    expect((await repo.listServed()).map((r) => r.kid)).toEqual(
      expect.arrayContaining(['kid-1', 'kid-2']),
    );
  });

  it('re-activating the same active kid is a no-op', async () => {
    const repo = new DashboardEncryptionKeyRepo(db);
    expect(await repo.upsertActive(input('kid-2'))).toBe(false);
  });
});
