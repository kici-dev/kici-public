import { describe, it, expect, vi } from 'vitest';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { catchUpNeedsGatedJobs } from './dispatch-matched-workflow.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import type { ProcessingDeps } from './processor.js';

/**
 * The needs gate is event-driven: `evaluateDownstreams` runs once, when an
 * upstream job reports terminal. Root jobs are handed to agents inside the
 * dispatch loop, but `execution_job_needs` is written only after that loop —
 * so an agent that answers inside the gap drives an evaluation that reads zero
 * edges, and the downstream never receives another wakeup. The run then hangs
 * with nothing logged as wrong.
 *
 * These tests pin the catch-up that closes the gap, and the two ways it must
 * NOT overreach: it may not re-open a gate the normal completion path already
 * claimed, and it may not release a job the rolling-wave scheduler is holding.
 */

const RUN_ID = 'run-catchup';

interface JobRow {
  run_id: string;
  job_id: string;
  job_name: string;
  status: string;
  needs_satisfied: boolean;
  ready_at: Date | null;
  group_name: string | null;
}

interface EdgeRow {
  run_id: string;
  job_name: string;
  upstream_name: string;
  run_on: string;
}

/** A minimal Kysely stand-in over two in-memory tables, mutated in place. */
function mockDb(jobs: JobRow[], edges: EdgeRow[]) {
  const rowsFor = (table: string): Record<string, unknown>[] =>
    (table === 'execution_jobs' ? jobs : edges) as unknown as Record<string, unknown>[];

  const predicates = () => {
    const wheres: Array<(r: Record<string, unknown>) => boolean> = [];
    const where = (col: string, op: string, val: unknown) => {
      wheres.push((r) => {
        if (op === '=') return r[col] === val;
        if (op === 'in' && Array.isArray(val)) return (val as unknown[]).includes(r[col]);
        return true;
      });
    };
    return { wheres, where };
  };

  return {
    selectFrom(table: string) {
      const { wheres, where } = predicates();
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.selectAll = () => chain;
      chain.distinctOn = () => chain;
      chain.where = (c: string, o: string, v: unknown) => {
        where(c, o, v);
        return chain;
      };
      const matching = () => rowsFor(table).filter((r) => wheres.every((w) => w(r)));
      chain.execute = async () => matching();
      chain.executeTakeFirst = async () => matching()[0];
      return chain;
    },
    updateTable(_table: string) {
      const { wheres, where } = predicates();
      let setValues: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.set = (v: Record<string, unknown>) => {
        setValues = v;
        return chain;
      };
      chain.where = (c: string, o: string, v: unknown) => {
        where(c, o, v);
        return chain;
      };
      const apply = () => {
        let n = 0;
        for (const row of jobs as unknown as Record<string, unknown>[]) {
          if (wheres.every((w) => w(row))) {
            Object.assign(row, setValues);
            n++;
          }
        }
        return { numUpdatedRows: BigInt(n) };
      };
      chain.execute = async () => apply();
      chain.executeTakeFirst = async () => apply();
      return chain;
    },
  } as unknown as NonNullable<ProcessingDeps['db']>;
}

function job(over: Partial<JobRow> & { job_name: string }): JobRow {
  return {
    run_id: RUN_ID,
    job_id: `id-${over.job_name}`,
    status: 'pending',
    needs_satisfied: false,
    ready_at: null,
    group_name: null,
    ...over,
  };
}

const RUN_ON_ALWAYS = JSON.stringify([...TERMINAL_JOB_STATES]);
const RUN_ON_SUCCESS = JSON.stringify([ExecutionJobStatus.enum.success]);

function makeCtx(jobs: JobRow[], edges: EdgeRow[]) {
  const onJobReadyCallback = vi.fn().mockResolvedValue(undefined);
  const onJobStatus = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    runId: RUN_ID,
    deps: {
      db: mockDb(jobs, edges),
      executionTracker: { onJobReadyCallback, onJobStatus },
    } as unknown as ProcessingDeps,
  } as unknown as WorkflowDispatchContext;
  return { ctx, onJobReadyCallback, onJobStatus };
}

/** The dispatchedJobs shape both gate sites produce for a held job. */
const gated = (name: string, extra: Record<string, unknown> = {}) => ({
  jobId: `needs-pending-${name}-uuid`,
  jobName: name,
  ...extra,
});

/** A real dispatch carries the dispatcher's own job id, not a synthetic one. */
const dispatched = (name: string) => ({ jobId: `id-${name}`, jobName: name });

