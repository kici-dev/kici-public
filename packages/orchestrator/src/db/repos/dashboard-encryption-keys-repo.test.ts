import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../migration-provider.js';
import type { Database } from '../types.js';
import {
  DashboardEncryptionKeyRepo,
  type UpsertActiveEncryptionKeyInput,
} from './dashboard-encryption-keys-repo.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

function input(kid: string): UpsertActiveEncryptionKeyInput {
  return {
    kid,
    public_jwk: { kty: 'OKP', crv: 'X25519', x: `x-${kid}`, use: 'enc', kid },
    encrypted_private_key: `enc-${kid}`,
  };
}

describeWithTestDb<Database>(
  'DashboardEncryptionKeyRepo',
  { prefix: 'kici_dek_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

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
  },
);
