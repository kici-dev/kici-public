import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { ExecutionJobStatus, TERMINAL_JOB_STATES, materializeFanout } from '@kici-dev/engine';
import type { LockJob, MaterializedJob } from '@kici-dev/engine';
import {
  evaluateDownstreams,
  insertEdgesForRun,
  resolveGroupEdges,
  recomputeNeedsSatisfied,
  checkSchedulerInvariant,
  getFailurePropagationTargets,
} from './needs-scheduler.js';

/** Build a non-fanned MaterializedJob from a minimal lock-job spec for scheduler tests. */
function mat(spec: { name: string; needs?: LockJob['needs']; dependsOnGroups?: string[] }): {
  jobs: MaterializedJob[];
  expansionMap: Map<string, readonly string[]>;
} {
  const lockJob = {
    _type: 'static' as const,
    name: spec.name,
    runsOn: 'ubuntu',
    needs: spec.needs ?? [],
    steps: [],
    ...(spec.dependsOnGroups ? { dependsOnGroups: spec.dependsOnGroups } : {}),
  } as LockJob;
  return {
    jobs: [{ lockJob, baseName: spec.name, expandedName: spec.name }],
    expansionMap: new Map([[spec.name, [spec.name]]]),
  };
}

/** Build a pending MockJobRow for the scheduler mock DB. */
function jobRow(name: string): {
  run_id: string;
  job_name: string;
  status: string;
  needs_satisfied: boolean;
  ready_at: Date | null;
  group_name: string | null;
} {
  return {
    run_id: RUN_ID,
    job_name: name,
    status: 'pending',
    needs_satisfied: false,
    ready_at: null,
    group_name: null,
  };
}

/** Merge several mat() results into one materialized list + expansion map. */
function combine(
  ...parts: Array<{ jobs: MaterializedJob[]; expansionMap: Map<string, readonly string[]> }>
): { jobs: MaterializedJob[]; expansionMap: Map<string, readonly string[]> } {
  const jobs: MaterializedJob[] = [];
  const expansionMap = new Map<string, readonly string[]>();
  for (const p of parts) {
    jobs.push(...p.jobs);
    for (const [k, v] of p.expansionMap) expansionMap.set(k, v);
  }
  return { jobs, expansionMap };
}

// --- DB mock helpers ---

/** Simulated in-memory DB state for scheduler tests. */
interface MockJobRow {
  run_id: string;
  job_name: string;
  status: string;
  needs_satisfied: boolean;
  ready_at: Date | null;
  group_name: string | null;
}

interface MockEdgeRow {
  run_id: string;
  job_name: string;
  upstream_name: string;
  run_on: string;
}

/** Success-only run-on set (the default gate). */
const RUN_ON_SUCCESS = JSON.stringify([ExecutionJobStatus.enum.success]);
/** All-terminal run-on set (when:'always'). */
const RUN_ON_ALWAYS = JSON.stringify([...TERMINAL_JOB_STATES]);

