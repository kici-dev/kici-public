import { describe, it, expect, vi } from 'vitest';
import { followRun, type RunFollowClient } from './run-follow.js';

describe('followRun', () => {
  it('polls to a terminal status and returns mapped jobs', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-1') {
        // running once, then success.
        return get.mock.calls.filter((c) => c[0] === '/api/v1/admin/runs/run-1').length <= 1
          ? { run: { status: 'running' } }
          : { run: { status: 'success' } };
      }
      if (path === '/api/v1/admin/runs/run-1/jobs') {
        return {
          jobs: [
            { jobId: 'j1', jobName: 'build', status: 'success', durationMs: 1200 },
            { jobId: 'j2', jobName: 'test', status: 'success', durationMs: null },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const client: RunFollowClient = { get };
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-1', {
      client,
      quiet: true,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(outcome.status).toBe('success');
    expect(outcome.jobs).toEqual([
      { name: 'build', status: 'success', durationMs: 1200 },
      { name: 'test', status: 'success', durationMs: undefined },
    ]);
  });

  it('streams step log lines via onLine, advancing cursors', async () => {
    const emitted: string[] = [];
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-2') return { run: { status: 'success' } };
      if (path.startsWith('/api/v1/admin/runs/run-2/jobs?includeSteps=true')) {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', steps: [{ stepIndex: 0 }] }] };
      }
      if (path.includes('/steps/0/logs')) {
        return { lines: [{ value: 'hello' }, { value: 'world' }], totalLines: 2, nextCursor: null };
      }
      if (path === '/api/v1/admin/runs/run-2/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', durationMs: 5 }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client: RunFollowClient = { get };
    await followRun('http://127.0.0.1:4319', 'tok', 'run-2', {
      client,
      onLine: (l) => emitted.push(l),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(emitted).toContain('hello');
    expect(emitted).toContain('world');
  });

  it('does not conclude while a later dispatch wave is still running (no false green)', async () => {
    // The run header reports success early (after the __build__ init job), but a
    // real job is still running — followRun must keep polling until every job is
    // terminal, then report the settled (failed) run.
    let ticks = 0;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-x') {
        ticks++;
        return { run: { status: ticks < 3 ? 'success' : 'failed' } };
      }
      if (path === '/api/v1/admin/runs/run-x/jobs') {
        return ticks < 3
          ? { jobs: [{ jobId: 'b', jobName: 'build', status: 'running', durationMs: null }] }
          : { jobs: [{ jobId: 'b', jobName: 'build', status: 'failed', durationMs: 9 }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-x', {
      client: { get },
      quiet: true,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.jobs[0].status).toBe('failed');
  });

  it('throws when the run never reaches terminal before the timeout', async () => {
    const client: RunFollowClient = {
      get: vi.fn().mockResolvedValue({ run: { status: 'running' } }),
    };
    await expect(
      followRun('http://127.0.0.1:4319', 'tok', 'run-3', {
        client,
        quiet: true,
        pollIntervalMs: 1,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/no progress/);
  });

  it('does NOT time out on a long-but-progressing run (streamed lines reset the idle window)', async () => {
    // A run that stays "running" but streams a new line each tick must not trip
    // the idle timeout, even though total elapsed time far exceeds it — this is
    // the deploy:stg case (tens of minutes of active output). It reaches success
    // after several ticks well past the tiny idle window.
    let tick = 0;
    const emitted: string[] = [];
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-4') {
        tick++;
        return { run: { status: tick >= 8 ? 'success' : 'running' } };
      }
      if (path === '/api/v1/admin/runs/run-4/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'deploy', status: 'success', durationMs: 10 }] };
      }
      if (path.includes('?includeSteps=true')) {
        // One fresh log line per tick keeps the idle window resetting.
        return { jobs: [{ jobId: 'j1', jobName: 'deploy', status: 'running', steps: [{ stepIndex: 0 }] }] };
      }
      if (path.includes('/steps/0/logs')) {
        return { lines: [{ value: `line-${tick}` }], totalLines: tick, nextCursor: null };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const client: RunFollowClient = { get };
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-4', {
      client,
      onLine: (l) => emitted.push(l),
      pollIntervalMs: 10,
      // Idle window smaller than total elapsed (8 ticks × ~10ms ≈ 80ms), but each
      // inter-tick gap (~10ms) is well under it — without progress-reset a
      // total-deadline of 40ms would throw around tick 4; the per-tick streamed
      // line keeps resetting the idle window so the run reaches success.
      idleTimeoutMs: 40,
      maxTotalMs: 60_000,
    });
    expect(outcome.status).toBe('success');
    expect(emitted.length).toBeGreaterThan(0);
  });
});
