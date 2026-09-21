import { describe, expect, it, vi } from 'vitest';
import { createBoundedSignerResolver } from './resolve-signer.js';
import type { Signer } from './signer.js';

const signer = { alg: 'ES256' } as unknown as Signer;

function build(reconcile: () => Promise<{ signer: Signer } | null>) {
  const sleep = vi.fn(async () => {});
  const logError = vi.fn();
  const resolve = createBoundedSignerResolver({
    reconcile,
    maxAttempts: 5,
    delayMs: 500,
    logError,
    sleep,
  });
  return { resolve, sleep, logError };
}

describe('createBoundedSignerResolver', () => {
  it('waits out a not-ready reconcile and memoizes the signer it finally gets', async () => {
    // breaks-if-wrong: the leader-election race at boot — a non-leader that
    // sees no row for a few ticks must still end up with the key.
    const reconcile = vi
      .fn<() => Promise<{ signer: Signer } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ signer });
    const { resolve, sleep, logError } = build(reconcile);
    await expect(resolve()).resolves.toBe(signer);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(logError).not.toHaveBeenCalled();
    await expect(resolve()).resolves.toBe(signer);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('gives up with null once the attempts are spent on a still-null reconcile', async () => {
    const reconcile = vi.fn(async () => null);
    const { resolve, sleep } = build(reconcile);
    await expect(resolve()).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('stops on the first thrown reconcile instead of retrying it, and names the cause', async () => {
    // fails-when: the loop swallows the throw and keeps going — reconcile would
    // be called 5 times and sleep 5 times, exactly the 30-second stall this
    // helper exists to remove.
    const reconcile = vi.fn(async () => {
      throw new Error('stranded: restore KICI_SECRET_KEY_OLD');
    });
    const { resolve, sleep, logError } = build(reconcile);
    await expect(resolve()).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![1]).toEqual({
      error: 'stranded: restore KICI_SECRET_KEY_OLD',
    });
  });

  it('reports a repeated cause once, and a changed cause again', async () => {
    let message = 'cause A';
    const reconcile = vi.fn(async () => {
      throw new Error(message);
    });
    const { resolve, logError } = build(reconcile);
    await resolve();
    await resolve();
    expect(logError).toHaveBeenCalledTimes(1);
    message = 'cause B';
    await resolve();
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[1]![1]).toEqual({ error: 'cause B' });
  });

  it('a recovered reconcile after a throw is cached and clears the reported cause', async () => {
    // breaks-if-wrong: an operator who restores the old master key and does
    // not restart must get a signer on the next mint, not the stale null.
    let fail = true;
    const reconcile = vi.fn(async () => {
      if (fail) throw new Error('stranded');
      return { signer };
    });
    const { resolve, logError } = build(reconcile);
    await expect(resolve()).resolves.toBeNull();
    fail = false;
    await expect(resolve()).resolves.toBe(signer);
    fail = true;
    await expect(resolve()).resolves.toBe(signer);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
