import { describe, it, expect, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminApiHttpError } from '@kici-dev/orchestrator';
import {
  followRun,
  resolveAcceptanceTimeoutMs,
  type FollowRunOptions,
  type RunFollowClient,
} from './run-follow.js';

describe('resolveAcceptanceTimeoutMs', () => {
  const DEFAULT_MS = 120_000;

  it('prefers an explicit option over the environment', () => {
    expect(resolveAcceptanceTimeoutMs(50, '999')).toBe(50);
  });

  it('reads a positive numeric override', () => {
    expect(resolveAcceptanceTimeoutMs(undefined, '15000')).toBe(15_000);
  });

  it('falls back to the default for junk, empty, zero, and negative values', () => {
    // NaN would silently disable the window; 0 (`Number('')`) would fail every
    // run on its first poll. Both are worse than ignoring the typo.
    for (const raw of ['2 min', '', '  ', '0', '-1', 'Infinity']) {
      expect(resolveAcceptanceTimeoutMs(undefined, raw), raw).toBe(DEFAULT_MS);
    }
    expect(resolveAcceptanceTimeoutMs(undefined, undefined)).toBe(DEFAULT_MS);
  });
});

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
    const client: RunFollowClient = { get: get as RunFollowClient['get'] };
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-1', {
      client,
      quiet: true,
      pollIntervalMs: 1,
      idleTimeoutMs: 5_000,
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
        return {
          jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', steps: [{ stepIndex: 0 }] }],
        };
      }
      if (path.includes('/steps/0/logs')) {
        return { lines: [{ value: 'hello' }, { value: 'world' }], totalLines: 2, nextCursor: null };
      }
      if (path === '/api/v1/admin/runs/run-2/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', durationMs: 5 }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client: RunFollowClient = { get: get as RunFollowClient['get'] };
    await followRun('http://127.0.0.1:4319', 'tok', 'run-2', {
      client,
      onLine: (l) => emitted.push(l),
      pollIntervalMs: 1,
      idleTimeoutMs: 5_000,
    });
    expect(emitted).toContain('hello');
    expect(emitted).toContain('world');
  });

  it('emits the text of a stored log envelope, not the envelope', async () => {
    // fails-when: onLine receives `l.value` verbatim, so `kici run --local`
    // prints {"ts":…,"level":"stdout","msg":…} for every job line. The store
    // writes each line as that envelope (reporting/log-writer.ts) and the admin
    // step-logs route serves it unchanged as `value` (reporting/step-log-reader.ts).
    const ENVELOPE =
      '{"ts":"2026-09-12T09:30:49.325Z","level":"stdout","msg":"✔ the committed test passes","meta":{}}';
    const emitted: string[] = [];
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-env') return { run: { status: 'success' } };
      if (path.startsWith('/api/v1/admin/runs/run-env/jobs?includeSteps=true')) {
        return {
          jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', steps: [{ stepIndex: 0 }] }],
        };
      }
      if (path.includes('/steps/0/logs')) {
        return {
          lines: [{ value: ENVELOPE }, { value: 'Run started: abc' }],
          totalLines: 2,
          nextCursor: null,
        };
      }
      if (path === '/api/v1/admin/runs/run-env/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', durationMs: 5 }] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client: RunFollowClient = { get: get as RunFollowClient['get'] };
    await followRun('http://127.0.0.1:4319', 'tok', 'run-env', {
      client,
      onLine: (l) => emitted.push(l),
      pollIntervalMs: 1,
      idleTimeoutMs: 5_000,
    });
    expect(emitted).toContain('✔ the committed test passes');
    expect(emitted).not.toContain(ENVELOPE);
    // breaks-if-wrong: a line that is not an envelope still reaches the
    // terminal as itself.
    expect(emitted).toContain('Run started: abc');
  });

  it('does not conclude while a later dispatch wave is still running (no false green)', async () => {
    // The header reports success after the __build__ init job while a real job
    // still runs; followRun must poll until every job is terminal.
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
      client: { get: get as RunFollowClient['get'] },
      quiet: true,
      pollIntervalMs: 1,
      idleTimeoutMs: 5_000,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.jobs[0].status).toBe('failed');
  });

  it('throws when the run never reaches terminal before the timeout', async () => {
    // The jobs path returns a jobs array as the real API does: the acceptance
    // check reads it too, and a wrong shape would throw a TypeError instead of
    // the idle timeout under test.
    const client: RunFollowClient = {
      get: vi.fn(async (path: string) =>
        path.endsWith('/jobs')
          ? { jobs: [{ jobId: 'j1', jobName: 'build', status: 'running', durationMs: null }] }
          : { run: { status: 'running' } },
      ) as RunFollowClient['get'],
    };
    await expect(
      followRun('http://127.0.0.1:4319', 'tok', 'run-3', {
        client,
        quiet: true,
        pollIntervalMs: 1,
        idleTimeoutMs: 30,
      }),
    ).rejects.toThrow(/no progress/);
  });

  it('does NOT time out on a long-but-progressing run (streamed lines reset the idle window)', async () => {
    // The long-deploy case: a run streaming a line each tick must not trip the
    // idle timeout, though total elapsed time far exceeds it.
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
        return {
          jobs: [{ jobId: 'j1', jobName: 'deploy', status: 'running', steps: [{ stepIndex: 0 }] }],
        };
      }
      if (path.includes('/steps/0/logs')) {
        return { lines: [{ value: `line-${tick}` }], totalLines: tick, nextCursor: null };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const client: RunFollowClient = { get: get as RunFollowClient['get'] };
    // Fake timers advance exactly pollIntervalMs per tick. On a real clock a
    // scheduling stall over the 30ms margin between the windows below trips the
    // idle timeout under suite load: a stall, not the silence under test.
    vi.useFakeTimers();
    try {
      const following = followRun('http://127.0.0.1:4319', 'tok', 'run-4', {
        client,
        onLine: (l) => emitted.push(l),
        pollIntervalMs: 10,
        // Below total elapsed (8 ticks × 10ms = 80ms) but above each 10ms gap:
        // without the progress reset this would throw around tick 4.
        idleTimeoutMs: 40,
        maxTotalMs: 60_000,
      });
      // The async advance flushes the mocked client between timers, so each
      // tick observes the next status.
      await vi.advanceTimersByTimeAsync(10 * 20);
      const outcome = await following;
      expect(outcome.status).toBe('success');
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('fails fast when no agent ever claims the run', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-stuck') return { run: { status: 'pending' } };
      if (path === '/api/v1/admin/runs/run-stuck/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'queued', durationMs: null }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(
      followRun('http://127.0.0.1:4319', 'tok', 'run-stuck', {
        client: { get: get as RunFollowClient['get'] },
        quiet: true,
        pollIntervalMs: 1,
        acceptanceTimeoutMs: 50,
        hintLogPath: '/home/u/.kici/local/orchestrator.log',
      }),
    ).rejects.toThrow(/no agent picked up this run/);
  });

  it('names the plane log in the acceptance failure', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-stuck2') return { run: { status: 'pending' } };
      if (path === '/api/v1/admin/runs/run-stuck2/jobs') return { jobs: [] };
      throw new Error(`unexpected path ${path}`);
    });
    await expect(
      followRun('http://127.0.0.1:4319', 'tok', 'run-stuck2', {
        client: { get: get as RunFollowClient['get'] },
        quiet: true,
        pollIntervalMs: 1,
        acceptanceTimeoutMs: 50,
        hintLogPath: '/home/u/.kici/local/orchestrator.log',
      }),
    ).rejects.toThrow(/orchestrator\.log/);
  });

  it('does not trip once a job has been claimed', async () => {
    let polls = 0;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-ok') {
        polls++;
        return { run: { status: polls > 3 ? 'success' : 'running' } };
      }
      if (path === '/api/v1/admin/runs/run-ok/jobs') {
        // Claimed from the first poll, and terminal once the header reports
        // success, or the follow never concludes.
        return {
          jobs: [
            {
              jobId: 'j1',
              jobName: 'build',
              status: polls > 3 ? 'success' : 'running',
              durationMs: null,
            },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-ok', {
      client: { get: get as RunFollowClient['get'] },
      quiet: true,
      pollIntervalMs: 1,
      acceptanceTimeoutMs: 30,
    });
    expect(outcome.status).toBe('success');
  });

  it('does not trip while the run is held for approval', async () => {
    let polls = 0;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-held') {
        polls++;
        // Held well past the acceptance window, then released and completed.
        return { run: { status: polls < 25 ? 'held' : 'success' } };
      }
      if (path === '/api/v1/admin/runs/run-held/jobs') {
        return {
          jobs: [
            {
              jobId: 'j1',
              jobName: 'build',
              status: polls < 25 ? 'queued' : 'success',
              durationMs: 1,
            },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-held', {
      client: { get: get as RunFollowClient['get'] },
      quiet: true,
      pollIntervalMs: 1,
      acceptanceTimeoutMs: 20,
    });
    expect(outcome.status).toBe('success');
  });

  it('reports a terminal run rather than blaming acceptance for it', async () => {
    // Cancelled before any claim: jobs stay queued past the acceptance window,
    // but "no agent picked up this run" would misdiagnose a cancellation.
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-cancelled') return { run: { status: 'cancelled' } };
      if (path === '/api/v1/admin/runs/run-cancelled/jobs') {
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'cancelled', durationMs: null }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-cancelled', {
      client: { get: get as RunFollowClient['get'] },
      quiet: true,
      pollIntervalMs: 1,
      acceptanceTimeoutMs: -1, // already elapsed on the first poll
    });
    expect(outcome.status).toBe('cancelled');
  });
});

