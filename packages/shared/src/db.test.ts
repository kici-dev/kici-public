import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPool } from './db.js';

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
