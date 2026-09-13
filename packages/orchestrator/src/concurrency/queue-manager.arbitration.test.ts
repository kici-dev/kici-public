import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ConcurrencyQueueManager, ConcurrencySlotStatus } from './queue-manager.js';

/**
 * Real-Postgres correctness tests for concurrency-slot arbitration.
 *
 * `acquireSlot` is an advisory-locked transaction that counts and inserts. A
 * mock records the predicates without evaluating them, so neither the mutual
 * exclusion nor the restart durability is observable without a live server —
 * and both are exactly what `concurrency: { group, max: 1 }` promises a customer
 * serialising deploys.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_concurrency_arb_test_${process.pid}_${Date.now()}`;

const GROUP = 'deploy';
const RK = 'github:42';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const uuid = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

describeDb('ConcurrencyQueueManager — DB-arbitrated slots (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let manager: ConcurrencyQueueManager;
  const adminUrl = ADMIN_URL!;

  const seedRun = async (runId: string, status: string): Promise<void> => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${runId}::uuid, 'ci', 'github', 'owner/repo', 'main', 'abc', ${status})
      ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status
    `.execute(db);
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    // Several tests run two overlapping transactions, one of which blocks on
    // the other's advisory lock.
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB), max: 5 });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    manager = new ConcurrencyQueueManager(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterEach(async () => {
    await sql`TRUNCATE TABLE concurrency_groups`.execute(db);
    await sql`DELETE FROM execution_runs`.execute(db);
  });

  it('admits exactly one of two concurrent acquires on max: 1', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);

    const results = await Promise.all([
      manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 }),
      manager.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 1 }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await manager.getActiveRuns(GROUP, RK)).toHaveLength(1);
  });

  it('honours the persisted active row across a fresh manager (restart)', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);

    // A restart drops every process map. The DB row is the arbiter, so the cap
    // still holds — this is the case that let a second deploy start alongside
    // the one already deploying.
    const afterRestart = new ConcurrencyQueueManager(db);

    expect(await afterRestart.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 1 })).toBe(false);
  });

  it('re-acquiring an already-held slot does not consume a second one', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);

    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 2 })).toBe(true);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 2 })).toBe(true);

    expect(await manager.getActiveRuns(GROUP, RK)).toEqual([uuid(1)]);
    // The second slot is still free.
    expect(await manager.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 2 })).toBe(true);
  });

  it('scopes the cap per routing key', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);

    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);
    expect(await manager.acquireSlot(GROUP, 'github:99', uuid(2), uuid(2), { max: 1 })).toBe(true);
  });

  it('frees the slot on release so the next run can take it', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);

    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);
    await manager.releaseSlot(GROUP, RK, uuid(1));

    expect(await manager.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 1 })).toBe(true);
  });

  it('releases a slot whose run already finished, rather than blocking forever', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);

    // The run finished but its release never ran (a coordinator crash between
    // the two). On a max: 1 deploy gate that leaked slot would block every
    // later deploy forever.
    await seedRun(uuid(1), ExecutionRunStatus.enum.success);

    expect(await manager.getActiveRuns(GROUP, RK)).toEqual([]);
    expect(await manager.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 1 })).toBe(true);
  });

  it('reports the oldest active run for cancelInProgress', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);

    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 2 })).toBe(true);
    expect(await manager.acquireSlot(GROUP, RK, uuid(2), uuid(2), { max: 2 })).toBe(true);

    expect(await manager.getOldestRun(GROUP, RK)).toBe(uuid(1));
  });

  it('release and dequeue-next are one transaction, so a slot cannot leak between them', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);
    await manager.enqueue({ groupKey: GROUP, routingKey: RK, runId: uuid(2), jobId: uuid(2) });

    const next = await manager.onJobComplete(GROUP, RK, uuid(1));

    expect(next?.runId).toBe(uuid(2));
    // The dequeue flipped the waiter to active in its own transaction, so the
    // slot is held by the new run and never sat free.
    expect(await manager.getActiveRuns(GROUP, RK)).toEqual([uuid(2)]);
  });

  it('promotes the oldest queued waiter first', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);
    await seedRun(uuid(3), ExecutionRunStatus.enum.running);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);
    await manager.enqueue({ groupKey: GROUP, routingKey: RK, runId: uuid(2), jobId: uuid(2) });
    await manager.enqueue({ groupKey: GROUP, routingKey: RK, runId: uuid(3), jobId: uuid(3) });

    const next = await manager.onJobComplete(GROUP, RK, uuid(1));

    expect(next?.runId).toBe(uuid(2));
    expect(next?.jobId).toBe(uuid(2));
    expect(next?.groupKey).toBe(GROUP);
    expect(next?.routingKey).toBe(RK);
    expect(await manager.getActiveRuns(GROUP, RK)).toEqual([uuid(2)]);
  });

  it('returns null when nothing is queued', async () => {
    expect(await manager.dequeueNext(GROUP, RK)).toBeNull();
  });

  it('a concurrent acquire cannot slip into the gap between release and promote', async () => {
    // As two transactions the pair is not net-zero on the active set: run 3's
    // acquire counts the freed slot as available and inserts, and the promotion
    // then adds a second active row under `max: 1`. Held under one lock, the
    // acquire sees the same count either side of the release-and-promote.
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    await seedRun(uuid(2), ExecutionRunStatus.enum.running);
    await seedRun(uuid(3), ExecutionRunStatus.enum.running);
    expect(await manager.acquireSlot(GROUP, RK, uuid(1), uuid(1), { max: 1 })).toBe(true);
    await manager.enqueue({ groupKey: GROUP, routingKey: RK, runId: uuid(2), jobId: uuid(2) });

    const [, acquired] = await Promise.all([
      manager.onJobComplete(GROUP, RK, uuid(1)),
      manager.acquireSlot(GROUP, RK, uuid(3), uuid(3), { max: 1 }),
    ]);

    const active = await manager.getActiveRuns(GROUP, RK);
    expect(active).toHaveLength(1);
    // Whichever of the two won, exactly one run holds the slot — and if run 3
    // was refused it must not report otherwise.
    if (acquired) expect(active).toEqual([uuid(3)]);
    else expect(active).toEqual([uuid(2)]);
  });

  it('the partial unique index rejects a second active row for one run', async () => {
    await seedRun(uuid(1), ExecutionRunStatus.enum.running);
    const insertActive = () =>
      sql`
      INSERT INTO public.concurrency_groups (group_key, run_id, job_id, routing_key, status)
      VALUES (${GROUP}, ${uuid(1)}::uuid, ${uuid(1)}::uuid, ${RK}, ${ConcurrencySlotStatus.Active})
    `.execute(db);

    await insertActive();
    await expect(insertActive()).rejects.toThrow();
  });
});
