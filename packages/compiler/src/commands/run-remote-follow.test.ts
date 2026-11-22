import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  combineRunStatuses,
  errorBlocks,
  followRuns,
  type FollowRunsOptions,
} from './run-remote-follow.js';
import type { RemoteRunOptions } from './preview.js';
import { DirectRunClient } from '../remote/direct-client.js';
import {
  AccessDeniedError,
  AuthenticationError,
  NotFoundError,
  PlatformRunClient,
} from '../remote/platform-client.js';
import {
  createDirectTransport,
  createPlatformTransport,
  type RunRemoteTransport,
} from '../remote/run-transport.js';

type Watch = Parameters<typeof errorBlocks>[0][number];

function watch(overrides: Partial<Watch> & Pick<Watch, 'lastStatus'>): Watch {
  return {
    run: { runId: 'run-1', workflowName: 'wf' },
    jobTails: new Map(),
    runTail: [],
    attributed: true,
    ...overrides,
  };
}

describe('combineRunStatuses', () => {
  it('passes only when every run passed', () => {
    // breaks-if-wrong: all runs green is a pass
    expect(combineRunStatuses(['success', 'success'])).toBe('success');
    // fails-when: the combined status reads only the first run
    expect(combineRunStatuses(['success', 'failed'])).toBe('failed');
  });

  it('reports a cancel only when nothing failed', () => {
    expect(combineRunStatuses(['success', 'cancelled'])).toBe('cancelled');
    expect(combineRunStatuses(['failed', 'cancelled'])).toBe('failed');
  });

  it('never passes an empty set of runs', () => {
    expect(combineRunStatuses([])).toBe('failed');
  });
});

describe('errorBlocks', () => {
  it("gives each failed job its own block, holding only that job's lines", () => {
    const blocks = errorBlocks(
      [
        watch({
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [
              { jobId: 'a', jobName: 'init-fails', status: 'failed' },
              { jobId: 'b', jobName: 'image-tools', status: 'success' },
              { jobId: 'c', jobName: 'step-fails', status: 'failed' },
            ],
          },
          jobTails: new Map([
            ['init-fails', ['mise 404']],
            ['image-tools', ['apt install tree']],
            ['step-fails', ['exit 3']],
          ]),
          runTail: ['mise 404', 'apt install tree', 'exit 3'],
        }),
      ],
      false,
    );
    // fails-when: one block carries the run's mixed tail, and the second failed job gets none
    expect(blocks).toEqual([
      { label: 'init-fails', lines: ['mise 404'] },
      { label: 'step-fails', lines: ['exit 3'] },
    ]);
  });

  it('labels each block <workflow> / <job> across workflows', () => {
    const failedRun = (runId: string, workflowName: string): Watch =>
      watch({
        run: { runId, workflowName },
        lastStatus: {
          runId,
          status: 'failed',
          done: true,
          jobs: [{ jobId: runId, jobName: 'build', status: 'failed' }],
        },
        jobTails: new Map([['build', [`${workflowName} output`]]]),
      });
    const blocks = errorBlocks([failedRun('r1', 'wf-a'), failedRun('r2', 'wf-b')], true);
    expect(blocks).toEqual([
      { label: 'wf-a / build', lines: ['wf-a output'] },
      { label: 'wf-b / build', lines: ['wf-b output'] },
    ]);
  });

  it("shows a run's failure reason when it failed with no failed job", () => {
    const blocks = errorBlocks(
      [
        watch({
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [],
            failureReason: 'secret DB_PASSWORD not found',
          },
        }),
      ],
      false,
    );
    // fails-when: an init-failed run prints FAILED with no reason
    expect(blocks).toEqual([{ label: 'wf', lines: ['secret DB_PASSWORD not found'] }]);
  });

  it("keeps one block of the run's tail for a server that does not name each line's job", () => {
    const blocks = errorBlocks(
      [
        watch({
          attributed: false,
          lastStatus: {
            runId: 'run-1',
            status: 'failed',
            done: true,
            jobs: [{ jobId: 'a', jobName: 'test', status: 'failed' }],
          },
          runTail: ['a', 'b'],
        }),
      ],
      false,
    );
    // breaks-if-wrong: an older orchestrator still gets its error block
    expect(blocks).toEqual([{ label: 'test', lines: ['a', 'b'] }]);
  });

  it('prints nothing for a run that passed', () => {
    expect(
      errorBlocks(
        [
          watch({
            lastStatus: { runId: 'run-1', status: 'success', done: true, jobs: [] },
            runTail: ['ok'],
          }),
        ],
        false,
      ),
    ).toEqual([]);
  });
});

