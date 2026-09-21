import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionJobStatus } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { AgentJobFailedError } from './agent-job-failed-error.js';
import { PendingBuildTracker } from './pending-builds.js';
import { PendingDynamicTracker } from './pending-dynamics.js';
import { PendingInitTracker } from './pending-inits.js';
import {
  DEFAULT_PRECURSOR_DB_POLL_MS,
  PendingPrecursorDbWatcher,
} from './pending-precursor-db-watcher.js';

const BUILD_ID = '11111111-1111-4111-8111-111111111111';
const INIT_ID = '22222222-2222-4222-8222-222222222222';
const DYN_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeRow {
  job_id: string;
  run_id: string;
  status: string;
  precursor_result: Record<string, unknown> | null;
  error_message: string | null;
  init_failure: unknown;
}

/**
 * A fake of the one query the watcher issues. Records the ids it was asked
 * for and answers from `rows`, filtered the way the real predicates would —
 * by tracked id and by terminal status — so a test can assert both what was
 * asked and what came back.
 */
function fakeDb(rows: FakeRow[], opts: { fail?: Error } = {}) {
  const asked: string[][] = [];
  let whereIds: string[] = [];
  let whereStatuses: string[] = [];
  const chain = {
    innerJoin: () => chain,
    select: () => chain,
    where: (col: string, _op: string, val: unknown) => {
      if (col === 'dq.id') whereIds = val as string[];
      if (col === 'ej.status') whereStatuses = val as string[];
      return chain;
    },
    execute: async () => {
      asked.push([...whereIds]);
      if (opts.fail) throw opts.fail;
      return rows.filter((r) => whereIds.includes(r.job_id) && whereStatuses.includes(r.status));
    },
  };
  const db = { selectFrom: () => chain } as unknown as Kysely<Database>;
  return { db, asked };
}

const row = (partial: Partial<FakeRow> & { job_id: string; status: string }): FakeRow => ({
  run_id: RUN_ID,
  precursor_result: null,
  error_message: null,
  init_failure: null,
  ...partial,
});

