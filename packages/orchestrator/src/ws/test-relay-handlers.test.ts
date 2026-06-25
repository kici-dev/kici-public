import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActorPrincipal } from '@kici-dev/engine';
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
  it('mints an upload via the external presigned URL (internal=false)', async () => {
    const getUploadUrl = vi.fn().mockResolvedValue('https://ext.example/put?sig=1');
    const getInternalUploadUrl = vi.fn().mockResolvedValue('https://internal.example/put');
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

    expect(getUploadUrl).toHaveBeenCalledTimes(1);
    expect(getInternalUploadUrl).not.toHaveBeenCalled();
    expect(result.signedUrl).toBe('https://ext.example/put?sig=1');
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
      uploadRow: { storage_key: 'k/up.enc', encryption_private_key: 'priv-b64' },
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
    expect(result).toEqual({ runId: 'run-1', status: 'accepted', jobIds: ['j1', 'j2'] });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'run.trigger', outcome: 'allowed', actor: ACTOR }),
    );
  });

  it('does NOT resolve an overlay when cliPublicKey is absent (no-secrets run regression)', async () => {
    // Regression for the no-secrets fullRepo run that produced an empty workDir:
    // the overlay key must come from `cliPublicKey`, never `encryptedSecretsKey`.
    // With only an uploadId (no cliPublicKey), no overlay is resolved.
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
        // No cliPublicKey → overlay cannot be resolved (and must not fall back
        // to encryptedSecretsKey). For run-remote the CLI always sends
        // cliPublicKey, so this guards the contract, not the happy path.
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
      jobRows: [{ job_id: 'j1', job_name: 'build', status: 'success', error_message: null }],
    });
    const result = await handleTestRunStatus(
      { type: 'test.relay.run.status', requestId: 'r', actor: ACTOR, runId: 'run-1' },
      { db } as unknown as TestRelayHandlerDeps,
    );
    expect(result).toEqual({
      runId: 'run-1',
      status: 'success',
      jobs: [{ jobId: 'j1', jobName: 'build', status: 'success', errorMessage: null }],
      done: true,
    });
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
    // The final log file ("marker") is not yet visible to list/read until the
    // pending append is drained — the race that drops the last user-visible
    // line. The logWriter.drain mock both proves drain() is awaited AND, when
    // it resolves, makes the marker file appear in the storage snapshot.
    const visibleFiles: Record<string, string> = { ...FILES };
    const logStorage = {
      list: vi.fn(() => Promise.resolve(Object.keys(visibleFiles))),
      read: vi.fn((p: string) =>
        Promise.resolve({ data: visibleFiles[p], cursor: 0, complete: true }),
      ),
    };
    const drain = vi.fn(async () => {
      // Simulate the pending append landing as part of the drain.
      visibleFiles['executions/run-1/job-test/step-1.log'] = 'marker:DYNENV_SECRET_OK';
    });
    const deps = { db, logStorage, logWriter: { drain } } as unknown as TestRelayHandlerDeps;

    const result = (await handleTestRunLogs(
      { type: 'test.relay.run.logs', requestId: 'r', actor: ACTOR, runId: 'run-1', cursor: 0 },
      deps,
    )) as { lines: string[]; nextCursor: number; done: boolean };

    expect(drain).toHaveBeenCalledWith('run-1');
    // The marker line — written during the drain — is present, AND the response
    // is only done once it has been included (no done:true without the line).
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
});

describe('handleTestCancel', () => {
  it('cancels dispatched jobs, marks pending + run cancelled, returns cancelled=true', async () => {
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
    // update was called for both dispatch_queue pending and execution_runs.
    expect(update.execute).toHaveBeenCalled();
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
