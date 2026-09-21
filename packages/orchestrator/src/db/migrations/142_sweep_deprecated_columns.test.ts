import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import * as m142 from './142_sweep_deprecated_columns.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 142, the deprecated-column sweep.
 *
 * Half of it is a DATA migration (the `known` trust tier, the `reject` fork
 * switch, and the `known` context floor are rewritten), so the suite straddles
 * it: migrate to the migration before this one, seed the rows an upgraded
 * database holds — including values in every column the sweep drops — then
 * migrate to 142 and assert what moved and what is gone. Seeding after
 * `migrateToOwnMigration()` is impossible for the dropped columns, and would
 * leave the rewrites asserting against rows the migration never saw.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig142_test_${process.pid}_${Date.now()}`;
const TARGET_MIGRATION = '142_sweep_deprecated_columns';

const RUN_KNOWN = '11111111-1111-4111-8111-000000000142';
const RUN_TRUSTED = '22222222-2222-4222-8222-000000000142';
const RUN_NULL = '33333333-3333-4333-8333-000000000142';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describe('migration 142 exports', () => {
  it('exports up and down', () => {
    expect(typeof m142.up).toBe('function');
    expect(typeof m142.down).toBe('function');
  });
});

describeDb('migration 142_sweep_deprecated_columns', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnExists = async (table: string, column: string): Promise<boolean> => {
    const r = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
      ) AS present
    `.execute(db);
    return r.rows[0]!.present;
  };

  const trustTierOf = async (runId: string): Promise<string | null> => {
    const r = await sql<{ trust_tier: string | null }>`
      SELECT trust_tier FROM public.execution_runs WHERE run_id = ${runId}::uuid
    `.execute(db);
    if (r.rows.length !== 1) throw new Error(`expected one run ${runId}, got ${r.rows.length}`);
    return r.rows[0]!.trust_tier;
  };

  const forkPolicyOf = async (customerId: string): Promise<string> => {
    const r = await sql<{ fork_policy: string }>`
      SELECT fork_policy FROM public.org_trust_policy WHERE customer_id = ${customerId}
    `.execute(db);
    if (r.rows.length !== 1) throw new Error(`expected one policy row for ${customerId}`);
    return r.rows[0]!.fork_policy;
  };

  const minimumTrustOf = async (name: string): Promise<string | null> => {
    const r = await sql<{ minimum_trust: string | null }>`
      SELECT minimum_trust FROM public.contexts WHERE name = ${name}
    `.execute(db);
    if (r.rows.length !== 1) throw new Error(`expected one context named ${name}`);
    return r.rows[0]!.minimum_trust;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

    // 1. The schema as it stood before this migration existed.
    const before = await migrateToPreviousMigration(db, import.meta.url);
    if (before.error) throw before.error;

    // 2. The rows an upgraded database actually holds. Every seeded value below
    //    is one the current code can no longer write: the retired `known` tier
    //    and floor, the retired `reject` switch, and a value in each column the
    //    sweep drops (the two arm columns are NOT NULL at 141, so the policy
    //    rows must name them).
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, trust_tier)
      VALUES (${RUN_KNOWN}::uuid, 'wf', 'github', 'acme/app', 'main', 'sha142', 'known'),
             (${RUN_TRUSTED}::uuid, 'wf', 'github', 'acme/app', 'main', 'sha142', 'trusted'),
             (${RUN_NULL}::uuid, 'wf', 'github', 'acme/app', 'main', 'sha142', NULL)
    `.execute(db);
    await sql`
      INSERT INTO public.org_trust_policy
        (customer_id, fork_policy, unknown_contributor_policy, workflow_change_policy,
         approval_expiry_hours, source)
      VALUES ('org-142-reject', 'reject', 'hold', 'hold', 72, 'platform'),
             ('org-142-allow', 'allow', 'hold', 'hold', 72, 'platform')
    `.execute(db);
    await sql`
      INSERT INTO public.contexts (org_id, name, minimum_trust)
      VALUES ('org-142', 'ctx-known', 'known'),
             ('org-142', 'ctx-trusted', 'trusted'),
             ('org-142', 'ctx-none', NULL)
    `.execute(db);
    await sql`
      INSERT INTO public.org_settings (customer_id, global_workflow_elevated_repos)
      VALUES ('org-142', '[{"pattern": "acme/*"}]'::jsonb)
    `.execute(db);
    await sql`
      INSERT INTO public.cluster_settings (id, contributor_cache_ttl_ms)
      VALUES ('default', 60000)
    `.execute(db);
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, source_tar_hash)
      VALUES ('run-142', 'mig142', 'build', '["docker"]'::jsonb, '{}', 'https://x/y', 'main',
              'sha142', 'd-142', 'rk-142', 'deadbeef')
    `.execute(db);

    // 3. The migration under test, and only it. The harness throws if the call
    //    applied nothing, so a suite that had already reached 142 before the
    //    rows went in fails loudly instead of asserting against untouched rows.
    const after = await migrateToOwnMigration(db, import.meta.url);
    if (after.error) throw after.error;
    const applied = (after.results ?? []).map((r) => r.migrationName);
    if (applied.length !== 1 || applied[0] !== TARGET_MIGRATION) {
      throw new Error(
        `expected the straddle to apply exactly "${TARGET_MIGRATION}", applied ` +
          `[${applied.join(', ')}]`,
      );
    }
  }, 90_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('rewrites a run stored with the retired known tier to unknown', async () => {
    // fails-when: the execution_runs UPDATE is missing, or its batch loop stops
    // after zero passes. The row was seeded as `known` under 001..141.
    expect(await trustTierOf(RUN_KNOWN)).toBe('unknown');
  });

  it('leaves a trusted run and an untiered run untouched', async () => {
    // breaks-if-wrong: an UPDATE whose WHERE matches every row would demote a
    // trusted run to unknown, or invent a tier for a run that recorded none.
    expect(await trustTierOf(RUN_TRUSTED)).toBe('trusted');
    expect(await trustTierOf(RUN_NULL)).toBeNull();
  });

  it('rewrites a stored reject fork switch to ignore and leaves allow alone', async () => {
    // fails-when: the org_trust_policy UPDATE is missing, or its WHERE matches
    // every row (the allow row would then read ignore too).
    expect(await forkPolicyOf('org-142-reject')).toBe('ignore');
    expect(await forkPolicyOf('org-142-allow')).toBe('allow');
  });

  it('clears a context floor stored as known and keeps a trusted floor', async () => {
    // fails-when: the contexts UPDATE is missing. `known` admitted every
    // recognized contributor, which the store reads as no floor at all, so the
    // stored value becomes NULL rather than `trusted`.
    // breaks-if-wrong: a context configured to hold on `trusted` must keep it.
    expect(await minimumTrustOf('ctx-known')).toBeNull();
    expect(await minimumTrustOf('ctx-trusted')).toBe('trusted');
    expect(await minimumTrustOf('ctx-none')).toBeNull();
  });

  it.each([
    ['org_settings', 'global_workflow_elevated_repos'],
    ['cluster_settings', 'contributor_cache_ttl_ms'],
    ['org_trust_policy', 'unknown_contributor_policy'],
    ['org_trust_policy', 'workflow_change_policy'],
    ['dispatch_queue', 'source_tar_hash'],
  ])('drops %s.%s', async (table, column) => {
    // fails-when: the DROP COLUMN for this pair is missing. Each column held a
    // value when 142 ran, so the drop is exercised over real data, not an
    // empty table.
    expect(await columnExists(table, column)).toBe(false);
  });

  it('keeps the neighbouring columns the drop must not reach', async () => {
    // Positive control for `columnExists`: a probe that answered false for
    // every name would pass the drop assertions above for the wrong reason.
    expect(await columnExists('org_settings', 'global_workflow_allowed_repos')).toBe(true);
    expect(await columnExists('cluster_settings', 'webhook_dedup_ttl_ms')).toBe(true);
    expect(await columnExists('org_trust_policy', 'fork_policy')).toBe(true);
    expect(await columnExists('dispatch_queue', 'source_tar_digest')).toBe(true);
  });

  it('keeps the rows whose columns were dropped readable', async () => {
    // breaks-if-wrong: a DROP that took the row with it (or a table rename)
    // would lose the org's remaining settings.
    const settings = await sql<{ customer_id: string }>`
      SELECT customer_id FROM public.org_settings WHERE customer_id = 'org-142'
    `.execute(db);
    expect(settings.rows).toEqual([{ customer_id: 'org-142' }]);
    const cluster = await sql<{ id: string; webhook_dedup_ttl_ms: string | null }>`
      SELECT id, webhook_dedup_ttl_ms FROM public.cluster_settings
    `.execute(db);
    expect(cluster.rows).toEqual([{ id: 'default', webhook_dedup_ttl_ms: null }]);
    const queued = await sql<{ job_name: string }>`
      SELECT job_name FROM public.dispatch_queue WHERE run_id = 'run-142'
    `.execute(db);
    expect(queued.rows).toEqual([{ job_name: 'build' }]);
  });

  it('up() is idempotent', async () => {
    // A second run finds no legacy value and no column to drop; every statement
    // is guarded, so it must complete rather than throw on the missing columns.
    await expect(m142.up(db)).resolves.toBeUndefined();
    expect(await trustTierOf(RUN_TRUSTED)).toBe('trusted');
  });
});