/**
 * A fake plane over real HTTP, so the follower's own AdminApiClient produces the
 * errors (status, connection reset) the retry classifies: an injected client
 * throwing hand-made errors would bypass that seam.
 */
interface FakePlane {
  url: string;
  headerRequests: () => number;
  close: () => Promise<void>;
}

type FakePlaneHandler = (
  path: string,
  headerHit: number,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

async function startFakePlane(runId: string, onHeader: FakePlaneHandler): Promise<FakePlane> {
  let headerHits = 0;
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path === `/api/v1/admin/runs/${runId}`) {
      headerHits++;
      onHeader(path, headerHits, req, res);
      return;
    }
    if (path === `/api/v1/admin/runs/${runId}/jobs`) {
      answer(res, 200, {
        jobs: [{ jobId: 'j1', jobName: 'deploy', status: 'success', durationMs: 10 }],
      });
      return;
    }
    answer(res, 404, { error: `unexpected ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    headerRequests: () => headerHits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const FAST_RETRY = { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 };

/** The first status read gets `first`; the follow retries it and ends in success. */
async function expectRecovers(
  first: (req: IncomingMessage, res: ServerResponse) => void,
  follow: FollowRunOptions = {},
): Promise<void> {
  const plane = await startFakePlane('run-r', (_p, hit, req, res) =>
    hit === 1 ? first(req, res) : answer(res, 200, { run: { status: 'success' } }),
  );
  try {
    const outcome = await followRun(plane.url, 'tok', 'run-r', {
      quiet: true,
      pollIntervalMs: 1,
      readRetry: FAST_RETRY,
      ...follow,
    });
    expect(outcome.status).toBe('success');
    expect(plane.headerRequests()).toBe(2);
  } finally {
    await plane.close();
  }
}

describe('followRun against a plane whose status reads fail', () => {
  // fails-when: one failed status read ends the follow (and the caller cancels a healthy run)
  it('retries a 500 from the run status read and follows the run to completion', async () => {
    await expectRecovers((_req, res) => answer(res, 500, { error: 'Internal server error' }));
  });

  // fails-when: a dropped connection is not retried
  it('retries a connection the plane resets', async () => {
    await expectRecovers((req) => req.socket.destroy());
  });

  // fails-when: a 200 whose body is cut off mid-read ends the follow instead of retrying
  it('retries an answer the plane cuts off mid-body', async () => {
    await expectRecovers((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"run":');
      setTimeout(() => req.socket.destroy(), 10);
    });
  });

  // fails-when: a read the plane accepts and never answers hangs the follow
  it('retries a status read the plane never answers once its deadline passes', async () => {
    await expectRecovers(() => undefined, { readTimeoutMs: 100 });
  });

  // fails-when: Ctrl-C waits out a stalled read; the deadline here is the 30 s default
  it('returns cancelled within moments of Ctrl-C during a stalled read', async () => {
    const plane = await startFakePlane('run-c', () => undefined);
    try {
      const ctrlC = new AbortController();
      setTimeout(() => ctrlC.abort(), 100);
      const started = Date.now();
      const outcome = await followRun(plane.url, 'tok', 'run-c', {
        quiet: true,
        pollIntervalMs: 1,
        readRetry: FAST_RETRY,
        signal: ctrlC.signal,
      });
      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(plane.headerRequests()).toBe(1);
    } finally {
      await plane.close();
    }
  });

  // fails-when: a log read the plane never answers hangs the follow (logs are not retried)
  it('bounds a log read by the deadline too', async () => {
    const stalled = (signal?: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('no answer'))),
      );
    const get = vi.fn(async (path: string, opts?: { signal?: AbortSignal }) => {
      if (path === '/api/v1/admin/runs/run-l') return { run: { status: 'success' } };
      if (path.includes('includeSteps=true')) {
        return {
          jobs: [{ jobId: 'j1', jobName: 'b', status: 'success', steps: [{ stepIndex: 0 }] }],
        };
      }
      if (path.includes('/steps/0/logs')) return stalled(opts?.signal);
      return { jobs: [{ jobId: 'j1', jobName: 'b', status: 'success', durationMs: 1 }] };
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-l', {
      client: { get: get as RunFollowClient['get'] },
      onLine: () => undefined,
      pollIntervalMs: 1,
      readTimeoutMs: 50,
    });
    expect(outcome.status).toBe('success');
  });

  // fails-when: a plane that keeps failing is retried forever, or the error hides the run's state
  it('fails with the last error and the last seen status once the plane keeps failing', async () => {
    const plane = await startFakePlane('run-down', (_p, hit, _req, res) =>
      hit === 1
        ? answer(res, 200, { run: { status: 'running' } })
        : answer(res, 500, { error: 'Internal server error' }),
    );
    try {
      const err = (await followRun(plane.url, 'tok', 'run-down', {
        quiet: true,
        pollIntervalMs: 1,
        acceptanceTimeoutMs: 60_000,
        readRetry: { budgetMs: 60, baseDelayMs: 5, maxDelayMs: 10 },
        hintLogPath: '/tmp/plane.log',
      }).then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('run-down');
      expect(err.message).toContain('HTTP 500: Internal server error');
      expect(err.message).toContain('last seen as "running"');
      expect(err.message).toContain('/tmp/plane.log');
      expect(plane.headerRequests()).toBeGreaterThan(2);
    } finally {
      await plane.close();
    }
  });

  // breaks-if-wrong: a run the plane does not know fails at once instead of waiting out the budget
  it('fails at once on a 404', async () => {
    const plane = await startFakePlane('run-gone', (_p, _hit, _req, res) =>
      answer(res, 404, { error: 'Run not found' }),
    );
    try {
      const started = Date.now();
      await expect(
        followRun(plane.url, 'tok', 'run-gone', {
          quiet: true,
          pollIntervalMs: 1,
          readRetry: { budgetMs: 60_000, baseDelayMs: 1_000 },
        }),
      ).rejects.toThrow('HTTP 404: Run not found');
      expect(plane.headerRequests()).toBe(1);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await plane.close();
    }
  });

  // fails-when: the jobs read behind the terminal check is not retried
  it('retries a failed jobs read at the terminal check', async () => {
    let jobsHits = 0;
    const get = vi.fn(async (path: string) => {
      if (path === '/api/v1/admin/runs/run-j') return { run: { status: 'success' } };
      if (path === '/api/v1/admin/runs/run-j/jobs') {
        jobsHits++;
        if (jobsHits === 1) throw new AdminApiHttpError(503, 'Service unavailable');
        return { jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', durationMs: 1 }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const outcome = await followRun('http://127.0.0.1:4319', 'tok', 'run-j', {
      client: { get: get as RunFollowClient['get'] },
      quiet: true,
      pollIntervalMs: 1,
      readRetry: FAST_RETRY,
    });
    expect(outcome.status).toBe('success');
    expect(jobsHits).toBe(2);
  });
});