function createMockDb(jobRows: MockJobRow[], edgeRows: MockEdgeRow[]) {
  // Track state mutably so tests can observe updates
  const jobs = [...jobRows];
  const edges = [...edgeRows];

  // Build a chainable query builder mock
  function createSelectChain(rows: Record<string, unknown>[]) {
    const chain: Record<string, unknown> = {};
    let filteredRows = [...rows];
    const wheres: Array<(row: Record<string, unknown>) => boolean> = [];

    chain.select = vi.fn().mockReturnValue(chain);
    chain.selectAll = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
      wheres.push((row) => {
        const colVal = row[col];
        if (op === '=') return colVal === val;
        if (op === 'in' && Array.isArray(val)) return val.includes(colVal);
        return true;
      });
      return chain;
    });
    chain.distinctOn = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
    chain.execute = vi.fn().mockImplementation(() => {
      filteredRows = rows.filter((row) => wheres.every((w) => w(row)));
      return Promise.resolve(filteredRows);
    });
    chain.executeTakeFirst = vi.fn().mockImplementation(() => {
      filteredRows = rows.filter((row) => wheres.every((w) => w(row)));
      return Promise.resolve(filteredRows[0] ?? undefined);
    });
    return chain;
  }

  function createInsertChain() {
    let insertedValues: Record<string, unknown>[] = [];
    const chain: Record<string, unknown> = {};
    chain.values = vi
      .fn()
      .mockImplementation((vals: Record<string, unknown> | Record<string, unknown>[]) => {
        insertedValues = Array.isArray(vals) ? vals : [vals];
        return chain;
      });
    chain.onConflict = vi.fn().mockReturnValue(chain);
    chain.doNothing = vi.fn().mockReturnValue(chain);
    chain.doUpdateSet = vi.fn().mockReturnValue(chain);
    chain.execute = vi.fn().mockImplementation(() => {
      for (const v of insertedValues) {
        if (v.upstream_name !== undefined) {
          edges.push(v as unknown as MockEdgeRow);
        }
      }
      return Promise.resolve({ numInsertedOrUpdatedRows: BigInt(insertedValues.length) });
    });
    return chain;
  }

  function createUpdateChain() {
    let setValues: Record<string, unknown> = {};
    const wheres: Array<(row: Record<string, unknown>) => boolean> = [];
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      setValues = vals;
      return chain;
    });
    chain.where = vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
      wheres.push((row) => {
        const colVal = row[col];
        if (op === '=') return colVal === val;
        if (op === 'in' && Array.isArray(val)) return val.includes(colVal);
        return true;
      });
      return chain;
    });
    chain.execute = vi.fn().mockImplementation(() => {
      let count = 0;
      for (const job of jobs) {
        if (wheres.every((w) => w(job as unknown as Record<string, unknown>))) {
          Object.assign(job, setValues);
          count++;
        }
      }
      return Promise.resolve({ numUpdatedRows: BigInt(count) });
    });
    chain.executeTakeFirst = vi.fn().mockImplementation(() => {
      return chain.execute();
    });
    return chain;
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'execution_job_needs') {
        const edgeRecords = edges.map((e) => ({ ...e }));
        return createSelectChain(edgeRecords as unknown as Record<string, unknown>[]);
      }
      if (table === 'execution_jobs') {
        const jobRecords = jobs.map((j) => ({ ...j }));
        return createSelectChain(jobRecords as unknown as Record<string, unknown>[]);
      }
      return createSelectChain([]);
    }),
    insertInto: vi.fn().mockImplementation(() => createInsertChain()),
    updateTable: vi.fn().mockImplementation(() => createUpdateChain()),
    // Expose internal state for assertions
    _jobs: jobs,
    _edges: edges,
  };

  return db as unknown as Kysely<Database> & { _jobs: MockJobRow[]; _edges: MockEdgeRow[] };
}

const RUN_ID = '11111111-1111-1111-1111-111111111111';

