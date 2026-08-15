import { describe, expect, it } from 'vitest';
import { ExecutionJobStatus } from '@kici-dev/engine';
import {
  classifyUnroutable,
  terminalizeUnroutableJob,
  unroutableMessage,
  type TerminalizeDeps,
} from './terminalize-unroutable.js';
import { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';

const base = {
  lastProvisioningError: null,
  runsOnLabels: ['linux', 'gpu'],
  runsOnPatterns: [],
  excludeLabels: [],
  excludePatterns: [],
};

describe('classifyUnroutable', () => {
  it('is unroutable when nothing in the fleet can route the labels', () => {
    const r = classifyUnroutable(base, () => false);
    expect(r.unroutable).toBe(true);
    expect(r.status).toBe(ExecutionJobStatus.enum.unroutable);
    expect(r.errorMessage).toContain('runsOn [linux, gpu]');
  });

  it('is timed_out_stale when something could route it', () => {
    const r = classifyUnroutable(base, () => true);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
  });

  it('is never unroutable when a provisioning error was recorded', () => {
    // The scaler got far enough to attempt (and fail) a spawn, so the labels
    // DID route — the real cause is that failure, not the `runsOn`.
    const r = classifyUnroutable(
      { ...base, lastProvisioningError: 'image pull failed' },
      () => false,
    );
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toBe('image pull failed');
  });

  it('falls back to timed_out_stale when no probe is wired', () => {
    const r = classifyUnroutable(base, undefined);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toContain('Queue timeout expired');
  });

  it('renders regex matchers readably rather than as [object Object]', () => {
    const r = classifyUnroutable(
      {
        ...base,
        runsOnLabels: [],
        runsOnPatterns: [{ kind: 'regex', source: 'gpu-.*', flags: 'i' }],
      },
      () => false,
    );
    expect(r.errorMessage).toContain('/gpu-.*/i');
    expect(r.errorMessage).not.toContain('[object Object]');
  });
});

describe('unroutableMessage', () => {
  it('names the excluded selectors when the job has any', () => {
    const msg = unroutableMessage({ ...base, excludeLabels: ['spot'] });
    expect(msg).toContain('runsOn [linux, gpu]');
    expect(msg).toContain('excluding [spot]');
  });

  it('says any agent would do when the job declares no runsOn', () => {
    const msg = unroutableMessage({ ...base, runsOnLabels: [] });
    expect(msg).toContain('it declares no runsOn, so any agent would do');
  });
});

describe('terminalizeUnroutableJob and the global-eval tracker', () => {
  /**
   * A round job is the one queue entry with an in-process awaiter and no
   * `execution_runs` row, so every other branch of `terminalizeUnroutableJob`
   * is a no-op for it and the stub below never has to model more than the
   * first update returning zero rows.
   */
  const zeroRowDb = () =>
    ({
      updateTable: () => ({
        set: () => ({
          where() {
            return this;
          },
          executeTakeFirst: async () => ({ numUpdatedRows: 0n }),
        }),
      }),
    }) as unknown as TerminalizeDeps['db'];

  const expired = {
    ...base,
    id: 'queue-row-1',
    runId: 'run-1',
    jobName: '__globaleval__org/pipelines__abc',
  };

  it('settles the awaiting round when the queue declares the job unroutable', async () => {
    // Without this the orchestrator waits out its full ceiling for a job the
    // queue has already definitively failed — with the shipped defaults, a
    // 120s fast-fail followed by a 240s wait, twice.
    const tracker = new PendingGlobalEvalTracker();
    const settled = tracker.track('queue-row-1');
    const observed = settled.catch((err: Error) => err.message);

    await terminalizeUnroutableJob(
      {
        db: zeroRowDb(),
        executionTracker: {} as TerminalizeDeps['executionTracker'],
        canRouteLabels: () => false,
        pendingGlobalEvals: tracker,
      },
      expired,
    );

    await expect(observed).resolves.toContain('runsOn [linux, gpu]');
    expect(tracker.size).toBe(0);
  });

  it('is a no-op for a job id nothing is tracking', async () => {
    const tracker = new PendingGlobalEvalTracker();
    tracker.track('some-other-job').catch(() => {});
    await terminalizeUnroutableJob(
      {
        db: zeroRowDb(),
        executionTracker: {} as TerminalizeDeps['executionTracker'],
        canRouteLabels: () => false,
        pendingGlobalEvals: tracker,
      },
      expired,
    );
    expect(tracker.size).toBe(1);
  });
});
