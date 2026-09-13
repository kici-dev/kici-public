// Covers surface: cli:kici-admin:attestations retry
import { describe, expect, it, vi } from 'vitest';
import { runAttestationRetry } from './attestations-retry.js';

describe('runAttestationRetry', () => {
  it('drains all pending when no scope is given', async () => {
    const post = vi.fn(async () => ({ minted: 2, stillPending: 1, rejected: 0 }));
    const res = await runAttestationRetry(post, {});
    expect(res).toEqual({ minted: 2, stillPending: 1, rejected: 0 });
    expect(post).toHaveBeenCalledWith({});
  });

  it('drains all pending for --all-pending', async () => {
    const post = vi.fn(async () => ({ minted: 3, stillPending: 0, rejected: 0 }));
    await runAttestationRetry(post, { allPending: true });
    expect(post).toHaveBeenCalledWith({});
  });

  it('scopes to a single run for --run-id', async () => {
    const post = vi.fn(async () => ({ minted: 1, stillPending: 0, rejected: 0 }));
    await runAttestationRetry(post, { runId: 'r1' });
    expect(post).toHaveBeenCalledWith({ runId: 'r1' });
  });

  it('forwards includeRejected in the body and returns the rejected count', async () => {
    const post = vi.fn(async () => ({ minted: 0, stillPending: 0, rejected: 2 }));
    const res = await runAttestationRetry(post, { allPending: true, includeRejected: true });
    expect(post).toHaveBeenCalledWith({ includeRejected: true });
    expect(res.rejected).toBe(2);
  });

  it('combines includeRejected with a run scope', async () => {
    const post = vi.fn(async () => ({ minted: 0, stillPending: 0, rejected: 1 }));
    await runAttestationRetry(post, { runId: 'r1', includeRejected: true });
    expect(post).toHaveBeenCalledWith({ includeRejected: true, runId: 'r1' });
  });
});
