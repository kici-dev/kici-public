/**
 * Real-Postgres coverage for the commit a registration's dependency-cache key
 * was written for. The key must survive a round trip through the real columns,
 * and a write that moves the row's commit without the key (what a writer from
 * before the key columns does) must leave the row with no usable key. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import type { LockWorkflow } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { RegistrationStore } from './registration-store.js';

const REPO = 'org/ci';
const ROUTING_KEY = 'github:42';

function lockWorkflow(name: string): LockWorkflow {
  return {
    name,
    triggers: [{ _type: 'push', repos: ['org/*'] }],
    jobs: [],
  } as unknown as LockWorkflow;
}

describeWithTestDb<Database>(
  'RegistrationStore dependency-cache key against a real database',
  { prefix: 'kici_reg_dep_key', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

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
  },
);
