import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus, JobQueue } from './job-queue.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres tests for the dispatch-plane ownership predicate.
 *
 * The predicate is a correlated `NOT EXISTS` against `cluster_instances` — a
 * mock records it without evaluating it, and the bug it fixes was invisible for
 * exactly that reason: every coordinator boot flipped every sibling's in-flight
 * row to `recovering` and failed it 120 seconds later while the agents ran
 * those jobs to completion.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_queue_ownership_test_${process.pid}_${Date.now()}`;

const SELF = 'coord-self';
const LIVE_SIBLING = 'coord-live';
const DEAD_SIBLING = 'coord-dead';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const GRACE_MS = 120_000;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('JobQueue ownership predicate (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let queue: JobQueue;
  const adminUrl = ADMIN_URL!;

  const heartbeat = async (instanceId: string, secondsAgo: number): Promise<void> => {
    const at = new Date(Date.now() - secondsAgo * 1000);
    await sql`
      INSERT INTO public.cluster_instances (instance_id, started_at, last_heartbeat_at)
      VALUES (${instanceId}, ${at}, ${at})
      ON CONFLICT (instance_id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at
    `.execute(db);
  };

  const insertDispatched = async (jobName: string, owner: string | null): Promise<void> => {
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, status, owner_instance_id, agent_id)
      VALUES (${RUN_ID}, 'ci', ${jobName}, '[]', '{}', 'https://x/y', 'main', 'abc',
              ${jobName}, 'rk', ${DispatchQueueStatus.Dispatched}, ${owner}, 'agent-1')
    `.execute(db);
  };

  const recoverableNames = async (): Promise<string[]> => {
    const rows = await queue.getOrphanedDispatchedJobs();
    const byId = await sql<{ id: string; job_name: string }>`
      SELECT id, job_name FROM public.dispatch_queue
    `.execute(db);
    const names = new Map(byId.rows.map((r) => [r.id, r.job_name]));
    return rows.map((r) => names.get(r.id) ?? r.id).sort();
  };

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
    queue = new JobQueue(db, {
      maxDepth: 100,
      defaultTimeoutMs: 600_000,
      instanceId: SELF,
      ownershipGraceMs: GRACE_MS,
    });
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${RUN_ID}::uuid, 'ci', 'github', 'owner/repo', 'main', 'abc',
              ${ExecutionRunStatus.enum.running})
    `.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterEach(async () => {
    await sql`TRUNCATE TABLE dispatch_queue`.execute(db);
    await sql`TRUNCATE TABLE cluster_instances`.execute(db);
  });

  describe('strict selection (startup recovery)', () => {
    it("recovers its own rows and a dead instance's, and spares a live sibling's", async () => {
      await heartbeat(SELF, 1);
      await heartbeat(LIVE_SIBLING, 5);
      await heartbeat(DEAD_SIBLING, 600);
      await insertDispatched('mine', SELF);
      await insertDispatched('live-sibling', LIVE_SIBLING);
      await insertDispatched('dead-sibling', DEAD_SIBLING);

      expect(await recoverableNames()).toEqual(['dead-sibling', 'mine']);
    });

    it('spares a row whose owner has no heartbeat row at all only when it is NULL', async () => {
      await heartbeat(SELF, 1);
      // An owner with no `cluster_instances` row is not alive — a crashed
      // coordinator that never came back. Its rows ARE recoverable.
      await insertDispatched('never-heartbeat', 'coord-vanished');
      // A NULL owner is "unknown", not "not mine". Recovering it during a
      // rolling upgrade would reproduce the whole bug for the upgrade window.
      await insertDispatched('unknown-owner', null);

      expect(await recoverableNames()).toEqual(['never-heartbeat']);
    });

    it('counts what it spared, split by why', async () => {
      await heartbeat(SELF, 1);
      await heartbeat(LIVE_SIBLING, 5);
      await insertDispatched('mine', SELF);
      await insertDispatched('live-a', LIVE_SIBLING);
      await insertDispatched('live-b', LIVE_SIBLING);
      await insertDispatched('unknown', null);

      expect(await queue.countSparedDispatchedJobs()).toEqual({
        ownedElsewhere: 2,
        unknownOwner: 1,
      });
    });

    it('treats a heartbeat exactly at the grace edge as dead', async () => {
      await heartbeat(SELF, 1);
      await heartbeat(LIVE_SIBLING, GRACE_MS / 1000 + 5);
      await insertDispatched('stale-sibling', LIVE_SIBLING);

      expect(await recoverableNames()).toEqual(['stale-sibling']);
    });
  });

  describe('permissive write guard (markRecovering)', () => {
    const idFor = async (jobName: string): Promise<string> => {
      const r = await sql<{ id: string }>`
        SELECT id FROM public.dispatch_queue WHERE job_name = ${jobName}
      `.execute(db);
      return r.rows[0]!.id;
    };

    it('refuses to flip a row a live sibling owns', async () => {
      await heartbeat(LIVE_SIBLING, 5);
      await insertDispatched('live-sibling', LIVE_SIBLING);

      expect(await queue.markRecovering(await idFor('live-sibling'), new Date(), 'agent-1')).toBe(
        false,
      );
    });

    it("flips its own row, a dead instance's, and an unknown-owner row", async () => {
      await heartbeat(SELF, 1);
      await heartbeat(DEAD_SIBLING, 600);
      await insertDispatched('mine', SELF);
      await insertDispatched('dead-sibling', DEAD_SIBLING);
      // A local disconnect must still be able to move a pre-upgrade row, which
      // is why the write guard admits NULL where the selection filter excludes
      // it.
      await insertDispatched('unknown-owner', null);

      expect(await queue.markRecovering(await idFor('mine'), new Date(), 'agent-1')).toBe(true);
      expect(await queue.markRecovering(await idFor('dead-sibling'), new Date(), 'agent-1')).toBe(
        true,
      );
      expect(await queue.markRecovering(await idFor('unknown-owner'), new Date(), 'agent-1')).toBe(
        true,
      );
    });
  });

  describe('ownership stamping', () => {
    const jobInput = (jobName: string) => ({
      runId: RUN_ID,
      workflowName: 'ci',
      jobName,
      runsOnLabels: [],
      jobConfig: {},
      repoUrl: 'https://x/y',
      ref: 'main',
      sha: 'abc',
      deliveryId: jobName,
      provider: 'github',
      providerContext: {},
      routingKey: 'rk',
    });

    const ownershipOf = async (id: string) =>
      await db
        .selectFrom('dispatch_queue')
        .select(['owner_instance_id', 'dispatched_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

    it('stamps the owner on a row born dispatched', async () => {
      // `insertDispatched` writes a row that is already `dispatched`, so it
      // never passes through `markDispatched`. An unstamped row reads as
      // unknown-owner, and startup recovery spares those — so the survivor of a
      // coordinator crash would never recover a directly-dispatched job.
      const { id } = await queue.insertDispatched(jobInput('direct'), 'agent-1');

      const row = await ownershipOf(id);
      expect(row.owner_instance_id).toBe(SELF);
      expect(row.dispatched_at).toBeInstanceOf(Date);
    });

    it('moves ownership to the reclaiming coordinator', async () => {
      await heartbeat(DEAD_SIBLING, 600);
      const { id } = await queue.insertDispatched(jobInput('reclaimed'), 'agent-1');
      await db
        .updateTable('dispatch_queue')
        .set({
          status: DispatchQueueStatus.Recovering,
          owner_instance_id: DEAD_SIBLING,
          dispatched_at: null,
        })
        .where('id', '=', id)
        .execute();

      expect(await queue.markDispatchedIfRecovering(id, 'agent-2')).toBe(true);

      // This coordinator holds the reconnecting agent's socket and arms the
      // row's timers, so it is the owner now — leaving the dead sibling stamped
      // would point every ownership question at the coordinator the recovery
      // was undoing.
      const row = await ownershipOf(id);
      expect(row.owner_instance_id).toBe(SELF);
      expect(row.dispatched_at).toBeInstanceOf(Date);
    });
  });
});
