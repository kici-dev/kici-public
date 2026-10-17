import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AccessLogSource,
  ExecutionRunStatus,
  TEST_RUN_LOG_CURSOR_START,
  type ActorPrincipal,
} from '@kici-dev/engine';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import {
  handleTestUploadsInit,
  handleTestTrigger,
  handleTestRunStatus,
  handleTestRunLogs,
  handleTestCancel,
  type TestRelayHandlerDeps,
} from './test-relay-handlers.js';
import * as testPipeline from '../pipeline/test-pipeline.js';

vi.mock('../pipeline/test-pipeline.js', async (orig) => {
  const actual = await orig<typeof testPipeline>();
  return { ...actual, processTestTrigger: vi.fn() };
});

const ACTOR: ActorPrincipal = { type: 'user', sub: 'kc-sub-123' };

/** A chainable Kysely-like mock returning fixed results per table/op. */
function makeDbMock(opts: {
  runRow?: unknown;
  jobRows?: unknown[];
  dispatchRows?: unknown[];
  uploadRow?: unknown;
}) {
  const updateExec = vi.fn().mockResolvedValue(undefined);
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    execute: updateExec,
  };
  const insert = {
    values: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    selectFrom: vi.fn((table: string) => {
      const builder: any = {
        select: vi.fn().mockReturnThis(),
        selectAll: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi
          .fn()
          .mockResolvedValue(
            table === 'execution_runs'
              ? opts.runRow
              : table === 'test_uploads'
                ? opts.uploadRow
                : undefined,
          ),
        execute: vi
          .fn()
          .mockResolvedValue(
            table === 'dispatch_queue' ? (opts.dispatchRows ?? []) : (opts.jobRows ?? []),
          ),
      };
      return builder;
    }),
    updateTable: vi.fn().mockReturnValue(update),
    insertInto: vi.fn().mockReturnValue(insert),
  };
  return { db, update, insert };
}

describe('handleTestUploadsInit', () => {
  it('mints an upload via the developer-facing presigned URL', async () => {
    const getUploadUrl = vi.fn().mockResolvedValue('https://agent.example/put');
    const getInternalUploadUrl = vi.fn().mockResolvedValue('https://dev.example/put?sig=1');
    const { db, insert } = makeDbMock({});
    const deps = {
      db,
      cacheStorage: { getUploadUrl, getInternalUploadUrl },
    } as unknown as TestRelayHandlerDeps;

    const result = await handleTestUploadsInit(
      {
        type: 'test.relay.uploads.init',
        requestId: 'r1',
        actor: ACTOR,
        routingKey: 'remote:org_abc',
        sha: 'deadbeef',
        fileCount: 3,
        compressedSize: 100,
      },
      deps,
    );

    expect(getInternalUploadUrl).toHaveBeenCalledTimes(1);
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(result.signedUrl).toBe('https://dev.example/put?sig=1');
    expect(result.uploadId).toBeTruthy();
    expect(result.publicKey).toBeTruthy();
    expect(insert.values).toHaveBeenCalled();
  });
});

