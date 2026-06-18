import { describe, it, expect, vi } from 'vitest';
import { InMemoryExecutionTracker, type StatusUpdate } from './in-memory-execution-tracker.js';

describe('InMemoryExecutionTracker', () => {
  const makeJobs = (names: string[]) =>
    names.map((name, i) => ({ jobId: `job-${i}`, jobName: name }));

  it('stores run state via onExecutionStarted', async () => {
    const tracker = new InMemoryExecutionTracker({});
    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      { installationId: 42 },
      null,
      makeJobs(['lint', 'test']),
    );

    const status = tracker.getRunStatus('run-1');
    expect(status).not.toBeNull();
    expect(status!.workflowName).toBe('build');
    expect(status!.jobs.size).toBe(2);
  });

  it('returns null for unknown runs', () => {
    const tracker = new InMemoryExecutionTracker({});
    expect(tracker.getRunStatus('unknown')).toBeNull();
  });

  it('updates job status via onJobStatus and calls onStatusForward', async () => {
    const forwards: StatusUpdate[] = [];
    const tracker = new InMemoryExecutionTracker({
      onStatusForward: (update) => forwards.push(update),
    });

    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['lint']),
    );

    await tracker.onJobStatus('run-1', 'job-0', 'running', Date.now());

    const status = tracker.getRunStatus('run-1');
    expect(status!.jobs.get('job-0')!.status).toBe('running');
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({
      type: 'job',
      runId: 'run-1',
      jobId: 'job-0',
      status: 'running',
    });
  });

  it('updates step status via onStepStatus and calls onStatusForward', async () => {
    const forwards: StatusUpdate[] = [];
    const tracker = new InMemoryExecutionTracker({
      onStatusForward: (update) => forwards.push(update),
    });

    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['lint']),
    );

    await tracker.onStepStatus('run-1', 'job-0', 0, 'Install deps', 'running', Date.now());

    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({
      type: 'step',
      runId: 'run-1',
      jobId: 'job-0',
      stepIndex: 0,
      status: 'running',
    });
  });

  it('adds to recentJobs ring buffer when job reaches terminal status', async () => {
    const tracker = new InMemoryExecutionTracker({});

    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['lint', 'test']),
    );

    await tracker.onJobStatus('run-1', 'job-0', 'running', Date.now());
    await tracker.onJobStatus('run-1', 'job-0', 'success', Date.now());

    const recent = tracker.getRecentJobs();
    expect(recent).toHaveLength(1);
    expect(recent[0].jobName).toBe('lint');
    expect(recent[0].status).toBe('success');
  });

  it('caps ring buffer at configured limit', async () => {
    const tracker = new InMemoryExecutionTracker({ recentJobsLimit: 3 });

    // Create 5 jobs across different runs
    for (let r = 0; r < 5; r++) {
      await tracker.onExecutionStarted(
        `run-${r}`,
        'build',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        `delivery-${r}`,
        {},
        null,
        makeJobs([`job-r${r}`]),
      );
      await tracker.onJobStatus(`run-${r}`, 'job-0', 'running', Date.now());
      await tracker.onJobStatus(`run-${r}`, 'job-0', 'success', Date.now());
    }

    const recent = tracker.getRecentJobs();
    expect(recent).toHaveLength(3);
    // Most recent first
    expect(recent[0].jobName).toBe('job-r4');
    expect(recent[2].jobName).toBe('job-r2');
  });

  it('works without onStatusForward callback (no-op)', async () => {
    const tracker = new InMemoryExecutionTracker({});

    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['lint']),
    );

    // Should not throw
    await tracker.onJobStatus('run-1', 'job-0', 'running', Date.now());
    await tracker.onStepStatus('run-1', 'job-0', 0, 'Install deps', 'running', Date.now());
  });

  it('removes run from memory once all jobs are terminal', async () => {
    const tracker = new InMemoryExecutionTracker({});
    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['lint', 'test']),
    );

    await tracker.onJobStatus('run-1', 'job-0', 'running', Date.now());
    await tracker.onJobStatus('run-1', 'job-0', 'success', Date.now());
    // Run still in memory — job-1 is still pending
    expect(tracker.getRunStatus('run-1')).not.toBeNull();

    await tracker.onJobStatus('run-1', 'job-1', 'running', Date.now());
    await tracker.onJobStatus('run-1', 'job-1', 'failed', Date.now());
    // All jobs terminal — run should be cleaned up
    expect(tracker.getRunStatus('run-1')).toBeNull();
  });

  it('ignores status updates for unknown runs', async () => {
    const tracker = new InMemoryExecutionTracker({});
    // Should not throw
    await tracker.onJobStatus('unknown-run', 'job-0', 'running', Date.now());
    await tracker.onStepStatus('unknown-run', 'job-0', 0, 'step', 'running', Date.now());
  });

  it('getRecentJobs returns most recent first', async () => {
    const tracker = new InMemoryExecutionTracker({});

    await tracker.onExecutionStarted(
      'run-1',
      'build',
      'github',
      'owner/repo',
      'refs/heads/main',
      'abc123',
      'delivery-1',
      {},
      null,
      makeJobs(['first', 'second']),
    );

    await tracker.onJobStatus('run-1', 'job-0', 'running', Date.now());
    await tracker.onJobStatus('run-1', 'job-0', 'success', Date.now());
    await tracker.onJobStatus('run-1', 'job-1', 'running', Date.now());
    await tracker.onJobStatus('run-1', 'job-1', 'failed', Date.now());

    const recent = tracker.getRecentJobs();
    expect(recent).toHaveLength(2);
    expect(recent[0].jobName).toBe('second');
    expect(recent[0].status).toBe('failed');
    expect(recent[1].jobName).toBe('first');
    expect(recent[1].status).toBe('success');
  });
});
