import { describe, it, expect, vi } from 'vitest';
import {
  READ_RETRY_BUDGET_MS,
  ReadRetryExhaustedError,
  isTransientRemoteReadError,
  readWithRetry,
} from './read-retry.js';
import {
  AccessDeniedError,
  AuthenticationError,
  ConnectionError,
  HttpStatusError,
  NotFoundError,
} from './platform-client.js';

const status = (code: number) => new HttpStatusError(`Request failed with status ${code}`, code);

describe('isTransientRemoteReadError', () => {
  // fails-when: a server-side failure or a dropped connection is treated as final
  it('treats 5xx, 429, 408 and a transport failure as transient', () => {
    for (const code of [500, 502, 503, 504, 429, 408]) {
      expect(isTransientRemoteReadError(status(code)), String(code)).toBe(true);
    }
    expect(isTransientRemoteReadError(new ConnectionError('fetch failed'))).toBe(true);
  });

  // fails-when: the Platform's 404 for an orchestrator that is reconnecting ends the follow
  it('treats a 404 coded orchestrator_not_found as transient', () => {
    const offline = new NotFoundError(
      'No orchestrator with that cluster name',
      'orchestrator_not_found',
    );
    expect(isTransientRemoteReadError(offline)).toBe(true);
  });

  // breaks-if-wrong: a refusal retrying cannot fix still fails at once
  it('treats a refusal and an unknown error as final', () => {
    for (const code of [400, 409, 422]) {
      expect(isTransientRemoteReadError(status(code)), String(code)).toBe(false);
    }
    expect(isTransientRemoteReadError(new AuthenticationError())).toBe(false);
    expect(isTransientRemoteReadError(new AccessDeniedError())).toBe(false);
    // fails-when: any 404 is retried, so a missing run is polled for the whole budget
    expect(isTransientRemoteReadError(new NotFoundError('Run not found'))).toBe(false);
    expect(isTransientRemoteReadError(new NotFoundError('Run not found', 'other_code'))).toBe(
      false,
    );
    expect(isTransientRemoteReadError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isTransientRemoteReadError('status 500')).toBe(false);
  });
});

describe('readWithRetry', () => {
  it('rides out consecutive transient failures and returns the first success', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(status(500))
      .mockRejectedValueOnce(new ConnectionError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const onTransientFailure = vi.fn();
    await expect(
      readWithRetry(read, { budgetMs: 5_000, baseDelayMs: 1, onTransientFailure }),
    ).resolves.toBe('ok');
    expect(read).toHaveBeenCalledTimes(3);
    expect(onTransientFailure).toHaveBeenCalledTimes(2);
  });

  // fails-when: a 404 is retried (the run does not exist; waiting changes nothing)
  it('rethrows a final error on the first attempt', async () => {
    const notFound = new NotFoundError('Run not found');
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(notFound);
    await expect(readWithRetry(read, { budgetMs: 5_000, baseDelayMs: 1 })).rejects.toBe(notFound);
    expect(read).toHaveBeenCalledTimes(1);
  });

  // fails-when: a server that never recovers is retried forever
  it('gives up once the failures outlast the budget, naming the last error', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(status(500));
    const err = await readWithRetry(read, { budgetMs: 50, baseDelayMs: 5, maxDelayMs: 10 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReadRetryExhaustedError);
    expect((err as ReadRetryExhaustedError).lastError).toBeInstanceOf(HttpStatusError);
    expect((err as Error).message).toContain('Request failed with status 500');
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });

  it("classifies and names errors with the caller's functions", async () => {
    const custom = new Error('custom outage');
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(custom);
    const err = await readWithRetry(read, {
      budgetMs: 20,
      baseDelayMs: 5,
      isTransient: (e) => e === custom,
      describe: () => 'described',
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('(last error: described)');
  });

  // fails-when: an aborted caller still waits out the backoff and the budget
  it('rethrows the last failure once its signal is aborted', async () => {
    const failure = status(503);
    const stop = new AbortController();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    const started = Date.now();
    const pending = readWithRetry(read, {
      budgetMs: 60_000,
      baseDelayMs: 5_000,
      signal: stop.signal,
      onTransientFailure: () => stop.abort(),
    });
    await expect(pending).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('defaults to a two-minute budget', () => {
    expect(READ_RETRY_BUDGET_MS).toBe(120_000);
  });
});
