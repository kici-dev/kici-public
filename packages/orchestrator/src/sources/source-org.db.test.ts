/**
 * Real-Postgres coverage for moving a source's registrations with its org: the
 * move, the registry version bump, and the rollback of the `sources` update
 * when the move fails. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import type { LockWorkflow } from '@kici-dev/engine';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import { RegistrationStore } from '../registration/registration-store.js';
import { moveSourceToOrg, rehomeSourceRegistrations } from './source-org.js';
import { SourceStore } from './source-store.js';

const RK = 'github:4242';
const OTHER_RK = 'github:4343';

function lockWorkflow(name: string): LockWorkflow {
  return {
    name,
    triggers: [{ _type: 'push', repos: ['org/*'] }],
    jobs: [],
  } as unknown as LockWorkflow;
}

const noSecrets = { setSecret: async () => undefined } as unknown as PgSecretStore;

describeWithTestDb<Database>(
  'source org moves against a real database',
  { prefix: 'kici_source_org', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await sql`DROP TRIGGER IF EXISTS refuse_rehome ON workflow_registrations`.execute(db);
      await db.deleteFrom('workflow_registrations').execute();
      await db.deleteFrom('sources').execute();
      const sources = new SourceStore(db, noSecrets);
      await sources.addSource({ provider: 'github', name: 'a', appId: '4242', privateKey: 'k' });
      const registrations = new RegistrationStore(db);
      for (const [rk, repo] of [
        [RK, 'org/one'],
        [RK, 'org/two'],
        [OTHER_RK, 'org/three'],
      ] as const) {
        await registrations.replaceAll(
          repo,
          [lockWorkflow('ci')],
          rk,
          {},
          {
            customerId: '__default__',
          },
        );
      }
    });

    async function orgsOf(routingKey: string): Promise<string[]> {
      const rows = await db
        .selectFrom('workflow_registrations')
        .select('customer_id')
        .where('routing_key', '=', routingKey)
        .execute();
      return rows.map((r) => r.customer_id);
    }

    async function registryVersion(): Promise<number> {
      return (await new RegistrationStore(db).getVersion()) as number;
    }

    it('moves every registration of the routing key and bumps the registry version', async () => {
      const before = await registryVersion();
      const moved = await rehomeSourceRegistrations(db, RK, 'org_A');
      expect(moved).toBe(2);
      expect(await orgsOf(RK)).toEqual(['org_A', 'org_A']);
      expect(await registryVersion()).toBe(before + 1);
    });

    it('leaves other routing keys alone', async () => {
      await rehomeSourceRegistrations(db, RK, 'org_A');
      expect(await orgsOf(OTHER_RK)).toEqual(['__default__']);
    });

    it('does not bump the version when nothing moved', async () => {
      await rehomeSourceRegistrations(db, RK, 'org_A');
      const before = await registryVersion();
      expect(await rehomeSourceRegistrations(db, RK, 'org_A')).toBe(0);
      expect(await registryVersion()).toBe(before);
    });

    it('updateSource with a new customerId moves the registrations too', async () => {
      // fails-when: the sources update leaves the registrations in the old org.
      const store = new SourceStore(db, noSecrets);
      const updated = await store.updateSource(RK, { customerId: 'org_A' });
      expect(updated.customer_id).toBe('org_A');
      expect(await orgsOf(RK)).toEqual(['org_A', 'org_A']);
    });

    it('updateSource without a customerId does not touch registrations', async () => {
      const store = new SourceStore(db, noSecrets);
      await store.updateSource(RK, { name: 'renamed' });
      expect(await orgsOf(RK)).toEqual(['__default__', '__default__']);
    });

    it('moveSourceToOrg sets the org and moves the registrations', async () => {
      expect(await moveSourceToOrg(db, RK, 'org_A')).toBe(true);
      expect((await new SourceStore(db, noSecrets).getSource(RK))?.customer_id).toBe('org_A');
      expect(await orgsOf(RK)).toEqual(['org_A', 'org_A']);
    });

    it('moveSourceToOrg reports an unknown routing key', async () => {
      expect(await moveSourceToOrg(db, 'github:1', 'org_A')).toBe(false);
    });

    it('rolls the sources update back when the move fails', async () => {
      // fails-when: the move runs outside the sources update's transaction.
      await sql`
        CREATE OR REPLACE FUNCTION refuse_rehome() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'move refused'; END $$ LANGUAGE plpgsql
      `.execute(db);
      await sql`
        CREATE TRIGGER refuse_rehome BEFORE UPDATE ON workflow_registrations
        FOR EACH ROW EXECUTE FUNCTION refuse_rehome()
      `.execute(db);
      const store = new SourceStore(db, noSecrets);
      await expect(store.updateSource(RK, { customerId: 'org_A' })).rejects.toThrow('move refused');
      const source = await store.getSource(RK);
      expect(source?.customer_id).toBe('__default__');
    });
  },
);
