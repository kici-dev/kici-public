import { describe, it, expect } from 'vitest';
import type { LockJob } from '@kici-dev/engine';
import { PendingTracker } from './pending-tracker.js';
import { PendingBuildTracker } from './pending-builds.js';
import { PendingInitTracker, type InitResult } from './pending-inits.js';
import { PendingDynamicTracker } from './pending-dynamics.js';

function mockLockJob(name: string): LockJob {
  return {
    _type: 'static',
    name,
    runsOn: 'linux',
    needs: [],
    steps: [{ name: 'step-1', hasOutputs: false }],
  };
}

interface TrackerCase<T> {
  name: string;
  make: () => PendingTracker<T>;
  resolveValue: T;
  expectedDisconnectError: string;
}

const cases: TrackerCase<unknown>[] = [
  {
    name: 'PendingBuildTracker',
    make: () => new PendingBuildTracker() as unknown as PendingTracker<unknown>,
    resolveValue: undefined,
    expectedDisconnectError: 'Build agent disconnected',
  },
  {
    name: 'PendingInitTracker',
    make: () => new PendingInitTracker() as unknown as PendingTracker<unknown>,
    resolveValue: { environmentName: 'staging' } satisfies InitResult,
    expectedDisconnectError: 'Init agent disconnected',
  },
  {
    name: 'PendingDynamicTracker',
    make: () => new PendingDynamicTracker() as unknown as PendingTracker<unknown>,
    resolveValue: [mockLockJob('gen-1'), mockLockJob('gen-2')] satisfies LockJob[],
    expectedDisconnectError: 'Dynamic eval agent disconnected',
  },
];

describe.each(cases)('$name (via PendingTracker generic)', (tc) => {
  it('resolves tracked job with the provided value', async () => {
    const tracker = tc.make();
    const promise = tracker.track('job-1');

    tracker.resolve('job-1', tc.resolveValue);

    const result = await promise;
    expect(result).toEqual(tc.resolveValue);
    expect(tracker.size).toBe(0);
  });

  it('rejects tracked job on failure', async () => {
    const tracker = tc.make();
    const promise = tracker.track('job-1');

    tracker.reject('job-1', new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(tracker.size).toBe(0);
  });

  it('cleanup() rejects with the configured disconnect error', async () => {
    const tracker = tc.make();
    const promise = tracker.track('job-1');

    tracker.cleanup('job-1');

    await expect(promise).rejects.toThrow(tc.expectedDisconnectError);
    expect(tracker.size).toBe(0);
  });

  it('has() returns true for pending jobs and false otherwise', () => {
    const tracker = tc.make();
    tracker.track('job-1');

    expect(tracker.has('job-1')).toBe(true);
    expect(tracker.has('job-2')).toBe(false);
  });

  it('tracks size correctly across track/resolve', () => {
    const tracker = tc.make();
    expect(tracker.size).toBe(0);

    tracker.track('job-1');
    tracker.track('job-2');
    expect(tracker.size).toBe(2);

    tracker.resolve('job-1', tc.resolveValue);
    expect(tracker.size).toBe(1);
  });

  it('ignores resolve/reject/cleanup for unknown job IDs', () => {
    const tracker = tc.make();
    expect(() => tracker.resolve('unknown', tc.resolveValue)).not.toThrow();
    expect(() => tracker.reject('unknown', new Error('oops'))).not.toThrow();
    expect(() => tracker.cleanup('unknown')).not.toThrow();
  });
});

describe('PendingBuildTracker resolve() arity', () => {
  it('accepts a single jobId argument (no value)', async () => {
    const tracker = new PendingBuildTracker();
    const promise = tracker.track('job-1');

    tracker.resolve('job-1');

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('PendingTracker extractResolveMeta', () => {
  it('merges extractor output into the resolve log line', async () => {
    const tracker = new PendingTracker<{ count: number; tag: string }>({
      logPrefix: 'pending-test',
      itemLabel: 'thing',
      disconnectError: 'thing disconnected',
      extractResolveMeta: (v) => ({ count: v.count, tag: v.tag }),
    });

    const promise = tracker.track('job-1');
    tracker.resolve('job-1', { count: 7, tag: 'alpha' });

    await expect(promise).resolves.toEqual({ count: 7, tag: 'alpha' });
  });
});
