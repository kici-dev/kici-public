/**
 * Real-Postgres coverage for the cross-org context lookup that tells an
 * operator a bound context exists, but in another org. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ContextStore } from './context-store.js';
import { ContextType } from '@kici-dev/engine';

describeWithTestDb<Database>(
  'ContextStore.orgsMatchingContext against a real database',
  { prefix: 'kici_ctx_orgs', provider: createMigrationProvider() },
  (getDb) => {
    let store: ContextStore;

    beforeAll(async () => {
      const db: Kysely<Database> = getDb().db;
      store = new ContextStore(db);
      await store.create('org_run', { name: 'staging' });
      await store.create('org_other', { name: 'pages' });
      await store.create('org_glob', {
        name: 'preview-glob',
        type: ContextType.enum.glob,
        globPattern: 'pag*',
      });
      await store.create('org_nomatch', {
        name: 'other-glob',
        type: ContextType.enum.glob,
        globPattern: 'prod-*',
      });
      await store.create('org_run', { name: 'pages-run' });
    });

    it("returns another org's context of that name and another org's matching glob", async () => {
      expect(await store.orgsMatchingContext('pages', 'org_run')).toEqual([
        'org_glob',
        'org_other',
      ]);
    });

    it('excludes the run org itself', async () => {
      // fails-when: the run org is reported as "another org".
      expect(await store.orgsMatchingContext('pages', 'org_other')).toEqual(['org_glob']);
    });

    it('is empty when no other org has the context', async () => {
      // breaks-if-wrong: a name no other org holds reports nothing.
      expect(await store.orgsMatchingContext('staging', 'org_run')).toEqual([]);
    });
  },
);
