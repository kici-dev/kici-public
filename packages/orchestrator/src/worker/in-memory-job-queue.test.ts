import { describe, it, expect } from 'vitest';
import { InMemoryJobQueue } from './in-memory-job-queue.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';

describe('InMemoryJobQueue', () => {
  const makeInput = (overrides?: Record<string, unknown>) => ({
    runId: 'run-1',
    workflowName: 'build',
    jobName: 'lint',
    runsOnLabels: ['linux'],
    jobConfig: {},
    repoUrl: 'https://github.com/owner/repo',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: 'delivery-1',
    provider: 'github',
    providerContext: {},
    ...overrides,
  });

  it('enqueue returns a UUID string', async () => {
    const queue = new InMemoryJobQueue();
    const id = await queue.enqueue(makeInput());
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('dequeueForLabels returns enqueued job with matching labels', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput());
    const job = await queue.dequeueForLabels(['linux']);
    expect(job).not.toBeNull();
    expect(job!.jobName).toBe('lint');
  });

  it('dequeueForLabels returns null when no labels match', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput({ runsOnLabels: ['windows'] }));
    const job = await queue.dequeueForLabels(['linux']);
    expect(job).toBeNull();
  });

  it('dequeueForLabels removes job from queue after dequeue', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput());
    const job1 = await queue.dequeueForLabels(['linux']);
    expect(job1).not.toBeNull();
    const job2 = await queue.dequeueForLabels(['linux']);
    expect(job2).toBeNull();
  });

  it('getDepth returns count of pending jobs', async () => {
    const queue = new InMemoryJobQueue();
    expect(await queue.getDepth()).toBe(0);
    await queue.enqueue(makeInput());
    expect(await queue.getDepth()).toBe(1);
    await queue.enqueue(makeInput({ jobName: 'test' }));
    expect(await queue.getDepth()).toBe(2);
    await queue.dequeueForLabels(['linux']);
    expect(await queue.getDepth()).toBe(1);
  });

  it('insertDispatched returns a UUID string', async () => {
    const queue = new InMemoryJobQueue();
    const id = await queue.insertDispatched(makeInput());
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('markDispatched, markFailed, markCompleted are no-ops', async () => {
    const queue = new InMemoryJobQueue();
    // Should not throw
    await queue.markDispatched('job-1', 'agent-1');
    await queue.markFailed('job-1', 'reason');
    await queue.markCompleted('job-1');
  });

  it('dequeueForLabels skips jobs with matching excludeLabels', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput({ runsOnLabels: ['linux'], excludeLabels: ['arm64'] }));
    const job = await queue.dequeueForLabels(['linux', 'arm64']);
    expect(job).toBeNull();
  });

  it('dequeueForLabels returns job when agent has no excluded labels', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput({ runsOnLabels: ['linux'], excludeLabels: ['arm64'] }));
    const job = await queue.dequeueForLabels(['linux', 'x64']);
    expect(job).not.toBeNull();
    expect(job!.jobName).toBe('lint');
  });

  it('getPendingJobs returns enqueued jobs', async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue(makeInput());
    const jobs = await queue.getPendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobName).toBe('lint');
  });

  it('dequeueById returns the job and removes it when labels match', async () => {
    const queue = new InMemoryJobQueue();
    const id = await queue.enqueue(makeInput());
    const job = await queue.dequeueById(id, ['linux']);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(id);
    // Subsequent calls (any path) see no pending entry.
    expect(await queue.dequeueById(id, ['linux'])).toBeNull();
    expect(await queue.dequeueForLabels(['linux'])).toBeNull();
  });

  it('dequeueById returns null when the job id is unknown', async () => {
    const queue = new InMemoryJobQueue();
    const job = await queue.dequeueById('00000000-0000-0000-0000-000000000000', ['linux']);
    expect(job).toBeNull();
  });

  it('dequeueById returns null when agent labels no longer satisfy runsOn', async () => {
    const queue = new InMemoryJobQueue();
    const id = await queue.enqueue(makeInput({ runsOnLabels: ['linux', 'arm64'] }));
    const job = await queue.dequeueById(id, ['linux']);
    expect(job).toBeNull();
    // Job should still be claimable by a properly-labeled agent.
    const claimed = await queue.dequeueById(id, ['linux', 'arm64']);
    expect(claimed).not.toBeNull();
  });

  it('dequeueById returns null when an agent label is in the excludeLabels set', async () => {
    const queue = new InMemoryJobQueue();
    const id = await queue.enqueue(
      makeInput({ runsOnLabels: ['linux'], excludeLabels: ['arm64'] }),
    );
    const job = await queue.dequeueById(id, ['linux', 'arm64']);
    expect(job).toBeNull();
  });

  describe('requeue and dispatched tracking', () => {
    it('requeues a dispatched job back to pending with a bumped attempt count', async () => {
      const queue = new InMemoryJobQueue();
      const id = await queue.enqueue(makeInput());
      const job = await queue.dequeueForLabels(['linux', 'docker']);
      expect(job?.id).toBe(id);

      const attempts = await queue.requeue(id);
      expect(attempts).toBe(1);

      // The job is dequeueable again.
      const again = await queue.dequeueForLabels(['linux', 'docker']);
      expect(again?.id).toBe(id);

      const attempts2 = await queue.requeue(id);
      expect(attempts2).toBe(2);
    });

    it('returns null when requeueing an unknown or non-dispatched job', async () => {
      const queue = new InMemoryJobQueue();
      expect(await queue.requeue('nope')).toBeNull();
      const id = await queue.enqueue(makeInput());
      expect(await queue.requeue(id)).toBeNull(); // still pending, not dispatched
    });

    it('getFullJobById finds pending and dispatched jobs', async () => {
      const queue = new InMemoryJobQueue();
      const id = await queue.enqueue(makeInput());
      expect((await queue.getFullJobById(id))?.status).toBe(DispatchQueueStatus.Pending);
      await queue.dequeueForLabels(['linux', 'docker']);
      expect((await queue.getFullJobById(id))?.status).toBe(DispatchQueueStatus.Dispatched);
    });

    it('getJobById resolves runId for dispatched jobs', async () => {
      const queue = new InMemoryJobQueue();
      const id = await queue.enqueue(makeInput({ runId: 'run-42' }));
      await queue.dequeueForLabels(['linux', 'docker']);
      expect((await queue.getJobById(id))?.runId).toBe('run-42');
    });

    it('markCompleted / markFailed drop the dispatched entry', async () => {
      const queue = new InMemoryJobQueue();
      const id = await queue.enqueue(makeInput());
      await queue.dequeueForLabels(['linux', 'docker']);
      await queue.markCompleted(id);
      expect(await queue.requeue(id)).toBeNull();
    });
  });
});