describe('PendingPrecursorDbWatcher', () => {
  let pendingBuilds: PendingBuildTracker;
  let pendingInits: PendingInitTracker;
  let pendingDynamics: PendingDynamicTracker;
  let updateInMemoryJob: ReturnType<
    typeof vi.fn<(runId: string, jobId: string, status: string) => void>
  >;

  beforeEach(() => {
    pendingBuilds = new PendingBuildTracker();
    pendingInits = new PendingInitTracker();
    pendingDynamics = new PendingDynamicTracker();
    updateInMemoryJob = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const watcher = (db: Kysely<Database>, intervalMs?: number) =>
    new PendingPrecursorDbWatcher({
      db,
      pendingBuilds,
      pendingInits,
      pendingDynamics,
      executionTracker: { updateInMemoryJob },
      intervalMs,
    });

  it('issues no query while nothing is tracked', async () => {
    const { db, asked } = fakeDb([]);
    expect(await watcher(db).tick()).toBe(0);
    expect(asked).toEqual([]);
  });

  it('settles a build a sibling coordinator finished, and updates the in-memory job', async () => {
    const settled = pendingBuilds.track(BUILD_ID);
    const { db, asked } = fakeDb([
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { buildComplete: true },
      }),
    ]);
    // fails-when: the watcher reads only the local socket's view — the build
    // row a sibling wrote would never resolve this waiter and it would sit
    // out the build-coordinator timeout.
    expect(await watcher(db).tick()).toBe(1);
    await expect(settled).resolves.toBeUndefined();
    expect(asked).toEqual([[BUILD_ID]]);
    // breaks-if-wrong: without this the run's completion check on the
    // awaiting coordinator reads the build as pending forever.
    expect(updateInMemoryJob).toHaveBeenCalledWith(
      RUN_ID,
      BUILD_ID,
      ExecutionJobStatus.enum.success,
    );
    expect(pendingBuilds.has(BUILD_ID)).toBe(false);
  });

  it('does not settle a success row that carries no precursor marker', async () => {
    // fails-when: a bare `success` row resolves the build — an older sibling
    // that never wrote precursor_result would release the waiter before the
    // agent's own frame said the caches were populated.
    void pendingBuilds.track(BUILD_ID).catch(() => undefined);
    const { db } = fakeDb([row({ job_id: BUILD_ID, status: ExecutionJobStatus.enum.success })]);
    expect(await watcher(db).tick()).toBe(0);
    expect(pendingBuilds.has(BUILD_ID)).toBe(true);
    expect(updateInMemoryJob).not.toHaveBeenCalled();
  });

  it('rejects a build from a failed row using the stored error', async () => {
    const settled = pendingBuilds.track(BUILD_ID);
    const { db } = fakeDb([
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.failed,
        error_message: 'npm install exploded',
      }),
    ]);
    await watcher(db).tick();
    await expect(settled).rejects.toThrow('npm install exploded');
  });

  it('rejects a build the fleet reaped with an orchestrator-side verdict', async () => {
    const settled = pendingBuilds.track(BUILD_ID);
    const { db } = fakeDb([
      row({ job_id: BUILD_ID, status: ExecutionJobStatus.enum.timed_out_stale }),
    ]);
    await watcher(db).tick();
    await expect(settled).rejects.toThrow('Build timed_out_stale');
  });

  it('settles an init with its stored result and a dynamic eval with its stored jobs', async () => {
    const init = pendingInits.track(INIT_ID);
    const dyn = pendingDynamics.track(DYN_ID);
    const jobs = [
      {
        _type: 'static' as const,
        name: 'gen-1',
        runsOn: [{ kind: 'exact' as const, value: 'linux' }],
        needs: [],
        steps: [{ name: 's', hasOutputs: false }],
      },
    ];
    const { db, asked } = fakeDb([
      row({
        job_id: INIT_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { initComplete: true, initResult: { env: { A: '1' } } },
      }),
      row({
        job_id: DYN_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { dynamicComplete: true, dynamicJobs: jobs },
      }),
    ]);
    expect(await watcher(db).tick()).toBe(2);
    await expect(init).resolves.toEqual({ env: { A: '1' } });
    await expect(dyn).resolves.toEqual(jobs);
    expect(asked[0]).toEqual(expect.arrayContaining([INIT_ID, DYN_ID]));
  });

  it('rejects an init with the stored structured failure', async () => {
    const init = pendingInits.track(INIT_ID);
    const { db } = fakeDb([
      row({
        job_id: INIT_ID,
        status: ExecutionJobStatus.enum.failed,
        error_message: 'init blew up',
        init_failure: { scope: 'job', category: 'agent_spawn', message: 'no agent' },
      }),
    ]);
    await watcher(db).tick();
    const err = await init.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentJobFailedError);
    expect((err as AgentJobFailedError).message).toBe('init blew up');
    expect((err as AgentJobFailedError).initFailure?.message).toBe('no agent');
  });

  it('leaves a job the local socket already settled alone', async () => {
    const settled = pendingBuilds.track(BUILD_ID);
    pendingBuilds.resolve(BUILD_ID);
    await settled;
    const { db, asked } = fakeDb([
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { buildComplete: true },
      }),
    ]);
    expect(await watcher(db).tick()).toBe(0);
    // The tracker no longer holds the id, so it is not even asked for.
    expect(asked).toEqual([]);
    expect(updateInMemoryJob).not.toHaveBeenCalled();
  });

  it('skips a tracked id that is not a uuid rather than sending it to a uuid column', async () => {
    // fails-when: a synthetic id (`rejected-…`) reaches the `dq.id IN (…)`
    // predicate — Postgres refuses the cast and the whole tick fails, taking
    // every genuinely tracked job down with it.
    void pendingBuilds.track('rejected-not-a-uuid').catch(() => undefined);
    const settled = pendingBuilds.track(BUILD_ID);
    const { db, asked } = fakeDb([
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { buildComplete: true },
      }),
    ]);
    expect(await watcher(db).tick()).toBe(1);
    expect(asked).toEqual([[BUILD_ID]]);
    await expect(settled).resolves.toBeUndefined();
  });

  it('survives a read fault and re-reads on the next tick', async () => {
    const settled = pendingBuilds.track(BUILD_ID);
    const rows = [
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { buildComplete: true },
      }),
    ];
    const failing = fakeDb(rows, { fail: new Error('connection reset') });
    const w = watcher(failing.db);
    expect(await w.tick()).toBe(0);
    expect(pendingBuilds.has(BUILD_ID)).toBe(true);

    const healthy = fakeDb(rows);
    expect(await watcher(healthy.db).tick()).toBe(1);
    await expect(settled).resolves.toBeUndefined();
  });

  it('polls on its interval once started and stops cleanly', async () => {
    vi.useFakeTimers();
    const settled = pendingBuilds.track(BUILD_ID);
    const { db, asked } = fakeDb([
      row({
        job_id: BUILD_ID,
        status: ExecutionJobStatus.enum.success,
        precursor_result: { buildComplete: true },
      }),
    ]);
    const w = watcher(db, 50);
    w.start();
    w.start(); // idempotent — one timer
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(asked).toHaveLength(1);
    await expect(settled).resolves.toBeUndefined();
    w.stop();
    await vi.advanceTimersByTimeAsync(500);
    // breaks-if-wrong: a stopped watcher must not keep reading the database.
    expect(asked).toHaveLength(1);
  });

  it('defaults to a short poll interval', () => {
    // The interval is the latency a cross-coordinator build adds before the
    // awaiting pipeline dispatches its real jobs.
    expect(DEFAULT_PRECURSOR_DB_POLL_MS).toBeLessThanOrEqual(5_000);
  });
});
