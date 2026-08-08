import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import type { TrustPolicy } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { DEFAULT_TRUST_POLICY, TrustPolicySource, TrustPolicyStore } from './trust-policy-store.js';
import type { Database } from '../db/types.js';

/**
 * Real-Postgres test for TrustPolicyStore. The store's whole reason to exist is
 * that the policy SURVIVES a restart, which a mocked query builder cannot show:
 * a fake proves the code called `insertInto`, not that the row is readable
 * afterwards. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_trustpolicy_test_${process.pid}_${Date.now()}`;

const POLICY: TrustPolicy = {
  forkPolicy: 'hold',
  unknownContributorPolicy: 'reject',
  workflowChangePolicy: 'allow',
  approvalExpiryHours: 48,
};

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('TrustPolicyStore', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let store: TrustPolicyStore;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    store = new TrustPolicyStore(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await sql`DELETE FROM org_trust_policy`.execute(db);
  });

  it('returns null when no row exists', async () => {
    expect(await store.get('org-absent')).toBeNull();
  });

  it('round-trips a platform push, stamped source=platform', async () => {
    await store.upsertFromPlatform('org-1', POLICY);
    const stored = await store.get('org-1');
    expect(stored).toMatchObject({ ...POLICY, source: TrustPolicySource.enum.platform });
    expect(stored!.updatedAt).toBeInstanceOf(Date);
  });

  it('stamps source=local on a local upsert', async () => {
    await store.upsertLocal('org-1', POLICY);
    expect((await store.get('org-1'))!.source).toBe(TrustPolicySource.enum.local);
  });

  it('a second push overwrites rather than duplicating the org row', async () => {
    await store.upsertFromPlatform('org-1', POLICY);
    await store.upsertFromPlatform('org-1', { ...POLICY, forkPolicy: 'reject' });
    const rows = await db
      .selectFrom('org_trust_policy')
      .selectAll()
      .where('customer_id', '=', 'org-1')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fork_policy).toBe('reject');
  });

  it('a platform push overwrites a local write (the Platform is the authority)', async () => {
    await store.upsertLocal('org-1', { forkPolicy: 'allow' });
    await store.upsertFromPlatform('org-1', POLICY);
    const stored = await store.get('org-1');
    expect(stored!.source).toBe(TrustPolicySource.enum.platform);
    expect(stored!.forkPolicy).toBe('hold');
  });

  it('fills a partial local patch from the strict defaults, not from nothing', async () => {
    await store.upsertLocal('org-1', { forkPolicy: 'allow' });
    expect(await store.get('org-1')).toMatchObject({
      forkPolicy: 'allow',
      unknownContributorPolicy: DEFAULT_TRUST_POLICY.unknownContributorPolicy,
      workflowChangePolicy: DEFAULT_TRUST_POLICY.workflowChangePolicy,
      approvalExpiryHours: DEFAULT_TRUST_POLICY.approvalExpiryHours,
    });
  });

  it('merges a partial local patch over the existing row', async () => {
    await store.upsertFromPlatform('org-1', POLICY);
    await store.upsertLocal('org-1', { approvalExpiryHours: 6 });
    expect(await store.get('org-1')).toMatchObject({
      forkPolicy: POLICY.forkPolicy,
      unknownContributorPolicy: POLICY.unknownContributorPolicy,
      workflowChangePolicy: POLICY.workflowChangePolicy,
      approvalExpiryHours: 6,
      source: TrustPolicySource.enum.local,
    });
  });

  it('keeps orgs isolated from one another', async () => {
    await store.upsertFromPlatform('org-1', POLICY);
    await store.upsertFromPlatform('org-2', { ...POLICY, forkPolicy: 'reject' });
    expect((await store.get('org-1'))!.forkPolicy).toBe('hold');
    expect((await store.get('org-2'))!.forkPolicy).toBe('reject');
  });

  it('reads back a policy value it does not know the vocabulary for', async () => {
    // The columns are TEXT, not the Zod enum: a value written by a newer
    // Platform must still be readable rather than failing the row.
    await sql`
      INSERT INTO org_trust_policy
        (customer_id, fork_policy, unknown_contributor_policy,
         workflow_change_policy, approval_expiry_hours, source)
      VALUES ('org-future', 'quarantine', 'hold', 'hold', 72, 'platform')
    `.execute(db);
    expect((await store.get('org-future'))!.forkPolicy).toBe('quarantine');
  });

  describe('upsertLocal transaction', () => {
    it('runs onWrite inside the same transaction as the policy write', async () => {
      // The admin route writes its `trust_policy.updated` audit row from here.
      // If the callback ran outside the transaction the audit could commit
      // while the policy rolled back (or vice versa), so prove the callback can
      // see the uncommitted row through the transaction it is handed.
      let seenInsideTx: string | undefined;
      const merged = await store.upsertLocal('org-tx', { forkPolicy: 'allow' }, async (trx) => {
        const row = await trx
          .selectFrom('org_trust_policy')
          .select('fork_policy')
          .where('customer_id', '=', 'org-tx')
          .executeTakeFirst();
        seenInsideTx = row?.fork_policy;
      });
      expect(seenInsideTx).toBe('allow');
      expect(merged.forkPolicy).toBe('allow');
      expect((await store.get('org-tx'))!.forkPolicy).toBe('allow');
    });

    it('rolls the policy write back when onWrite throws', async () => {
      // A policy that loosens `forkPolicy` must never land without its audit
      // row: a failed audit write has to take the policy write down with it.
      await expect(
        store.upsertLocal('org-rollback', { forkPolicy: 'allow' }, async () => {
          throw new Error('__audit_failed__');
        }),
      ).rejects.toThrow('__audit_failed__');
      expect(await store.get('org-rollback')).toBeNull();
    });

    it('leaves a pre-existing policy untouched when onWrite throws', async () => {
      // The insert is an upsert, so the rollback must restore the prior row
      // rather than merely skipping the create.
      await store.upsertFromPlatform('org-prior', POLICY);
      await expect(
        store.upsertLocal('org-prior', { forkPolicy: 'allow' }, async () => {
          throw new Error('__audit_failed__');
        }),
      ).rejects.toThrow('__audit_failed__');
      const after = (await store.get('org-prior'))!;
      expect(after.forkPolicy).toBe(POLICY.forkPolicy);
      expect(after.source).toBe(TrustPolicySource.enum.platform);
    });

    it('serialises a concurrent merge so neither operator’s field is lost', async () => {
      // Non-vacuous by construction. `onWrite` runs INSIDE the first
      // transaction, before it commits, so the second upsert provably starts
      // while the first row is still uncommitted. Without the per-org advisory
      // lock the second transaction reads no row (READ COMMITTED hides the
      // uncommitted one), merges `forkPolicy` down to the 'hold' default, and
      // its `ON CONFLICT DO UPDATE` overwrites every column once the first
      // commits — so `forkPolicy` would read 'hold' here. It can only read
      // 'allow' if the second merge was ordered after the first commit.
      let second: Promise<TrustPolicy> | undefined;
      let secondSettled = false;
      await store.upsertLocal('org-conc', { forkPolicy: 'allow' }, async () => {
        second = store.upsertLocal('org-conc', { approvalExpiryHours: 5 }).then((r) => {
          secondSettled = true;
          return r;
        });
        // Give the second transaction time to reach the lock (or, unlocked,
        // its SELECT) before this one commits.
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Guards against a vacuous pass: if the second upsert had already run
        // to completion here it never raced the first, and the assertions
        // below would hold for the wrong reason.
        expect(secondSettled).toBe(false);
      });
      await second;

      const after = (await store.get('org-conc'))!;
      expect(after.forkPolicy).toBe('allow');
      expect(after.approvalExpiryHours).toBe(5);
    });
  });
});