describe('catchUpNeedsGatedJobs', () => {
  it('opens the gate for a downstream whose upstream went terminal before the edges existed', async () => {
    const jobs = [
      job({ job_name: 'build', status: ExecutionJobStatus.enum.failed, needs_satisfied: true }),
      job({ job_name: 'cleanup' }),
    ];
    const edges: EdgeRow[] = [
      { run_id: RUN_ID, job_name: 'cleanup', upstream_name: 'build', run_on: RUN_ON_ALWAYS },
    ];
    const { ctx, onJobReadyCallback } = makeCtx(jobs, edges);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [dispatched('build'), gated('cleanup')] });

    expect(onJobReadyCallback).toHaveBeenCalledExactlyOnceWith(RUN_ID, 'cleanup');
    // The claim is persisted, so a later evaluation cannot dispatch it again.
    expect(jobs[1]!.needs_satisfied).toBe(true);
  });

  it('terminalizes a downstream the upstream status excludes', async () => {
    const jobs = [
      job({ job_name: 'build', status: ExecutionJobStatus.enum.failed, needs_satisfied: true }),
      job({ job_name: 'test' }),
    ];
    const edges: EdgeRow[] = [
      { run_id: RUN_ID, job_name: 'test', upstream_name: 'build', run_on: RUN_ON_SUCCESS },
    ];
    const { ctx, onJobReadyCallback, onJobStatus } = makeCtx(jobs, edges);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [dispatched('build'), gated('test')] });

    expect(onJobReadyCallback).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledTimes(1);
    expect(onJobStatus.mock.calls[0]![2]).toBe(ExecutionJobStatus.enum.skipped);
  });

  it('leaves a downstream alone while its upstream is still running', async () => {
    const jobs = [
      job({ job_name: 'build', status: 'running', needs_satisfied: true }),
      job({ job_name: 'cleanup' }),
    ];
    const edges: EdgeRow[] = [
      { run_id: RUN_ID, job_name: 'cleanup', upstream_name: 'build', run_on: RUN_ON_ALWAYS },
    ];
    const { ctx, onJobReadyCallback, onJobStatus } = makeCtx(jobs, edges);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [dispatched('build'), gated('cleanup')] });

    expect(onJobReadyCallback).not.toHaveBeenCalled();
    expect(onJobStatus).not.toHaveBeenCalled();
    expect(jobs[1]!.needs_satisfied).toBe(false);
  });

  it('re-firing a job the completion path already claimed cannot run it twice', async () => {
    // recomputeNeedsSatisfied reports `dispatch` whether or not it won the
    // conditional claim, so the catch-up can re-fire a job evaluateDownstreams
    // already owns. That is safe only because dispatchReadyJob CONSUMES the
    // pending job context — the second callback finds none and no-ops. This
    // pins the contract that makes it safe rather than the count of calls.
    const jobs = [
      job({ job_name: 'build', status: ExecutionJobStatus.enum.success, needs_satisfied: true }),
      job({ job_name: 'cleanup', needs_satisfied: true }),
    ];
    const edges: EdgeRow[] = [
      { run_id: RUN_ID, job_name: 'cleanup', upstream_name: 'build', run_on: RUN_ON_ALWAYS },
    ];
    const { ctx, onJobReadyCallback } = makeCtx(jobs, edges);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [dispatched('build'), gated('cleanup')] });

    // It fires the ready callback; `dispatchReadyJob` behind it is the guard.
    expect(onJobReadyCallback).toHaveBeenCalledExactlyOnceWith(RUN_ID, 'cleanup');
  });

  it('never releases a job the rolling-wave scheduler is holding', async () => {
    // A wave-held child shares the `needs-pending-` id prefix (the release path
    // keys on it) but is gated by maxParallel, not by needs — opening its gate
    // here would run more children at once than the wave allows.
    const jobs = [job({ job_name: 'fanout-2' })];
    const { ctx, onJobReadyCallback } = makeCtx(jobs, []);

    await catchUpNeedsGatedJobs({
      ctx,
      dispatchedJobs: [gated('fanout-2', { waveGated: true })],
    });

    expect(onJobReadyCallback).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing was gated', async () => {
    const { ctx, onJobReadyCallback } = makeCtx([job({ job_name: 'build' })], []);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [dispatched('build')] });

    expect(onJobReadyCallback).not.toHaveBeenCalled();
  });

  it('leaves a group-gated job alone while its edges do not exist yet', async () => {
    // A job gated on a dynamic group has no execution_job_needs row until the
    // eval produces the members and resolveGroupEdges writes them.
    // checkAllUpstreamsSatisfied reads "no edges" as "no needs, dispatch now",
    // so recomputing such a job would release it before its group has run.
    const jobs = [job({ job_name: 'deploy' })];
    const { ctx, onJobReadyCallback, onJobStatus } = makeCtx(jobs, []);

    await catchUpNeedsGatedJobs({ ctx, dispatchedJobs: [gated('deploy')] });

    expect(onJobReadyCallback).not.toHaveBeenCalled();
    expect(onJobStatus).not.toHaveBeenCalled();
    expect(jobs[0]!.needs_satisfied).toBe(false);
  });

  it('recomputes only the gated jobs that already have edges', async () => {
    const jobs = [
      job({ job_name: 'build', status: ExecutionJobStatus.enum.success, needs_satisfied: true }),
      job({ job_name: 'cleanup' }),
      job({ job_name: 'deploy' }),
    ];
    // `cleanup` needs `build` (edge written now); `deploy` needs a dynamic
    // group whose edges arrive later.
    const edges: EdgeRow[] = [
      { run_id: RUN_ID, job_name: 'cleanup', upstream_name: 'build', run_on: RUN_ON_ALWAYS },
    ];
    const { ctx, onJobReadyCallback } = makeCtx(jobs, edges);

    await catchUpNeedsGatedJobs({
      ctx,
      dispatchedJobs: [dispatched('build'), gated('cleanup'), gated('deploy')],
    });

    expect(onJobReadyCallback).toHaveBeenCalledExactlyOnceWith(RUN_ID, 'cleanup');
    expect(jobs[2]!.needs_satisfied).toBe(false);
  });
});
