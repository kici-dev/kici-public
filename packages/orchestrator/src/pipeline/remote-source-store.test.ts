import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  getRemoteSource,
  provisionRemoteSource,
  remoteRoutingKeyFor,
} from './remote-source-store.js';
import { resolveOrgId } from './processor.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/** The DB assertions are gated on `KICI_TEST_ADMIN_DATABASE_URL`. */
describe('remoteRoutingKeyFor', () => {
  it('derives a stable remote:<orgId> key', () => {
    expect(remoteRoutingKeyFor('org_abc')).toBe('remote:org_abc');
    expect(remoteRoutingKeyFor('org_xyz123')).toBe('remote:org_xyz123');
  });
});

describeWithTestDb<Database>(
  'remote-source-store (real DB)',
  { prefix: 'kici_remotesrc_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

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
  },
);
