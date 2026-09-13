import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BACKOFF_MS, NotifyListener } from './notify-listener.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

/** A pg client stand-in that records queries and can be "killed". */
class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: unknown[] = [];
  failListen = false;

  query = vi.fn(async (sql: string) => {
    this.queries.push(sql);
    if (this.failListen && sql.startsWith('LISTEN')) throw new Error('connection refused');
    return { rows: [] };
  });

  release = (err?: unknown): void => {
    this.released.push(err ?? null);
  };

  removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }

  /** Simulate the backend going away. */
  kill(err = new Error('terminating connection due to administrator command')): void {
    this.emit('error', err);
  }
}

function fakePool(clients: FakeClient[]) {
  let i = 0;
  return {
    connect: vi.fn(async () => {
      const c = clients[Math.min(i, clients.length - 1)]!;
      i += 1;
      return c;
    }),
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotifyListener', () => {
  it('refuses a channel name that is not a bare identifier', () => {
    expect(
      () =>
        new NotifyListener({
          pool: fakePool([new FakeClient()]),
          channel: 'x; DROP TABLE users',
          onNotification: () => {},
          logger,
        }),
    ).toThrow(/not a valid identifier/);
  });

  it('subscribes on start and reports connected', async () => {
    const client = new FakeClient();
    const listener = new NotifyListener({
      pool: fakePool([client]),
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
    });

    await listener.start();

    expect(client.queries).toEqual(['LISTEN demo_channel']);
    expect(listener.connected).toBe(true);
  });

  it('delivers only its own channel notifications', async () => {
    const client = new FakeClient();
    const seen: string[] = [];
    const listener = new NotifyListener({
      pool: fakePool([client]),
      channel: 'demo_channel',
      onNotification: (msg) => seen.push(msg.payload ?? ''),
      logger,
    });
    await listener.start();

    client.emit('notification', { channel: 'demo_channel', payload: 'mine' });
    client.emit('notification', { channel: 'other_channel', payload: 'theirs' });

    expect(seen).toEqual(['mine']);
  });

  it('reconnects after the backend is terminated and runs the catch-up once', async () => {
    const dead = new FakeClient();
    const fresh = new FakeClient();
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    const listener = new NotifyListener({
      pool: fakePool([dead, fresh]),
      channel: 'demo_channel',
      onNotification: () => {},
      onReconnect,
      logger,
      baseBackoffMs: 10,
    });
    await listener.start();
    expect(onReconnect).not.toHaveBeenCalled();

    dead.kill();
    expect(listener.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(50);

    expect(fresh.queries).toEqual(['LISTEN demo_channel']);
    expect(listener.connected).toBe(true);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('delivers notifications again after reconnecting', async () => {
    const dead = new FakeClient();
    const fresh = new FakeClient();
    const seen: string[] = [];
    const listener = new NotifyListener({
      pool: fakePool([dead, fresh]),
      channel: 'demo_channel',
      onNotification: (msg) => seen.push(msg.payload ?? ''),
      logger,
      baseBackoffMs: 10,
    });
    await listener.start();

    dead.kill();
    await vi.advanceTimersByTimeAsync(50);
    fresh.emit('notification', { channel: 'demo_channel', payload: 'after' });

    expect(seen).toEqual(['after']);
  });

  it('treats a plain end the same as an error', async () => {
    const dead = new FakeClient();
    const fresh = new FakeClient();
    const listener = new NotifyListener({
      pool: fakePool([dead, fresh]),
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
      baseBackoffMs: 10,
    });
    await listener.start();

    dead.emit('end');
    await vi.advanceTimersByTimeAsync(50);

    expect(listener.connected).toBe(true);
  });

  it('keeps retrying while reconnection fails, then succeeds', async () => {
    const dead = new FakeClient();
    const broken = new FakeClient();
    broken.failListen = true;
    const good = new FakeClient();

    let i = 0;
    const order = [dead, broken, good];
    const pool = {
      connect: vi.fn(async () => order[Math.min(i++, order.length - 1)]!),
    } as any;

    const listener = new NotifyListener({
      pool,
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
      baseBackoffMs: 10,
    });
    await listener.start();

    dead.kill();
    await vi.advanceTimersByTimeAsync(500);

    expect(listener.connected).toBe(true);
    expect(good.queries).toEqual(['LISTEN demo_channel']);
    // The client whose LISTEN failed must go back to the pool, broken, rather
    // than leaking one connection per failed attempt.
    expect(broken.released.length).toBeGreaterThanOrEqual(1);
    expect(broken.released[0]).toBeInstanceOf(Error);
  });

  it('survives a catch-up that throws — the subscription stays live', async () => {
    const dead = new FakeClient();
    const fresh = new FakeClient();
    const listener = new NotifyListener({
      pool: fakePool([dead, fresh]),
      channel: 'demo_channel',
      onNotification: () => {},
      onReconnect: () => Promise.reject(new Error('catch-up blew up')),
      logger,
      baseBackoffMs: 10,
    });
    await listener.start();

    dead.kill();
    await vi.advanceTimersByTimeAsync(50);

    expect(listener.connected).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('stops cleanly, issuing UNLISTEN and releasing', async () => {
    const client = new FakeClient();
    const listener = new NotifyListener({
      pool: fakePool([client]),
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
    });
    await listener.start();

    await listener.stop();

    expect(client.queries).toEqual(['LISTEN demo_channel', 'UNLISTEN demo_channel']);
    expect(client.released).toHaveLength(1);
    expect(listener.connected).toBe(false);
    // pg's pool keeps whatever listeners a consumer attached, so a client
    // released with ours still on it carries them into the next checkout.
    expect(client.listenerCount('notification')).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('end')).toBe(0);
  });

  it('does not resurrect the subscription when stopped mid-backoff', async () => {
    const dead = new FakeClient();
    const fresh = new FakeClient();
    const listener = new NotifyListener({
      pool: fakePool([dead, fresh]),
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
      baseBackoffMs: 1000,
    });
    await listener.start();

    dead.kill();
    await listener.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(listener.connected).toBe(false);
    expect(fresh.queries).toEqual([]);
  });

  it('caps the backoff', async () => {
    // 250ms doubled far past the cap must never schedule beyond MAX_BACKOFF_MS.
    const dead = new FakeClient();
    const broken = new FakeClient();
    broken.failListen = true;
    const pool = { connect: vi.fn(async () => (dead.released.length ? broken : dead)) } as any;
    const listener = new NotifyListener({
      pool,
      channel: 'demo_channel',
      onNotification: () => {},
      logger,
      baseBackoffMs: 1000,
    });
    await listener.start();
    dead.kill();

    const spy = vi.spyOn(globalThis, 'setTimeout');
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);

    for (const call of spy.mock.calls) {
      expect(Number(call[1])).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
    spy.mockRestore();
  });
});