describe('needs-scheduler', () => {
  describe('evaluateDownstreams', () => {
    it('returns empty array when completed job has no downstreams', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'success',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'lint', ExecutionJobStatus.enum.success);
      expect(result).toEqual([]);
    });

    it('returns downstream job when all upstreams are terminal success', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'success',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [{ run_id: RUN_ID, job_name: 'deploy', upstream_name: 'lint', run_on: RUN_ON_SUCCESS }],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'lint', ExecutionJobStatus.enum.success);
      expect(result).toEqual([{ jobName: 'deploy', action: 'dispatch' }]);
    });

    it('does NOT return downstream when another upstream is still pending', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'success',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'running',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [
          { run_id: RUN_ID, job_name: 'deploy', upstream_name: 'lint', run_on: RUN_ON_SUCCESS },
          { run_id: RUN_ID, job_name: 'deploy', upstream_name: 'test', run_on: RUN_ON_SUCCESS },
        ],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'lint', ExecutionJobStatus.enum.success);
      expect(result).toEqual([]);
    });

    it('skips downstream when upstream failed and run_on is success-only', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'failed',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [{ run_id: RUN_ID, job_name: 'deploy', upstream_name: 'test', run_on: RUN_ON_SUCCESS }],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'test', ExecutionJobStatus.enum.failed);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ jobName: 'deploy', action: 'skip' });
      expect(result[0].reason).toContain('test');
    });

    it('dispatches downstream when upstream failed and run_on includes failed', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'failed',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'notify',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [{ run_id: RUN_ID, job_name: 'notify', upstream_name: 'test', run_on: RUN_ON_ALWAYS }],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'test', ExecutionJobStatus.enum.failed);
      expect(result).toEqual([{ jobName: 'notify', action: 'dispatch' }]);
    });

    it('dispatches downstream when upstream skipped and run_on includes skipped (on-skip)', async () => {
      const onSkip = JSON.stringify([
        ExecutionJobStatus.enum.success,
        ExecutionJobStatus.enum.skipped,
      ]);
      const db = createMockDb(
        [
          { ...jobRow('gather'), status: ExecutionJobStatus.enum.skipped, needs_satisfied: true },
          jobRow('report'),
        ],
        [{ run_id: RUN_ID, job_name: 'report', upstream_name: 'gather', run_on: onSkip }],
      );
      const result = await evaluateDownstreams(
        db,
        RUN_ID,
        'gather',
        ExecutionJobStatus.enum.skipped,
      );
      expect(result).toEqual([{ jobName: 'report', action: 'dispatch' }]);
    });

    it('skips downstream when upstream skipped and run_on is success-only', async () => {
      const db = createMockDb(
        [
          { ...jobRow('gather'), status: ExecutionJobStatus.enum.skipped, needs_satisfied: true },
          jobRow('report'),
        ],
        [{ run_id: RUN_ID, job_name: 'report', upstream_name: 'gather', run_on: RUN_ON_SUCCESS }],
      );
      const result = await evaluateDownstreams(
        db,
        RUN_ID,
        'gather',
        ExecutionJobStatus.enum.skipped,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ jobName: 'report', action: 'skip' });
    });

    it('skips downstream when upstream failed and run_on is skipped-only (on-failure mismatch)', async () => {
      const skippedOnly = JSON.stringify([ExecutionJobStatus.enum.skipped]);
      const db = createMockDb(
        [
          { ...jobRow('probe'), status: ExecutionJobStatus.enum.failed, needs_satisfied: true },
          jobRow('handler'),
        ],
        [{ run_id: RUN_ID, job_name: 'handler', upstream_name: 'probe', run_on: skippedOnly }],
      );
      const result = await evaluateDownstreams(db, RUN_ID, 'probe', ExecutionJobStatus.enum.failed);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ jobName: 'handler', action: 'skip' });
    });
  });

  describe('resolveGroupEdges', () => {
    it('inserts concrete name-to-name edges when group resolves to N members', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'shard-1',
            status: 'pending',
            needs_satisfied: true,
            ready_at: null,
            group_name: 'tests',
          },
          {
            run_id: RUN_ID,
            job_name: 'shard-2',
            status: 'pending',
            needs_satisfied: true,
            ready_at: null,
            group_name: 'tests',
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      await resolveGroupEdges(
        db,
        RUN_ID,
        'tests',
        ['shard-1', 'shard-2'],
        [{ jobName: 'deploy', runOn: [ExecutionJobStatus.enum.success] }],
      );
      // Should have inserted 2 edges: deploy -> shard-1, deploy -> shard-2
      const deployEdges = db._edges.filter((e) => e.job_name === 'deploy');
      expect(deployEdges).toHaveLength(2);
      expect(deployEdges.map((e) => e.upstream_name).sort()).toEqual(['shard-1', 'shard-2']);
    });

    it('with empty group (0 members) sets needs_satisfied=true for dependent downstreams', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      await resolveGroupEdges(
        db,
        RUN_ID,
        'tests',
        [],
        [{ jobName: 'deploy', runOn: [ExecutionJobStatus.enum.success] }],
      );
      // No edges should be inserted
      expect(db._edges).toHaveLength(0);
    });

    it('correctly propagates runOn from dependent static jobs to each edge row', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'shard-1',
            status: 'pending',
            needs_satisfied: true,
            ready_at: null,
            group_name: 'tests',
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'notify',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      await resolveGroupEdges(
        db,
        RUN_ID,
        'tests',
        ['shard-1'],
        [
          { jobName: 'deploy', runOn: [ExecutionJobStatus.enum.success] },
          { jobName: 'notify', runOn: [...TERMINAL_JOB_STATES] as any },
        ],
      );
      const deployEdges = db._edges.filter((e) => e.job_name === 'deploy');
      const notifyEdges = db._edges.filter((e) => e.job_name === 'notify');
      expect(deployEdges[0].run_on).toBe(RUN_ON_SUCCESS);
      expect(notifyEdges[0].run_on).toBe(RUN_ON_ALWAYS);
    });
  });

  describe('insertEdgesForRun', () => {
    it('creates edge rows from lock file needs array', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      const { jobs, expansionMap } = combine(
        mat({ name: 'lint' }),
        mat({ name: 'test', needs: ['lint'] }),
        mat({ name: 'deploy', needs: ['lint', 'test'] }),
      );
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      // test -> lint, deploy -> lint, deploy -> test = 3 edges
      expect(db._edges).toHaveLength(3);
    });

    it('correctly handles NeedsEntry objects (extracts name and runOn)', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'notify',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      const { jobs, expansionMap } = combine(
        mat({ name: 'test' }),
        mat({ name: 'notify', needs: [{ name: 'test', runOn: [...TERMINAL_JOB_STATES] as any }] }),
      );
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      const notifyEdges = db._edges.filter((e) => e.job_name === 'notify');
      expect(notifyEdges).toHaveLength(1);
      expect(notifyEdges[0].run_on).toBe(RUN_ON_ALWAYS);
    });

    it('marks root jobs (no needs) as needs_satisfied=true', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [],
      );
      const { jobs, expansionMap } = combine(
        mat({ name: 'lint' }),
        mat({ name: 'deploy', needs: ['lint'] }),
      );
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      // lint is a root job, should be marked as satisfied
      const lintJob = db._jobs.find((j) => j.job_name === 'lint');
      expect(lintJob?.needs_satisfied).toBe(true);
    });

    it('expands an upstream matrix reference into one edge per child', async () => {
      const db = createMockDb([jobRow('test (a)'), jobRow('test (b)'), jobRow('deploy')], []);
      // Upstream `test` fans into two children; downstream `deploy` needs `test`.
      const upstream = materializeFanout([
        {
          _type: 'static',
          name: 'test',
          runsOn: 'ubuntu',
          needs: [],
          steps: [],
          matrix: { _type: 'static', values: ['a', 'b'] },
        } as LockJob,
      ]);
      const downstream = mat({ name: 'deploy', needs: ['test'] });
      const jobs = [...upstream.jobs, ...downstream.jobs];
      const expansionMap = new Map<string, readonly string[]>([
        ...upstream.expansionMap,
        ...downstream.expansionMap,
      ]);
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      const deployEdges = db._edges.filter((e) => e.job_name === 'deploy');
      expect(deployEdges.map((e) => e.upstream_name).sort()).toEqual(['test (a)', 'test (b)']);
    });

    it('gives each matrix child of a downstream the full upstream edge set', async () => {
      const db = createMockDb([jobRow('lint'), jobRow('build (a)'), jobRow('build (b)')], []);
      const upstream = mat({ name: 'lint' });
      const downstream = materializeFanout([
        {
          _type: 'static',
          name: 'build',
          runsOn: 'ubuntu',
          needs: ['lint'],
          steps: [],
          matrix: { _type: 'static', values: ['a', 'b'] },
        } as LockJob,
      ]);
      const jobs = [...upstream.jobs, ...downstream.jobs];
      const expansionMap = new Map<string, readonly string[]>([
        ...upstream.expansionMap,
        ...downstream.expansionMap,
      ]);
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      expect(db._edges.filter((e) => e.job_name === 'build (a)')).toHaveLength(1);
      expect(db._edges.filter((e) => e.job_name === 'build (b)')).toHaveLength(1);
      expect(db._edges.every((e) => e.upstream_name === 'lint')).toBe(true);
    });

    it('copies the runOn set onto every expanded matrix edge', async () => {
      const db = createMockDb([jobRow('test (a)'), jobRow('test (b)'), jobRow('notify')], []);
      const upstream = materializeFanout([
        {
          _type: 'static',
          name: 'test',
          runsOn: 'ubuntu',
          needs: [],
          steps: [],
          matrix: { _type: 'static', values: ['a', 'b'] },
        } as LockJob,
      ]);
      const downstream = mat({
        name: 'notify',
        needs: [{ name: 'test', runOn: [...TERMINAL_JOB_STATES] as any }],
      });
      const jobs = [...upstream.jobs, ...downstream.jobs];
      const expansionMap = new Map<string, readonly string[]>([
        ...upstream.expansionMap,
        ...downstream.expansionMap,
      ]);
      await insertEdgesForRun(db, RUN_ID, jobs, expansionMap);
      const notifyEdges = db._edges.filter((e) => e.job_name === 'notify');
      expect(notifyEdges).toHaveLength(2);
      expect(notifyEdges.every((e) => e.run_on === RUN_ON_ALWAYS)).toBe(true);
    });
  });

  describe('recomputeNeedsSatisfied', () => {
    it('correctly evaluates a job with mixed upstream statuses', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'success',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'failed',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [
          { run_id: RUN_ID, job_name: 'deploy', upstream_name: 'lint', run_on: RUN_ON_SUCCESS },
          { run_id: RUN_ID, job_name: 'deploy', upstream_name: 'test', run_on: RUN_ON_ALWAYS },
        ],
      );
      const results = await recomputeNeedsSatisfied(db, RUN_ID, ['deploy']);
      // lint=success (ok), test=failed but run_on=always admits it (ok) => all satisfied
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ jobName: 'deploy', action: 'dispatch' });
    });
  });

  describe('checkSchedulerInvariant', () => {
    it('detects stuck job with all-terminal upstreams and needs_satisfied=false', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'lint',
            status: 'success',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [{ run_id: RUN_ID, job_name: 'deploy', upstream_name: 'lint', run_on: RUN_ON_SUCCESS }],
      );
      const stuck = await checkSchedulerInvariant(db, RUN_ID);
      expect(stuck).toContain('deploy');
    });
  });

  describe('getFailurePropagationTargets', () => {
    it('finds transitive downstreams that should be skipped', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'failed',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'deploy',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'notify',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [
          { run_id: RUN_ID, job_name: 'deploy', upstream_name: 'test', run_on: RUN_ON_SUCCESS },
          { run_id: RUN_ID, job_name: 'notify', upstream_name: 'deploy', run_on: RUN_ON_SUCCESS },
        ],
      );
      const targets = await getFailurePropagationTargets(db, RUN_ID, 'test');
      expect(targets.sort()).toEqual(['deploy', 'notify']);
    });

    it('stops propagation at run_on edges that admit the status', async () => {
      const db = createMockDb(
        [
          {
            run_id: RUN_ID,
            job_name: 'test',
            status: 'failed',
            needs_satisfied: true,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'notify',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
          {
            run_id: RUN_ID,
            job_name: 'cleanup',
            status: 'pending',
            needs_satisfied: false,
            ready_at: null,
            group_name: null,
          },
        ],
        [
          { run_id: RUN_ID, job_name: 'notify', upstream_name: 'test', run_on: RUN_ON_ALWAYS },
          { run_id: RUN_ID, job_name: 'cleanup', upstream_name: 'notify', run_on: RUN_ON_SUCCESS },
        ],
      );
      const targets = await getFailurePropagationTargets(db, RUN_ID, 'test');
      // notify's run_on admits the failed status so it's not skipped; cleanup depends on notify not test
      expect(targets).toEqual([]);
    });
  });
});
