/**
 * Real-Postgres coverage for the dashboard org resolved at Platform
 * authentication. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { beforeEach, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { resolveDashboardOrgContext } from './dashboard-org-context.js';

describeWithTestDb<Database>(
  'resolveDashboardOrgContext against a real database',
  { prefix: 'kici_dash_org', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeEach(async () => {
      db = getDb().db;
      await db.deleteFrom('sources').execute();
      await db.deleteFrom('generic_webhook_sources').execute();
      await db.deleteFrom('remote_sources').execute();
    });

    const source = (customer_id: string, routing_key: string) =>
      db
        .insertInto('sources')
        .values({ provider: 'github', name: routing_key, routing_key, customer_id } as never)
        .execute();
    const generic = (customer_id: string, routing_key: string) =>
      db
        .insertInto('generic_webhook_sources')
        .values({ customer_id, name: routing_key, routing_key } as never)
        .execute();
    const remote = (customer_id: string) =>
      db
        .insertInto('remote_sources')
        .values({ customer_id, routing_key: `remote:${customer_id}` } as never)
        .execute();

    it("picks the attached org's GitHub source over another org's", async () => {
      await source('org_B', 'github:2');
      await source('org_A', 'github:1');
      expect(await resolveDashboardOrgContext(db, 'org_A')).toEqual({
        orgId: 'org_A',
        routingKey: 'github:1',
      });
    });

    it("falls back to the attached org's generic source, then its remote anchor", async () => {
      await generic('org_A', 'generic:org_A:x');
      expect(await resolveDashboardOrgContext(db, 'org_A')).toEqual({
        orgId: 'org_A',
        routingKey: 'generic:org_A:x',
      });
      await db.deleteFrom('generic_webhook_sources').execute();
      await remote('org_A');
      expect(await resolveDashboardOrgContext(db, 'org_A')).toEqual({
        orgId: 'org_A',
        routingKey: 'remote:org_A',
      });
    });

    it('never returns a __default__ generic source for an attached org', async () => {
      // fails-when: the generic branch has no org filter.
      await generic('__default__', 'generic:__default__:x');
      await remote('org_A');
      expect(await resolveDashboardOrgContext(db, 'org_A')).toEqual({
        orgId: 'org_A',
        routingKey: 'remote:org_A',
      });
    });

    it('without an attached org, skips __default__ in every table', async () => {
      // breaks-if-wrong: the org-less scan still finds a real tenant.
      await source('__default__', 'github:9');
      await generic('__default__', 'generic:__default__:x');
      expect(await resolveDashboardOrgContext(db, undefined)).toBeUndefined();
      await generic('org_G', 'generic:org_G:x');
      expect(await resolveDashboardOrgContext(db, undefined)).toEqual({
        orgId: 'org_G',
        routingKey: 'generic:org_G:x',
      });
    });
  },
);
