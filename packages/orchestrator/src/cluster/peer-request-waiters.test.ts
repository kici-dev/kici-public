import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_REQUEST_TIMEOUT, PeerRequestWaiters } from './peer-request-waiters.js';

interface Res {
  messageId: string;
  value: string;
}

function makeWaiters(): PeerRequestWaiters<Res> {
  return new PeerRequestWaiters<Res>((messageId, reason) => ({ messageId, value: reason }));
}

describe('PeerRequestWaiters', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands the response to the request waiting for its message id', async () => {
    const waiters = makeWaiters();
    const pending = waiters.wait('m1', 1_000);
    waiters.resolve({ messageId: 'm1', value: 'answer' });
    expect(await pending).toEqual({ messageId: 'm1', value: 'answer' });
  });

  // fails-when: a wait with no response never settles, or settles before its timeout
  it('ends a wait with the timeout sentinel once the timeout passes', async () => {
    const waiters = makeWaiters();
    const pending = waiters.wait('m1', 1_000);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(PEER_REQUEST_TIMEOUT);
  });

  it('drops a response nobody waits for, and a late one after the timeout', async () => {
    const waiters = makeWaiters();
    waiters.resolve({ messageId: 'unknown', value: 'x' });
    const pending = waiters.wait('m1', 10);
    await vi.advanceTimersByTimeAsync(10);
    waiters.resolve({ messageId: 'm1', value: 'late' });
    expect(await pending).toBe(PEER_REQUEST_TIMEOUT);
  });

  it('answers every pending wait with the close-time response on rejectAll', async () => {
    const waiters = makeWaiters();
    const a = waiters.wait('a', 1_000);
    const b = waiters.wait('b', 1_000);
    waiters.rejectAll('disconnected');
    expect(await a).toEqual({ messageId: 'a', value: 'disconnected' });
    expect(await b).toEqual({ messageId: 'b', value: 'disconnected' });
    // The waits are gone: a response for them now is dropped.
    waiters.resolve({ messageId: 'a', value: 'late' });
  });
});
