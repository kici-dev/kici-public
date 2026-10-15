import { describe, expect, it, vi } from 'vitest';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { mockExecutionTracker, START_RUN_PARAMS, startRun, startRunArgs } from './tracker.js';

describe('startRunArgs', () => {
  it('fills the ten required positions with the shared defaults', () => {
    expect(startRunArgs()).toEqual([
      'run-1',
      'ci',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      [],
    ]);
  });

  it('places a named option at its signature position and stops at the last one named', () => {
    const args = startRunArgs({ runId: 'r', routingKey: 'generic:org-a:s1', triggerEvent: 'push' });
    expect(args).toHaveLength(13);
    expect(args[0]).toBe('r');
    expect(args[10]).toBe('generic:org-a:s1');
    expect(args[11]).toBeUndefined();
    expect(args[12]).toBe('push');
  });

  it('keeps an explicit null and an explicitly named undefined', () => {
    const args = startRunArgs({ deliveryId: null, routingKey: undefined });
    expect(args[6]).toBeNull();
    expect(args).toHaveLength(11);
  });

  it('returns fresh default objects on every call', () => {
    const a = startRunArgs();
    (a[9] as unknown[]).push({ jobId: 'j', jobName: 'j' });
    expect(startRunArgs()[9]).toEqual([]);
  });

  it('names every onExecutionStarted parameter', () => {
    // fails-when: a parameter is added to onExecutionStarted and not to START_RUN_PARAMS
    expect(START_RUN_PARAMS).toHaveLength(ExecutionTracker.prototype.onExecutionStarted.length);
  });
});

describe('startRun', () => {
  it('calls onExecutionStarted with the built arguments', async () => {
    const tracker = { onExecutionStarted: vi.fn().mockResolvedValue(undefined) };
    await startRun(tracker, { sha: 'def456' });
    expect(tracker.onExecutionStarted).toHaveBeenCalledWith(...startRunArgs({ sha: 'def456' }));
    expect(tracker.onExecutionStarted.mock.calls[0]![5]).toBe('def456');
  });
});

describe('mockExecutionTracker', () => {
  it('resolves the async methods and returns fresh mocks per call', async () => {
    const a = mockExecutionTracker();
    await expect(a.onExecutionStarted()).resolves.toBeUndefined();
    await expect(a.recordInitFailureRun()).resolves.toBeUndefined();
    expect(a.holdRunForPendingJobs()).toBe(true);
    expect(mockExecutionTracker().onJobStatus).not.toBe(a.onJobStatus);
  });

  it('carries no onJobReadyCallback, which the dispatch path probes for', () => {
    expect(mockExecutionTracker()).not.toHaveProperty('onJobReadyCallback');
  });
});
