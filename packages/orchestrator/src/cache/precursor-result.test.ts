import { describe, expect, it } from 'vitest';
import { ExecutionJobStatus, type LockJob } from '@kici-dev/engine';
import { AgentJobFailedError } from './agent-job-failed-error.js';
import { PendingBuildTracker } from './pending-builds.js';
import { PendingDynamicTracker } from './pending-dynamics.js';
import { PendingGlobalEvalTracker } from './pending-global-evals.js';
import { PendingInitTracker } from './pending-inits.js';
import { extractPrecursorResult, settlePendingPrecursor } from './precursor-result.js';

const lockJob = (name: string): LockJob => ({
  _type: 'static',
  name,
  runsOn: [{ kind: 'exact', value: 'linux' }],
  needs: [],
  steps: [{ name: 'step-1', hasOutputs: false }],
});

describe('extractPrecursorResult', () => {
  it('returns null for an ordinary job frame', () => {
    // fails-when: an ordinary job's terminal data starts persisting a
    // precursor_result — every execution_jobs row would carry a payload.
    expect(extractPrecursorResult(undefined)).toBeNull();
    expect(extractPrecursorResult({ outputs: { a: 1 }, error: 'x' })).toBeNull();
  });

  it('keeps the build marker as a flag only', () => {
    expect(extractPrecursorResult({ buildComplete: true, workflowName: 'wf' })).toEqual({
      buildComplete: true,
    });
  });

  it('keeps the init result beside its marker', () => {
    expect(extractPrecursorResult({ initComplete: true, initResult: { env: { A: '1' } } })).toEqual(
      { initComplete: true, initResult: { env: { A: '1' } } },
    );
  });

  it('keeps the generated jobs beside the dynamic marker, defaulting to an empty list', () => {
    const jobs = [lockJob('gen-1')];
    expect(extractPrecursorResult({ dynamicComplete: true, dynamicJobs: jobs })).toEqual({
      dynamicComplete: true,
      dynamicJobs: jobs,
    });
    // fails-when: a dynamic marker with a malformed `dynamicJobs` would leak
    // the malformed value through instead of the empty list the settle path
    // resolves with.
    expect(extractPrecursorResult({ dynamicComplete: true, dynamicJobs: 'nope' })).toEqual({
      dynamicComplete: true,
      dynamicJobs: [],
    });
  });

  it('ignores a marker that is not literally true', () => {
    expect(extractPrecursorResult({ buildComplete: 'yes' })).toBeNull();
  });
});

describe('settlePendingPrecursor', () => {
  it('resolves a tracked build on a success carrying buildComplete', async () => {
    const pendingBuilds = new PendingBuildTracker();
    const settled = pendingBuilds.track('b1');
    expect(
      settlePendingPrecursor(
        { pendingBuilds },
        { jobId: 'b1', state: ExecutionJobStatus.enum.success, data: { buildComplete: true } },
      ),
    ).toBe(true);
    await expect(settled).resolves.toBeUndefined();
  });

  it('does not resolve a build on a success without the marker', () => {
    // fails-when: a bare `success` resolves the build — the awaiting pipeline
    // would read the caches before the agent uploaded the tarballs.
    const pendingBuilds = new PendingBuildTracker();
    void pendingBuilds.track('b1').catch(() => undefined);
    expect(
      settlePendingPrecursor(
        { pendingBuilds },
        { jobId: 'b1', state: ExecutionJobStatus.enum.success, data: {} },
      ),
    ).toBe(false);
    expect(pendingBuilds.has('b1')).toBe(true);
  });

  it('rejects a tracked build on failure with the reported error', async () => {
    const pendingBuilds = new PendingBuildTracker();
    const settled = pendingBuilds.track('b1');
    settlePendingPrecursor(
      { pendingBuilds },
      { jobId: 'b1', state: ExecutionJobStatus.enum.failed, data: { error: 'npm exploded' } },
    );
    await expect(settled).rejects.toThrow('npm exploded');
  });

  it('rejects a tracked build on an orchestrator-side terminal verdict', async () => {
    // fails-when: only `failed` / `cancelled` reject — a build a sibling's
    // stale sweep marked timed_out_stale would leave this waiter running out
    // its own build timeout on a job the fleet already gave up on.
    const pendingBuilds = new PendingBuildTracker();
    const settled = pendingBuilds.track('b1');
    expect(
      settlePendingPrecursor(
        { pendingBuilds },
        { jobId: 'b1', state: ExecutionJobStatus.enum.timed_out_stale, data: {} },
      ),
    ).toBe(true);
    await expect(settled).rejects.toThrow('Build timed_out_stale');
  });

  it('resolves a tracked init with its result and rejects with an AgentJobFailedError', async () => {
    const pendingInits = new PendingInitTracker();
    const ok = pendingInits.track('i1');
    settlePendingPrecursor(
      { pendingInits },
      {
        jobId: 'i1',
        state: ExecutionJobStatus.enum.success,
        data: { initComplete: true, initResult: { concurrencyGroup: 'deploy' } },
      },
    );
    await expect(ok).resolves.toEqual({ concurrencyGroup: 'deploy' });

    const bad = pendingInits.track('i2');
    settlePendingPrecursor(
      { pendingInits },
      {
        jobId: 'i2',
        state: ExecutionJobStatus.enum.cancelled,
        data: { initFailure: { scope: 'job', category: 'agent_spawn', message: 'gone' } },
      },
    );
    const err = await bad.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentJobFailedError);
    expect((err as AgentJobFailedError).initFailure?.message).toBe('gone');
    expect((err as Error).message).toBe('Init cancelled');
  });

  it('resolves a tracked dynamic eval with its generated jobs', async () => {
    const pendingDynamics = new PendingDynamicTracker();
    const settled = pendingDynamics.track('d1');
    const jobs = [lockJob('gen-1'), lockJob('gen-2')];
    settlePendingPrecursor(
      { pendingDynamics },
      {
        jobId: 'd1',
        state: ExecutionJobStatus.enum.success,
        data: { dynamicComplete: true, dynamicJobs: jobs },
      },
    );
    await expect(settled).resolves.toEqual(jobs);
  });

  it('rejects a global eval round that succeeds without a result payload', async () => {
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const settled = pendingGlobalEvals.track('g1');
    settlePendingPrecursor(
      { pendingGlobalEvals },
      { jobId: 'g1', state: ExecutionJobStatus.enum.success, data: {} },
    );
    await expect(settled).rejects.toThrow('without a result payload');
  });

  it('settles nothing for a job nobody awaits or a non-terminal state', () => {
    const pendingBuilds = new PendingBuildTracker();
    void pendingBuilds.track('b1').catch(() => undefined);
    expect(
      settlePendingPrecursor(
        { pendingBuilds },
        { jobId: 'other', state: ExecutionJobStatus.enum.success, data: { buildComplete: true } },
      ),
    ).toBe(false);
    expect(
      settlePendingPrecursor(
        { pendingBuilds },
        { jobId: 'b1', state: ExecutionJobStatus.enum.running, data: { buildComplete: true } },
      ),
    ).toBe(false);
    expect(pendingBuilds.has('b1')).toBe(true);
  });
});