describe('handleTestTrigger', () => {
  beforeEach(() => vi.mocked(testPipeline.processTestTrigger).mockReset());

  it('resolves overlay from cliPublicKey, calls processTestTrigger, writes access_log', async () => {
    const initMeta = vi.fn().mockResolvedValue(undefined);
    const getUrl = vi.fn().mockResolvedValue('https://dl.example/tarball.enc');
    const { db } = makeDbMock({
      uploadRow: { storage_key: 'k/up.enc', encryption_private_key: 'priv-b64', sha: 'c0ffee' },
    });
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-1',
      status: 'accepted',
      jobIds: ['j1', 'j2'],
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const deps = {
      db,
      cacheStorage: { initMeta, getUrl },
      accessLog: { record },
      orgId: 'org_abc',
      routingKey: 'remote:org_abc',
    } as unknown as TestRelayHandlerDeps;

    const result = await handleTestTrigger(
      {
        type: 'test.relay.trigger',
        requestId: 'r2',
        actor: ACTOR,
        routingKey: 'remote:org_abc',
        fixtureId: 'fix-1',
        event: { type: 'push', targetBranch: 'main', payload: {} },
        uploadId: 'up-1',
        // The overlay-tarball key — distinct from any secrets key.
        cliPublicKey: 'overlay-pub-b64',
        // A secrets key may also be present; it must NOT be used for the overlay.
        encryptedSecretsKey: 'secrets-pub-b64',
      },
      deps,
    );

    expect(initMeta).toHaveBeenCalledWith('k/up.enc');
    const call = vi.mocked(testPipeline.processTestTrigger).mock.calls[0][0];
    expect(call.resolvedOverlay).toEqual({
      tarballUrl: 'https://dl.example/tarball.enc',
      cliPublicKey: 'overlay-pub-b64',
      orchestratorPrivateKey: 'priv-b64',
    });
    // fails-when: the upload's commit is not handed on, so a run whose event names no SHA records a branch
    expect(call.uploadSha).toBe('c0ffee');
    expect(result).toEqual({ runId: 'run-1', status: 'accepted', jobIds: ['j1', 'j2'] });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'run.trigger', outcome: 'allowed', actor: ACTOR }),
    );
    // breaks-if-wrong: the relay keeps its own source when no override is passed
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ source: AccessLogSource.enum.platform_proxy }),
    );
  });

  it('records the access-log source the caller passes', async () => {
    const { db } = makeDbMock({});
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-2',
      status: 'accepted',
      jobIds: [],
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const deps = {
      db,
      accessLog: { record },
      accessLogSource: AccessLogSource.enum.admin_http,
    } as unknown as TestRelayHandlerDeps;
    await handleTestTrigger(
      {
        type: 'test.relay.trigger',
        requestId: 'r9',
        actor: ACTOR,
        routingKey: 'remote:__default__',
        fixtureId: 'fix-1',
        event: { type: 'push', targetBranch: 'main', payload: {} },
      },
      deps,
    );
    // fails-when: the trigger always records platform_proxy, hiding a direct run's transport
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ source: AccessLogSource.enum.admin_http }),
    );
  });

  it('does NOT resolve an overlay when cliPublicKey is absent (no-secrets run regression)', async () => {
    // Guards the empty-workDir no-secrets fullRepo run: the overlay key comes
    // from `cliPublicKey`, never `encryptedSecretsKey`.
    const initMeta = vi.fn().mockResolvedValue(undefined);
    const getUrl = vi.fn().mockResolvedValue('https://dl.example/tarball.enc');
    const { db } = makeDbMock({
      uploadRow: { storage_key: 'k/up.enc', encryption_private_key: 'priv-b64' },
    });
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-3',
      status: 'accepted',
      jobIds: ['j1'],
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const deps = {
      db,
      cacheStorage: { initMeta, getUrl },
      accessLog: { record },
    } as unknown as TestRelayHandlerDeps;

    await handleTestTrigger(
      {
        type: 'test.relay.trigger',
        requestId: 'r4',
        actor: ACTOR,
        routingKey: 'remote:org_abc',
        fixtureId: 'fix-3',
        event: { type: 'push', targetBranch: 'main', payload: {} },
        uploadId: 'up-2',
        // No cliPublicKey. run-remote always sends one, so this guards the
        // contract, not the happy path.
      },
      deps,
    );

    expect(initMeta).not.toHaveBeenCalled();
    const call = vi.mocked(testPipeline.processTestTrigger).mock.calls[0][0];
    expect(call.resolvedOverlay).toBeUndefined();
  });

  it('records a denied access_log row and returns reason on rejection', async () => {
    const { db } = makeDbMock({});
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-2',
      status: 'rejected',
      reason: 'no matching trigger',
      jobIds: [],
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const deps = { db, accessLog: { record } } as unknown as TestRelayHandlerDeps;

    const result = await handleTestTrigger(
      {
        type: 'test.relay.trigger',
        requestId: 'r3',
        actor: ACTOR,
        routingKey: 'remote:org_abc',
        fixtureId: 'fix-2',
        event: { type: 'push', targetBranch: 'main', payload: {} },
      },
      deps,
    );

    expect(result).toEqual({
      runId: 'run-2',
      status: 'rejected',
      reason: 'no matching trigger',
      jobIds: [],
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });
});

