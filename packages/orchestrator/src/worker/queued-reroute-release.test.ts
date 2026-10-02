import { describe, expect, it, vi } from 'vitest';
import { InMemoryJobQueue } from './in-memory-job-queue.js';
import { InMemoryExecutionTracker } from './in-memory-execution-tracker.js';
import { releaseQueuedRerouteJobs } from './queued-reroute-release.js';

const input = (jobId: string, runId = 'run-1') => ({
  jobId,
  runId,
  workflowName: 'ci',
  jobName: jobId,
  runsOnLabels: ['linux'],
  jobConfig: {},
  repoUrl: 'https://example.invalid/repo.git',
  ref: 'main',
  sha: 'abc',
  deliveryId: 'd-1',
  routingKey: 'rk',
  provider: 'github',
  providerContext: {},
});

async function setup(jobIds: string[]) {
  const queue = new InMemoryJobQueue();
  const forward = vi.fn();
  const executionTracker = new InMemoryExecutionTracker({ onStatusForward: forward });
  const jobOwnership = new Map<string, string>();
  for (const id of jobIds) {
    await queue.enqueue(input(id));
    jobOwnership.set(id, 'wss://coord');
  }
  await executionTracker.onExecutionStarted(
    'run-1',
    'ci',
    'github',
    '',
    'main',
    'abc',
    'd-1',
    {},
    null,
    jobIds.map((jobId) => ({ jobId, jobName: jobId })),
  );
  const dispatcher = {
    cancelQueuedJob: vi.fn(async (id: string, reason: string) => queue.markFailed(id, reason)),
  };
  const budget = { release: vi.fn() };
  const deps = { queue, dispatcher, executionTracker, jobOwnership, budget };
  return { ...deps, forward, deps };
}

describe('releaseQueuedRerouteJobs', () => {
  it('removes a pending job, its projection, its owner and its budget', async () => {
    const s = await setup(['job-1']);
    const removed = await releaseQueuedRerouteJobs(s.deps, {
      runId: 'run-1',
      jobId: 'job-1',
      reason: 'cancelled by the coordinator',
    });

    expect(removed).toEqual(['job-1']);
    expect(s.dispatcher.cancelQueuedJob).toHaveBeenCalledWith(
      'job-1',
      'cancelled by the coordinator',
    );
    expect(await s.queue.getFullJobById('job-1')).toBeNull();
    expect(s.executionTracker.getRunStatus('run-1')).toBeNull();
    expect(s.jobOwnership.has('job-1')).toBe(false);
    expect(s.budget.release).toHaveBeenCalledWith('job-1');
    // fails-when: the worker reports a verdict the coordinator already made
    expect(s.forward).not.toHaveBeenCalled();
  });

  it('only stop-marks a dispatched job', async () => {
    const s = await setup(['job-1']);
    await s.queue.dequeueById('job-1', ['linux']);

    const removed = await releaseQueuedRerouteJobs(s.deps, {
      runId: 'run-1',
      jobId: 'job-1',
      reason: 'cancelled by the coordinator',
    });

    expect(removed).toEqual([]);
    // breaks-if-wrong: the agent running it keeps its owner, so its terminal still reaches the coordinator
    expect(s.jobOwnership.get('job-1')).toBe('wss://coord');
    expect(s.executionTracker.getRunStatus('run-1')?.jobs.has('job-1')).toBe(true);
    expect(s.budget.release).not.toHaveBeenCalled();
    // ...and a requeue after the agent drops it does not bring it back.
    expect(await s.queue.requeue('job-1')).toBeNull();
    expect(s.forward).not.toHaveBeenCalled();
  });

  it('a run-scoped release removes every pending job of the run', async () => {
    const s = await setup(['job-1', 'job-2']);
    await s.queue.enqueue(input('other', 'run-2'));

    const removed = await releaseQueuedRerouteJobs(s.deps, {
      runId: 'run-1',
      reason: 'cancelled by the coordinator',
    });

    expect(removed.sort()).toEqual(['job-1', 'job-2']);
    expect(s.queue.isPending('other')).toBe(true);
    expect(s.forward).not.toHaveBeenCalled();
  });
});