/**
 * A fake orchestrator over real HTTP, so the transport's own clients produce the
 * errors (status, connection reset) the retry classifies.
 */
type Route = 'status' | 'logs' | 'cancel';
type FakeHandler = (route: Route, hit: number, req: IncomingMessage, res: ServerResponse) => void;

interface FakeServer {
  url: string;
  hits: (route: Route) => number;
  close: () => Promise<void>;
}

const RUN_PATH = /^\/api\/v1\/test\/runs\/[^/?]+(\/logs|\/cancel)?/;

async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const counts: Record<Route, number> = { status: 0, logs: 0, cancel: 0 };
  const server = createServer((req, res) => {
    const match = RUN_PATH.exec((req.url ?? '').replace('/api/v1/orgs/org-1/test', '/api/v1/test'));
    if (!match) return reply(res, 404, { error: `unexpected ${req.url}` });
    const route: Route =
      match[1] === '/logs' ? 'logs' : match[1] === '/cancel' ? 'cancel' : 'status';
    handler(route, ++counts[route], req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: (route) => counts[route],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const runStatus = (status: string) => ({ runId: 'run-r', status, done: false, jobs: [] });
const drainedLogs = { lines: ['hello'], nextCursor: 1, done: true };

/** Answers every route healthily unless `override` handles it. */
function healthy(
  override: (route: Route, hit: number, req: IncomingMessage, res: ServerResponse) => boolean,
): FakeHandler {
  return (route, hit, req, res) => {
    if (override(route, hit, req, res)) return;
    if (route === 'logs') return reply(res, 200, drainedLogs);
    if (route === 'cancel') return reply(res, 200, { cancelled: true });
    reply(res, 200, runStatus('success'));
  };
}

function directTransport(url: string, readTimeoutMs?: number) {
  return createDirectTransport({
    client: new DirectRunClient({ url, token: 'tok', readTimeoutMs }),
    whoami: {
      tokenId: 't',
      label: 'dev',
      subject: null,
      role: 'admin',
      mode: 'independent',
      orgId: null,
      permissions: { trigger: true, read: true },
    },
  });
}

function platformTransport(url: string, readTimeoutMs?: number) {
  return createPlatformTransport({
    client: new PlatformRunClient({ platformEndpoint: url, token: 'pat', readTimeoutMs }),
    orgId: 'org-1',
    target: {},
    endpoint: url,
    token: 'pat',
  });
}

const FAST = { readRetry: { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 }, pollIntervalMs: 5 };
const RUN = [{ runId: 'run-r' }];
const quiet = { quiet: true } as RemoteRunOptions;

async function withServer(
  handler: FakeHandler,
  body: (s: FakeServer) => Promise<void>,
): Promise<void> {
  const server = await startFakeServer(handler);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

type TransportOf = (url: string) => RunRemoteTransport;

/** Answers the first `route` read with `first`, every other read healthily. */
function firstRead(
  route: Route,
  first: (req: IncomingMessage, res: ServerResponse) => void,
): FakeHandler {
  return healthy((r, hit, req, res) => {
    if (r !== route || hit !== 1) return false;
    first(req, res);
    return true;
  });
}

/** The first status read sees the run running; every later one gets `then`. */
function seenThen(then: (hit: number, res: ServerResponse) => void): FakeHandler {
  return healthy((route, hit, _req, res) => {
    if (route !== 'status') return false;
    if (hit === 1) reply(res, 200, runStatus('running'));
    else then(hit, res);
    return true;
  });
}

/** The follow rides out the handler's failures: it succeeds, re-reads `route`, never cancels. */
async function expectRecovers(
  transportOf: TransportOf,
  handler: FakeHandler,
  route: Route,
  reads = 2,
): Promise<void> {
  await withServer(handler, async (server) => {
    const result = await followRuns(transportOf(server.url), RUN, 'fx', quiet, FAST);
    expect(result.status).toBe('success');
    expect(server.hits(route)).toBe(reads);
    expect(server.hits('cancel')).toBe(0);
  });
}

/** Ctrl-C after the first status read arrives cancels the run within 1.5 s. */
async function expectCtrlCCancels(
  transportOf: TransportOf,
  handler: FakeHandler,
  follow: FollowRunsOptions,
): Promise<void> {
  await withServer(handler, async (server) => {
    const started = Date.now();
    const done = followRuns(transportOf(server.url), RUN, 'fx', quiet, follow);
    await vi.waitFor(() => expect(server.hits('status')).toBeGreaterThan(0));
    process.emit('SIGINT');
    const result = await done;
    expect(result.status).toBe('cancelled');
    expect(server.hits('cancel')).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
}

/** Sends a 200 with a longer content-length, then drops the connection mid-body. */
function cutOff(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
  res.write('{"runId":');
  setTimeout(() => req.socket.destroy(), 10);
}

describe('followRuns against a server whose status reads fail', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  // fails-when: one failed status poll stops the follow
  it('retries a 500 from the run status read and follows the run to completion', async () => {
    await expectRecovers(
      directTransport,
      firstRead('status', (_req, res) => reply(res, 500, { error: 'Internal server error' })),
      'status',
    );
  });

  // fails-when: a dropped connection is not retried
  it('retries a connection the server resets', async () => {
    await expectRecovers(
      directTransport,
      firstRead('status', (req) => req.socket.destroy()),
      'status',
    );
  });

  // fails-when: the log read, which gates completion, is not retried
  it('retries a failed log read without losing lines', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await withServer(
      healthy((route, hit, _req, res) => {
        if (route !== 'logs' || hit !== 1) return false;
        reply(res, 502, { error: 'Relay failed' });
        return true;
      }),
      async (server) => {
        const result = await followRuns(
          directTransport(server.url),
          RUN,
          'fx',
          {} as RemoteRunOptions,
          FAST,
        );
        expect(result.status).toBe('success');
        expect(server.hits('logs')).toBe(2);
        expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes('hello'))).toBe(true);
      },
    );
  });

  // fails-when: a server that keeps failing is retried forever, or the error hides the run id
  // breaks-if-wrong: giving up on the follow must not cancel the run
  it('fails naming the run and the last error once the server keeps failing, without cancelling', async () => {
    await withServer(
      healthy((route, hit, _req, res) => {
        if (route !== 'status') return false;
        if (hit === 1) reply(res, 200, runStatus('running'));
        else reply(res, 503, { error: 'Service unavailable' });
        return true;
      }),
      async (server) => {
        const err = (await followRuns(directTransport(server.url), RUN, 'fx', quiet, {
          readRetry: { budgetMs: 60, baseDelayMs: 5, maxDelayMs: 10 },
          pollIntervalMs: 5,
        }).then(
          () => undefined,
          (e: unknown) => e,
        )) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('run-r');
        expect(err.message).toContain('status 503: Service unavailable');
        expect(err.message).toContain('last seen as "running"');
        expect(err.message).toContain('not cancelled');
        expect(server.hits('status')).toBeGreaterThan(2);
        expect(server.hits('cancel')).toBe(0);
      },
    );
  });

  // breaks-if-wrong: a refused token fails at once instead of waiting out the budget
  it('fails at once on a 401', async () => {
    await withServer(
      healthy((route, _hit, _req, res) => {
        if (route !== 'status') return false;
        reply(res, 401, { error: 'invalid token' });
        return true;
      }),
      async (server) => {
        const started = Date.now();
        await expect(
          followRuns(directTransport(server.url), RUN, 'fx', quiet, {
            readRetry: { budgetMs: 60_000, baseDelayMs: 1_000 },
          }),
        ).rejects.toBeInstanceOf(AuthenticationError);
        expect(server.hits('status')).toBe(1);
        expect(Date.now() - started).toBeLessThan(1_000);
      },
    );
  });

  // breaks-if-wrong: a run that disappears after it was seen fails at once, whatever the transport
  it.each([
    ['direct', directTransport],
    ['Platform', platformTransport],
  ] as const)('fails at once on a 404 with no code after the run was seen (%s)', async (_, of) => {
    await withServer(
      seenThen((_hit, res) => reply(res, 404, { error: 'Run not found' })),
      async (server) => {
        await expect(
          followRuns(of(server.url), RUN, 'fx', quiet, {
            readRetry: { budgetMs: 60_000, baseDelayMs: 1_000 },
            pollIntervalMs: 5,
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(server.hits('status')).toBe(2);
      },
    );
  });

  // fails-when: the Platform transport's relay failures are not retried
  it('retries a 503 through the Platform relay', async () => {
    await expectRecovers(
      platformTransport,
      firstRead('status', (_req, res) => reply(res, 503, { error: 'No orchestrator connected' })),
      'status',
    );
  });

  // breaks-if-wrong: an access refusal through the Platform fails at once
  it('fails at once on a 403 through the Platform relay', async () => {
    await withServer(
      healthy((route, _hit, _req, res) => {
        if (route !== 'status') return false;
        reply(res, 403, { error: 'Missing runs:read' });
        return true;
      }),
      async (server) => {
        await expect(
          followRuns(platformTransport(server.url), RUN, 'fx', quiet, {
            readRetry: { budgetMs: 60_000, baseDelayMs: 1_000 },
          }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
        expect(server.hits('status')).toBe(1);
      },
    );
  });

  // fails-when: Ctrl-C waits for the retry budget before the cancel settles
  it('stops retrying on Ctrl-C and cancels the run', async () => {
    await expectCtrlCCancels(
      directTransport,
      healthy((route, _hit, _req, res) => {
        if (route !== 'status') return false;
        reply(res, 503, { error: 'Service unavailable' });
        return true;
      }),
      { readRetry: { budgetMs: 60_000, baseDelayMs: 2_000, maxDelayMs: 2_000 } },
    );
  });
});

describe('followRuns against a server that stalls, cuts off or loses its orchestrator', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  // fails-when: the Platform's 404 for a reconnecting orchestrator reads as a missing run
  it('retries a Platform 404 coded orchestrator_not_found after the run was seen', async () => {
    const offline = {
      error: 'No orchestrator with that cluster name',
      code: 'orchestrator_not_found',
    };
    await expectRecovers(
      platformTransport,
      seenThen((hit, res) =>
        hit === 2 ? reply(res, 404, offline) : reply(res, 200, runStatus('success')),
      ),
      'status',
      3,
    );
  });

  // fails-when: a server that accepts the read and never answers hangs the follow
  it('times out a read the server never answers and retries it', async () => {
    await expectRecovers(
      (url) => directTransport(url, 100),
      firstRead('status', () => undefined),
      'status',
    );
  });

  // fails-when: Ctrl-C waits for a read in flight to reach its deadline; the deadline is
  // the 30 s default here, so only the abort ends the read within 1.5 s
  it('stops a read in flight on Ctrl-C and cancels the run', async () => {
    await expectCtrlCCancels(
      platformTransport,
      healthy((route) => route === 'status'),
      FAST,
    );
  });

  // fails-when: a status answer cut off mid-body ends the follow instead of retrying
  it('retries a status answer the orchestrator cuts off mid-body', async () => {
    await expectRecovers(directTransport, firstRead('status', cutOff), 'status');
  });

  // fails-when: a log answer cut off mid-body through the Platform ends the follow
  it('retries a log answer the Platform cuts off mid-body', async () => {
    await expectRecovers(platformTransport, firstRead('logs', cutOff), 'logs');
  });
});