describe('handleTestRunStatus', () => {
  it('returns status + jobs + done=true for terminal runs', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
      jobRows: [
        {
          job_id: 'j1',
          job_name: 'build',
          status: 'success',
          error_message: null,
          duration_ms: 9400,
        },
      ],
    });
    const result = await handleTestRunStatus(
      { type: 'test.relay.run.status', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    // fails-when: the handler drops duration_ms, so `kici run remote`'s summary
    // table prints `-` in its Duration column for every relayed job.
    expect(result).toEqual({
      runId: 'run-1',
      status: 'success',
      jobs: [
        { jobId: 'j1', jobName: 'build', status: 'success', errorMessage: null, durationMs: 9400 },
      ],
      done: true,
    });
  });

  it('reports a null duration for a job that has not finished', async () => {
    // breaks-if-wrong: a running job has no duration yet; the field must be
    // null, never a crash on the missing column value.
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
      jobRows: [
        {
          job_id: 'j1',
          job_name: 'build',
          status: 'running',
          error_message: null,
          duration_ms: null,
        },
      ],
    });
    const result = await handleTestRunStatus(
      { type: 'test.relay.run.status', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toMatchObject({ jobs: [{ jobName: 'build', durationMs: null }], done: false });
  });

  it('done=false for a running run', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
      jobRows: [],
    });
    const result = await handleTestRunStatus(
      { type: 'test.relay.run.status', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toMatchObject({ status: 'running', done: false });
  });

  it('returns an error for a non-test or missing run', async () => {
    const { db } = makeDbMock({ runRow: undefined });
    const result = await handleTestRunStatus(
      { type: 'test.relay.run.status', requestId: 'r', actor: ACTOR, runId: 'nope' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toEqual({ error: 'Run not found' });
  });
});

