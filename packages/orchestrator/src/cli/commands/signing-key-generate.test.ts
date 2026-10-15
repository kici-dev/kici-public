import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../../db/migration-provider.js';
import type { Database } from '../../db/types.js';
import { OrchestratorSigningKeyRepo } from '../../db/repos/signing-keys-repo.js';
import { SigningKeyStatus } from '../../oidc/signing-key-status.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { generateInitialSigningKey } from './signing-key.js';

const MASTER_KEY = '0'.repeat(64);

/**
 * `signing-key generate` creates the initial key only while none is active,
 * and loses cleanly to a node that created it first.
 */
describeWithTestDb<Database>(
  'generateInitialSigningKey',
  { prefix: 'kici_skg_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await db.deleteFrom('orchestrator_signing_keys').execute();
    });

    async function rows() {
      return db.selectFrom('orchestrator_signing_keys').select(['kid', 'status']).execute();
    }

    it('creates and activates the key when none is active', async () => {
      // breaks-if-wrong: the initial key must still be created on an empty table.
      const outcome = await generateInitialSigningKey(
        new OrchestratorSigningKeyRepo(db),
        MASTER_KEY,
      );
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
  },
);
