import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExecutionJobStatus } from '@kici-dev/engine';
import type { LockJob } from '@kici-dev/engine';
import type { RunContext } from '../cluster/coordinator.js';
import {
  routeOrDispatchJobs,
  registerDispatchedJobs,
  type RouteOrDispatchOptions,
} from './route-or-dispatch-jobs.js';

function stubLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function job(name: string, extra: Record<string, unknown> = {}): LockJob {
  return {
    _type: 'static',
    name,
    runsOn: [{ kind: 'exact', value: 'default' }],
    steps: [{ name: 'ping', run: 'echo ok' }],
    needs: [],
    ...extra,
  } as unknown as LockJob;
}

function runCtx(): RunContext {
  return {
    runId: 'run-1',
    deliveryId: 'manual_schedule:run-1',
    routingKey: 'github:42',
    event: 'manual_schedule',
    action: null,
    provider: 'github',
    payload: {},
    repoIdentifier: 'owner/repo',
    sha: 'abc123',
    ref: '',
    workflowName: 'wf',
  } as RunContext;
}

function baseOpts(overrides: Partial<RouteOrDispatchOptions> = {}): RouteOrDispatchOptions {
  return {
    newRunId: 'run-1',
    staticJobs: [job('beat')],
    workflowName: 'wf',
    repoUrl: 'https://example/repo.git',
    ref: '',
    sha: 'abc123',
    deliveryId: 'manual_schedule:run-1',
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
    runContext: runCtx(),
    buildJobConfig: () => ({ workflowName: 'wf' }),
    logger: stubLogger() as unknown as RouteOrDispatchOptions['logger'],
    label: 'Manual schedule',
    coordinator: null,
    dispatcher: { dispatch: vi.fn() } as unknown as RouteOrDispatchOptions['dispatcher'],
    ...overrides,
  };
}

describe('routeOrDispatchJobs', () => {
  afterEach(() => vi.useRealTimers());

  it('maps coordinator localJobs to dispatchedJobs and does not direct-dispatch', async () => {
    const coordinator = {
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [{ jobName: 'beat', jobId: 'j1' }],
        reroutedJobs: [],
        failedJobs: [],
      }),
    };
    const dispatcher = { dispatch: vi.fn() };
    const opts = baseOpts({
      coordinator: coordinator as unknown as RouteOrDispatchOptions['coordinator'],
      dispatcher: dispatcher as unknown as RouteOrDispatchOptions['dispatcher'],
    });

    const result = await routeOrDispatchJobs(opts);

    expect(result.dispatchedJobs).toEqual([
      { jobId: 'j1', jobName: 'beat', runsOnLabels: ['default'] },
    ]);
    expect(result.rejectedJobs).toEqual([]);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to direct dispatch with a "timed out" warn when the coordinator times out', async () => {
    vi.useFakeTimers();
    const coordinator = { routeJobs: vi.fn().mockReturnValue(new Promise(() => {})) };
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'a', jobId: 'j2' }),
    };
    const logger = stubLogger();
    const opts = baseOpts({
      coordinator: coordinator as unknown as RouteOrDispatchOptions['coordinator'],
      dispatcher: dispatcher as unknown as RouteOrDispatchOptions['dispatcher'],
      logger: logger as unknown as RouteOrDispatchOptions['logger'],
    });

    const promise = routeOrDispatchJobs(opts);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(result.dispatchedJobs).toEqual([
      { jobId: 'j2', jobName: 'beat', runsOnLabels: ['default'] },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Manual schedule coordinator routing timed out, falling back to direct dispatch',
      expect.any(Object),
    );
  });

  it('falls back with a "failed" (not "timed out") warn when routeJobs rejects', async () => {
    const coordinator = { routeJobs: vi.fn().mockRejectedValue(new Error('boom')) };
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'a', jobId: 'j3' }),
    };
    const logger = stubLogger();
    const opts = baseOpts({
      coordinator: coordinator as unknown as RouteOrDispatchOptions['coordinator'],
      dispatcher: dispatcher as unknown as RouteOrDispatchOptions['dispatcher'],
      logger: logger as unknown as RouteOrDispatchOptions['logger'],
    });

    await routeOrDispatchJobs(opts);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Manual schedule coordinator routing failed, falling back to direct dispatch',
      expect.any(Object),
    );
  });

  it('synthesizes a rejected entry on a direct-dispatch rejection', async () => {
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ status: 'rejected', reason: 'no capacity' }),
    };
    const opts = baseOpts({
      dispatcher: dispatcher as unknown as RouteOrDispatchOptions['dispatcher'],
    });

    const result = await routeOrDispatchJobs(opts);

    expect(result.dispatchedJobs).toHaveLength(1);
    expect(result.dispatchedJobs[0].jobId).toMatch(/^rejected-/);
    expect(result.rejectedJobs).toHaveLength(1);
    expect(result.rejectedJobs[0]).toMatchObject({ reason: 'no capacity' });
    expect(result.rejectedJobs[0].jobId).toBe(result.dispatchedJobs[0].jobId);
  });

  it('degrades gracefully on a FanoutError: rejects the bad job, dispatches the rest', async () => {
    const dispatcher = {
      dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'a', jobId: 'ok' }),
    };
    const opts = baseOpts({
      staticJobs: [job('bad', { matrix: { _type: 'static' } }), job('good')],
      dispatcher: dispatcher as unknown as RouteOrDispatchOptions['dispatcher'],
    });

    const result = await routeOrDispatchJobs(opts);

    expect(result.rejectedJobs.some((r) => r.reason.includes("job 'bad'"))).toBe(true);
    expect(result.dispatchedJobs.some((d) => d.jobName === 'good')).toBe(true);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1); // only 'good' materialized+dispatched
  });

  it('clears the race timer on a fast coordinator success (no pending timers)', async () => {
    vi.useFakeTimers();
    const coordinator = {
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [{ jobName: 'beat', jobId: 'j1' }],
        reroutedJobs: [],
        failedJobs: [],
      }),
    };
    const opts = baseOpts({
      coordinator: coordinator as unknown as RouteOrDispatchOptions['coordinator'],
    });

    await routeOrDispatchJobs(opts);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('registerDispatchedJobs', () => {
  it('early-returns and calls nothing when there are no dispatched jobs', async () => {
    const executionTracker = { addJobsToRun: vi.fn(), onJobStatus: vi.fn() };
    await registerDispatchedJobs({
      newRunId: 'run-1',
      dispatchedJobs: [],
      rejectedJobs: [],
      executionTracker: executionTracker as never,
    });
    expect(executionTracker.addJobsToRun).not.toHaveBeenCalled();
    expect(executionTracker.onJobStatus).not.toHaveBeenCalled();
  });

  it('registers jobs and marks rejected ones failed with the enum value', async () => {
    const executionTracker = { addJobsToRun: vi.fn(), onJobStatus: vi.fn() };
    await registerDispatchedJobs({
      newRunId: 'run-1',
      dispatchedJobs: [{ jobId: 'rejected-x', jobName: 'beat' }],
      rejectedJobs: [{ jobId: 'rejected-x', reason: 'no capacity' }],
      executionTracker: executionTracker as never,
    });
    expect(executionTracker.addJobsToRun).toHaveBeenCalledWith('run-1', [
      { jobId: 'rejected-x', jobName: 'beat' },
    ]);
    expect(executionTracker.onJobStatus).toHaveBeenCalledWith(
      'run-1',
      'rejected-x',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      { error: 'no capacity' },
    );
  });
});