describe('handleTestRunLogs', () => {
  /** A log storage stub whose files map to fixed line arrays. */
  function logStorageStub(files: Record<string, string>) {
    return {
      list: vi.fn().mockResolvedValue(Object.keys(files)),
      read: vi.fn((p: string) => Promise.resolve({ data: files[p], cursor: 0, complete: true })),
    };
  }

  const FILES = {
    'executions/run-1/job-build/step-0.log': 'b0-l1\nb0-l2',
    'executions/run-1/job-build/step-1.log': 'b1-l1',
    'executions/run-1/job-test/step-0.log': 't0-l1\nt0-l2',
  };
  // Ordered (jobName ASC, stepIndex ASC, lineIndex ASC):
  const ORDERED = ['b0-l1', 'b0-l2', 'b1-l1', 't0-l1', 't0-l2'];

  it('returns lines from the cursor and advances nextCursor', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    const logStorage = logStorageStub(FILES);
    const result = await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      { db, logStorage } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toEqual({ lines: ORDERED, nextCursor: ORDERED.length, done: true });
  });

  it("includes each job's setup log (step -1) ahead of its steps", async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    const logStorage = logStorageStub({
      ...FILES,
      'executions/run-1/job-build/step--1.log': 'b-setup',
    });
    const result = await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      { db, logStorage } as unknown as TestRelayHandlerDeps,
    );
    // fails-when: the path match skips `step--1.log`, so `kici run remote`
    // never prints the host checkout and install lines.
    expect(result).toEqual({
      lines: ['b-setup', ...ORDERED],
      nextCursor: ORDERED.length + 1,
      done: true,
    });
  });

  it('never drops a line across two sequential polls of a live run', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
    });
    const logStorage = logStorageStub(FILES);
    const depsLive = { db, logStorage } as unknown as TestRelayHandlerDeps;

    const first = (await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      depsLive,
    )) as { lines: string[]; nextCursor: number; done: boolean };
    expect(first.done).toBe(false); // live run is never done
    expect(first.nextCursor).toBe(ORDERED.length);

    const second = (await handleTestRunLogs(
      {
        type: 'test.relay.run.logs',
        requestId: 'r',
        actor: ACTOR,
        runId: 'run-1',
        cursor: first.nextCursor,
      },
      depsLive,
    )) as { lines: string[]; nextCursor: number; done: boolean };
    // No gap, no overlap: the two polls cover exactly the full stream once.
    expect([...first.lines, ...second.lines]).toEqual(ORDERED);
    expect(second.nextCursor).toBe(ORDERED.length);
  });

  it('terminal-but-not-caught-up returns the tail with done=false, then the drain poll is done=true', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    const logStorage = logStorageStub(FILES);
    const deps = { db, logStorage } as unknown as TestRelayHandlerDeps;

    // Poll with a cursor short of the end: tail returned, done=false.
    const tail = (await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 2 },
      deps,
    )) as { lines: string[]; nextCursor: number; done: boolean };
    expect(tail.lines).toEqual(ORDERED.slice(2));
    expect(tail.nextCursor).toBe(ORDERED.length);
    expect(tail.done).toBe(true); // cursor 2 + 3 lines reaches end on a terminal run

    // A drain poll already at the end returns no lines and done=true.
    const drain = (await handleTestRunLogs(
      {
        type: 'test.relay.run.logs',
        requestId: 'r',
        actor: ACTOR,
        runId: 'run-1',
        cursor: ORDERED.length,
      },
      deps,
    )) as { lines: string[]; nextCursor: number; done: boolean };
    expect(drain.lines).toEqual([]);
    expect(drain.done).toBe(true);
  });

  it('drains pending log appends for a terminal run before computing done', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    // The final "marker" file is invisible until the pending append drains —
    // the race that drops the last user-visible line. The drain mock makes the
    // marker appear, so the result proves drain() was awaited.
    const visibleFiles: Record<string, string> = { ...FILES };
    const logStorage = {
      list: vi.fn(() => Promise.resolve(Object.keys(visibleFiles))),
      read: vi.fn((p: string) =>
        Promise.resolve({ data: visibleFiles[p], cursor: 0, complete: true }),
      ),
    };
    const drain = vi.fn(async () => {
      visibleFiles['executions/run-1/job-test/step-1.log'] = 'marker:DYNENV_SECRET_OK';
    });
    const deps = { db, logStorage, logWriter: { drain } } as unknown as TestRelayHandlerDeps;

    const result = (await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      deps,
    )) as { lines: string[]; nextCursor: number; done: boolean };

    expect(drain).toHaveBeenCalledWith('run-1');
    // No done:true without the marker line.
    expect(result.lines).toContain('marker:DYNENV_SECRET_OK');
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBe(result.lines.length);
  });

  it('does not drain for a non-terminal run', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
    });
    const logStorage = logStorageStub(FILES);
    const drain = vi.fn(async () => {});
    const deps = { db, logStorage, logWriter: { drain } } as unknown as TestRelayHandlerDeps;

    await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      deps,
    );
    expect(drain).not.toHaveBeenCalled();
  });

  /** A storage whose files the test appends to between polls. */
  function liveStorage(files: Record<string, string>) {
    return {
      list: vi.fn(async () => Object.keys(files)),
      read: vi.fn(async (p: string) => ({ data: files[p] ?? '', cursor: 0, complete: true })),
    };
  }

  type Page = { lines: string[]; nextCursor: number; nextLogCursor?: string; done: boolean };

  async function poll(deps: TestRelayHandlerDeps, logCursor: string): Promise<Page> {
    return (await handleTestRunLogs(
      {
        type: 'test.relay.run.logs',
        requestId: 'r',
        actor: ACTOR,
        runId: 'run-1',
        cursor: 0,
        logCursor,
      },
      deps,
    )) as Page;
  }

  it('delivers a step file that appears after an already-read init file, with no line lost or repeated', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
    });
    // Setup and init ran first. The step's file appears later but sorts before
    // init, because init steps index from 1_000_000.
    const files: Record<string, string> = {
      'executions/run-1/job-build/step--1.log': 'setup-1\n',
      'executions/run-1/job-build/step-1000000.log': 'init-1\ninit-2\n',
    };
    const deps = { db, logStorage: liveStorage(files) } as unknown as TestRelayHandlerDeps;

    const first = await poll(deps, TEST_RUN_LOG_CURSOR_START);
    expect(first.lines).toEqual(['setup-1', 'init-1', 'init-2']);

    files['executions/run-1/job-build/step-0.log'] = 'step-failure-line\nstep-2\n';
    const second = await poll(deps, first.nextLogCursor!);

    // fails-when: the cursor is one offset into the flat sorted stream, so the
    // poll returns init's tail again and skips the step's first line
    expect(second.lines).toEqual(['step-failure-line', 'step-2']);
    expect(second.done).toBe(false);
  });

  it('delivers every line exactly once, in file order, whatever order the files grow in', async () => {
    const paths = [
      'executions/run-1/job-a/step--1.log',
      'executions/run-1/job-a/step-0.log',
      'executions/run-1/job-a/step-1000000.log',
      'executions/run-1/job-b/step-0.log',
    ];
    // A seeded generator keeps every schedule reproducible.
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    for (let schedule = 0; schedule < 40; schedule++) {
      const { db } = makeDbMock({
        runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
      });
      const files: Record<string, string> = {};
      const written: Record<string, string[]> = Object.fromEntries(paths.map((p) => [p, []]));
      const delivered: string[] = [];
      const deps = { db, logStorage: liveStorage(files) } as unknown as TestRelayHandlerDeps;
      let cursor = TEST_RUN_LOG_CURSOR_START;
      for (let i = 0; i < 24; i++) {
        const path = paths[next() % paths.length]!;
        const line = `${path.slice(-12)}#${written[path]!.length}`;
        written[path]!.push(line);
        files[path] = `${files[path] ?? ''}${line}\n`;
        if (next() % 2 === 0) {
          const page = await poll(deps, cursor);
          delivered.push(...page.lines);
          cursor = page.nextLogCursor!;
        }
      }
      delivered.push(...(await poll(deps, cursor)).lines);
      // fails-when: a file that appears between polls is offset by lines read
      // from other files, so a line is lost or delivered twice
      for (const path of paths) {
        const suffix = path.slice(-12);
        expect(delivered.filter((l) => l.startsWith(`${suffix}#`))).toEqual(written[path]);
      }
      expect(delivered).toHaveLength(Object.values(written).flat().length);
    }
  });

  it('holds back an unterminated last line until it ends', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
    });
    const files: Record<string, string> = { 'executions/run-1/job-build/step-0.log': 'a\nhal' };
    const deps = { db, logStorage: liveStorage(files) } as unknown as TestRelayHandlerDeps;
    const first = await poll(deps, TEST_RUN_LOG_CURSOR_START);
    // fails-when: a half-written line is delivered and counted, so its end is lost
    expect(first.lines).toEqual(['a']);
    files['executions/run-1/job-build/step-0.log'] = 'a\nhalf-done\n';
    expect((await poll(deps, first.nextLogCursor!)).lines).toEqual(['half-done']);
  });

  it('delivers an unterminated last line once the run is terminal', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    const deps = {
      db,
      logStorage: liveStorage({ 'executions/run-1/job-build/step-0.log': 'a\nno-newline' }),
    } as unknown as TestRelayHandlerDeps;
    const page = await poll(deps, TEST_RUN_LOG_CURSOR_START);
    // breaks-if-wrong: a file that never ends in a newline still delivers its
    // last line before `done`
    expect(page.lines).toEqual(['a', 'no-newline']);
    expect(page.done).toBe(true);
  });

  it('refuses a malformed cursor', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
    });
    const deps = { db, logStorage: liveStorage({}) } as unknown as TestRelayHandlerDeps;
    expect(await poll(deps, 'not-a-cursor')).toEqual({ error: 'Invalid log cursor' });
  });
});

