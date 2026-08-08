import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { createPool, isPoolAcquireTimeout } from './db.js';

// pg.Pool never connects at construction time, so emitting events on the
// returned pool exercises the handlers without a database.
describe('createPool error handling', () => {
  it('absorbs an idle-pool error instead of throwing', () => {
    const pool = createPool('postgresql://user:pw@127.0.0.1:1/db');
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
  });

  it('invokes the onError hook with source idle-pool', () => {
    const onError = vi.fn();
    const pool = createPool('postgresql://user:pw@127.0.0.1:1/db', { onError });
    const err = new Error('boom');
    pool.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err, 'idle-pool');
  });

  it('guards checked-out clients via the connect listener', () => {
    const onError = vi.fn();
    const pool = createPool('postgresql://user:pw@127.0.0.1:1/db', { onError });
    const fakeClient = new EventEmitter();
    pool.emit('connect', fakeClient);
    const err = new Error('client boom');
    expect(() => fakeClient.emit('error', err)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(err, 'client');
  });

  it('dedupes the same error arriving via both client and pool listeners', () => {
    const onError = vi.fn();
    const pool = createPool('postgresql://user:pw@127.0.0.1:1/db', { onError });
    const fakeClient = new EventEmitter();
    pool.emit('connect', fakeClient);
    const err = new Error('shared boom');
    fakeClient.emit('error', err);
    pool.emit('error', err);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('passes extra pool config through to pg.Pool', () => {
    const pool = createPool('postgresql://user:pw@127.0.0.1:1/db', {
      config: { max: 1, connectionTimeoutMillis: 5000 },
    });
    expect(pool.options.max).toBe(1);
    expect(pool.options.connectionTimeoutMillis).toBe(5000);
  });
});

/**
 * The `onAcquire` hook. Driven by stubbing `pg.Pool.prototype.connect` rather
 * than by reaching a real database: `createPool` captures the prototype method
 * as the delegate at construction time, so a stub installed first IS the
 * underlying acquire. That keeps this file database-free like the rest of it,
 * and lets a rejection be shaped exactly (an acquire timeout vs a connection
 * error), which a live pool cannot do on demand.
 */
describe('createPool onAcquire', () => {
  afterEach(() => vi.restoreAllMocks());

  const ACQUIRE_TIMEOUT = () => new Error('timeout exceeded when trying to connect');
  const URL = 'postgresql://user:pw@127.0.0.1:1/db';

  /** Replace the underlying acquire; returns the spy so call shapes can be asserted. */
  function stubConnect(impl: (...args: unknown[]) => unknown) {
    return vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(impl as never);
  }

  it('reports a successful acquire with the wait duration', async () => {
    const client = {} as pg.PoolClient;
    stubConnect(() => Promise.resolve(client));
    const seen: Array<{ outcome: string; waitedMs: number }> = [];
    const pool = createPool(URL, {
      onAcquire: (outcome, waitedMs) => seen.push({ outcome, waitedMs }),
    });
    await expect(pool.connect()).resolves.toBe(client);
    expect(seen).toEqual([{ outcome: 'ok', waitedMs: expect.any(Number) }]);
    expect(seen[0]?.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a pool-acquire timeout and still rejects the caller', async () => {
    stubConnect(() => Promise.reject(ACQUIRE_TIMEOUT()));
    const seen: string[] = [];
    const pool = createPool(URL, { onAcquire: (outcome) => seen.push(outcome) });
    await expect(pool.connect()).rejects.toSatisfy(isPoolAcquireTimeout);
    expect(seen).toEqual(['timeout']);
  });

  // The distinction `isPoolAcquireTimeout` exists to preserve: a backend that
  // cannot be reached is the circuit breaker's condition, not a load signal.
  // Counting it here would make an outage look like saturation.
  it('does NOT report a connection error as a timeout', async () => {
    stubConnect(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1')));
    const seen: string[] = [];
    const pool = createPool(URL, { onAcquire: (outcome) => seen.push(outcome) });
    await expect(pool.connect()).rejects.toThrow('ECONNREFUSED');
    expect(seen).toEqual([]);
  });

  it('is optional — a pool created without the hook delegates untouched', async () => {
    const client = {} as pg.PoolClient;
    stubConnect(() => Promise.resolve(client));
    const pool = createPool(URL, { config: { max: 1 } });
    expect(pool.connect).toBe(pg.Pool.prototype.connect);
    await expect(pool.connect()).resolves.toBe(client);
  });

  // An observability hook that can fail the thing it observes is worse than no
  // hook at all, so a throwing hook is swallowed on BOTH paths.
  it('still resolves the caller when the hook throws on the success path', async () => {
    const client = {} as pg.PoolClient;
    stubConnect(() => Promise.resolve(client));
    const pool = createPool(URL, {
      onAcquire: () => {
        throw new Error('hook exploded');
      },
    });
    await expect(pool.connect()).resolves.toBe(client);
  });

  it('still rejects with the ORIGINAL error when the hook throws on the failure path', async () => {
    stubConnect(() => Promise.reject(ACQUIRE_TIMEOUT()));
    const pool = createPool(URL, {
      onAcquire: () => {
        throw new Error('hook exploded');
      },
    });
    await expect(pool.connect()).rejects.toSatisfy(isPoolAcquireTimeout);
  });

  // pg exposes `connect` as both a promise and a callback API. Only the promise
  // form is instrumented; the callback form must reach pg unaltered.
  it('delegates the callback overload untouched', () => {
    const spy = stubConnect(() => undefined);
    const seen: string[] = [];
    const pool = createPool(URL, { onAcquire: (outcome) => seen.push(outcome) });
    const cb = vi.fn();
    pool.connect(cb);
    expect(spy).toHaveBeenCalledWith(cb);
    expect(seen).toEqual([]);
  });
});

describe('isPoolAcquireTimeout', () => {
  it('is true for the exact node-postgres acquire-timeout message', () => {
    expect(isPoolAcquireTimeout(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('is false for any other Error', () => {
    expect(isPoolAcquireTimeout(new Error('connection refused'))).toBe(false);
    expect(
      isPoolAcquireTimeout(new Error('terminating connection due to administrator command')),
    ).toBe(false);
  });

  it('is false for non-Error values', () => {
    expect(isPoolAcquireTimeout('timeout exceeded when trying to connect')).toBe(false);
    expect(isPoolAcquireTimeout(undefined)).toBe(false);
    expect(isPoolAcquireTimeout(null)).toBe(false);
  });
});
