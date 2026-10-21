import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestContext, getRequestContext } from '@kici-dev/shared';

const log = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));

vi.mock('@kici-dev/shared', async () => {
  const actual = await vi.importActual<typeof import('@kici-dev/shared')>('@kici-dev/shared');
  return { ...actual, createLogger: vi.fn(() => log) };
});

const { startAcceptedDispatch, settleAcceptedDispatches } = await import('./accepted-dispatch.js');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SETTLED = Symbol('settled');
const PENDING = Symbol('pending');

async function stateWithin(promise: Promise<unknown>, ms: number): Promise<symbol> {
  return Promise.race([
    promise.then(() => SETTLED),
    new Promise<symbol>((r) => setTimeout(() => r(PENDING), ms)),
  ]);
}

describe('startAcceptedDispatch', () => {
  beforeEach(() => {
    log.error.mockClear();
  });

  it('returns before its work settles', async () => {
    const gate = deferred();
    const work = vi.fn(() => gate.promise);
    const recordFailure = vi.fn(async () => {});

    // fails-when: the helper awaits `work` (it would not return synchronously)
    expect(startAcceptedDispatch({ runId: 'r1', kind: 'Re-run', work, recordFailure })).toBe(
      undefined,
    );
    expect(await stateWithin(settleAcceptedDispatches(), 50)).toBe(PENDING);
    expect(work).toHaveBeenCalledTimes(1);

    gate.resolve();
    expect(await stateWithin(settleAcceptedDispatches(), 1_000)).toBe(SETTLED);
  });

  it('records a thrown work on the run', async () => {
    const recordFailure = vi.fn(async (_reason: string) => {});
    startAcceptedDispatch({
      runId: 'r2',
      kind: 'Re-run',
      work: async () => {
        throw new Error('boom');
      },
      recordFailure,
    });
    await settleAcceptedDispatches();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure.mock.calls[0]![0]).toBe('Re-run could not be dispatched: boom');
  });

  it('records a synchronous throw', async () => {
    const recordFailure = vi.fn(async (_reason: string) => {});
    startAcceptedDispatch({
      runId: 'r3',
      kind: 'Re-run',
      work: () => {
        throw new Error('sync boom');
      },
      recordFailure,
    });
    await settleAcceptedDispatches();
    expect(recordFailure).toHaveBeenCalledWith('Re-run could not be dispatched: sync boom');
  });

  it('logs a failing recordFailure and never rethrows it', async () => {
    startAcceptedDispatch({
      runId: 'r4',
      kind: 'Re-run',
      work: async () => {
        throw new Error('boom');
      },
      recordFailure: async () => {
        throw new Error('db down');
      },
    });
    await expect(settleAcceptedDispatches()).resolves.toBeUndefined();
    const recordLog = log.error.mock.calls.find(
      (call) => call[0] === 'Could not record a failed dispatch on its run',
    );
    expect(recordLog?.[1]).toMatchObject({ runId: 'r4', error: 'db down' });
  });

  it('never records a failure for work that succeeds', async () => {
    const recordFailure = vi.fn(async () => {});
    startAcceptedDispatch({ runId: 'r5', kind: 'Re-run', work: async () => {}, recordFailure });
    await settleAcceptedDispatches();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("runs the work inside the caller's request context", async () => {
    let seen: string | undefined;
    // fails-when: the work starts from a context-losing callback, so the
    // dispatch logs no request id
    requestContext.run({ requestId: 'req-ctx-1' }, () => {
      startAcceptedDispatch({
        runId: 'r6',
        kind: 'Re-run',
        work: async () => {
          seen = getRequestContext()?.requestId;
        },
        recordFailure: async () => {},
      });
    });
    await settleAcceptedDispatches();
    expect(seen).toBe('req-ctx-1');
  });
});