describe('handleTestCancel', () => {
  it('cancels dispatched jobs, expires pending queue rows, marks the run cancelled', async () => {
    const send = vi.fn();
    const { db, update } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'running', is_test_run: true },
      dispatchRows: [
        { id: 'q1', status: 'dispatched' },
        { id: 'q2', status: 'pending' },
      ],
    });
    const deps = {
      db,
      dispatcher: { getAgentIdForJob: vi.fn((id: string) => (id === 'q1' ? 'agent-1' : null)) },
      agentRegistry: { get: vi.fn().mockReturnValue({ ws: { send } }) },
      accessLog: { record: vi.fn().mockResolvedValue(undefined) },
    } as unknown as TestRelayHandlerDeps;

    const result = await handleTestCancel(
      { type: 'test.relay.cancel', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      deps,
    );

    expect(result).toEqual({ cancelled: true });
    expect(send).toHaveBeenCalledTimes(1); // only the dispatched job got a job.cancel
    // fails-when: the pending row is stamped with the off-enum `cancelled` the prune and scrub skip
    expect(db.updateTable).toHaveBeenCalledWith('dispatch_queue');
    expect(update.set).toHaveBeenCalledWith({ status: DispatchQueueStatus.Expired });
    expect(db.updateTable).toHaveBeenCalledWith('execution_runs');
    expect(update.set).toHaveBeenCalledWith({ status: ExecutionRunStatus.enum.cancelled });
  });

  it('returns cancelled=false for an already-terminal run', async () => {
    const { db } = makeDbMock({
      runRow: { run_id: 'run-1', status: 'success', is_test_run: true },
    });
    const result = await handleTestCancel(
      { type: 'test.relay.cancel', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toEqual({ cancelled: false });
  });

  it('returns an error when runId is missing', async () => {
    const { db } = makeDbMock({});
    const result = await handleTestCancel(
      { type: 'test.relay.cancel', requestId: 'r', actor: ACTOR },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toEqual({ error: 'runId required' });
  });
});

/**
 * Attribution of a relayed test run: the schema-required `actor` on
 * `test.relay.trigger` must reach the pipeline, not only the `access_log` row.
 * Otherwise `execution_runs.triggered_by` stays NULL for every
 * `kici run remote` run, and the dashboard, `kici runs show` and `kici-admin`
 * report no initiator.
 */
describe('handleTestTrigger attribution', () => {
  // The pipeline mock is module-scoped and shared with the describe above, so
  // without this reset `mock.calls[0]` is that block's first call, not ours.
  beforeEach(() => vi.mocked(testPipeline.processTestTrigger).mockReset());

  /** The same agent-kind actor shape a user driving KiCI through an agent PAT mints. */
  const AGENT_ACTOR: ActorPrincipal = {
    type: 'user',
    sub: 'kc-sub-123',
    agent: { patId: 'pat-9', label: 'ci' },
  };

  function triggerDeps() {
    const { db } = makeDbMock({});
    return {
      db,
      accessLog: { record: vi.fn().mockResolvedValue(undefined) },
    } as unknown as TestRelayHandlerDeps;
  }

  function triggerMsg(actor: ActorPrincipal) {
    return {
      type: 'test.relay.trigger' as const,
      requestId: 'r-attr',
      actor,
      routingKey: 'remote:org_abc',
      fixtureId: 'fix-1',
      event: { type: 'push', targetBranch: 'main', payload: {} },
    };
  }

  it('threads the relayed actor into the pipeline', async () => {
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-1',
      status: 'accepted',
      jobIds: [],
    });

    await handleTestTrigger(triggerMsg(ACTOR), triggerDeps());

    const call = vi.mocked(testPipeline.processTestTrigger).mock.calls[0][0];
    expect(call.actor).toEqual(ACTOR);
  });

  it('threads an agent-kind actor through unflattened', async () => {
    // The pipeline, not the handler, splits provenance across `triggered_by`
    // and `triggered_by_agent_label`.
    vi.mocked(testPipeline.processTestTrigger).mockResolvedValue({
      runId: 'run-2',
      status: 'accepted',
      jobIds: [],
    });

    await handleTestTrigger(triggerMsg(AGENT_ACTOR), triggerDeps());

    const call = vi.mocked(testPipeline.processTestTrigger).mock.calls[0][0];
    expect(call.actor).toEqual(AGENT_ACTOR);
    expect(call.actor?.type === 'user' && call.actor.agent?.label).toBe('ci');
  });
});
