import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayBufferRegistry, type RelayStartMeta } from './relay-buffer.js';

const META: RelayStartMeta = {
  routingKey: 'github:1',
  deliveryId: 'del-1',
  event: 'push',
  action: null,
  signatureHeaderName: 'x-hub-signature-256',
  signatureHeader: 'sha256=abc',
  clientIp: '10.0.0.1',
  headers: {},
  totalSize: 0, // overridden per test
  chunkCount: 0, // overridden per test
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('RelayBufferRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a single-chunk stream in one chunk', () => {
    const reg = new RelayBufferRegistry();
    const meta = { ...META, totalSize: 5, chunkCount: 1 };
    expect(reg.start('m1', meta)).toEqual({ status: 'started' });

    const r = reg.chunk('m1', 0, b64('hello'), true);
    expect(r.status).toBe('completed');
    if (r.status === 'completed') {
      expect(r.body.toString('utf8')).toBe('hello');
      expect(r.meta).toEqual(meta);
    }
    expect(reg.size).toBe(0);
  });

  it('reassembles a multi-chunk stream in order', () => {
    const reg = new RelayBufferRegistry();
    const meta = { ...META, totalSize: 6, chunkCount: 3 };
    reg.start('m2', meta);

    expect(reg.chunk('m2', 0, b64('he'), false)).toEqual({ status: 'pending' });
    expect(reg.chunk('m2', 1, b64('ll'), false)).toEqual({ status: 'pending' });
    const r = reg.chunk('m2', 2, b64('o!'), true);
    expect(r.status).toBe('completed');
    if (r.status === 'completed') {
      expect(r.body.toString('utf8')).toBe('hello!');
    }
  });

  it('rejects out-of-order chunks and drops the buffer', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m3', { ...META, totalSize: 4, chunkCount: 2 });

    reg.chunk('m3', 0, b64('aa'), false);
    const r = reg.chunk('m3', 5, b64('bb'), true);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/out-of-order/);
    }
    expect(reg.size).toBe(0); // buffer dropped on error
  });

  it('rejects a chunk with sequence >= declared chunkCount', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m-over', { ...META, totalSize: 2, chunkCount: 1 });

    reg.chunk('m-over', 0, b64('aa'), false);
    const r = reg.chunk('m-over', 1, b64('bb'), true);
    // expected sequence is 1 (was 0, then incremented), but chunkCount=1 so 1 >= 1 fails.
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/>= declared chunkCount/);
    }
  });

  it('rejects when assembled bytes exceed declared totalSize', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m4', { ...META, totalSize: 4, chunkCount: 2 });
    reg.chunk('m4', 0, b64('aa'), false); // 2 bytes
    const r = reg.chunk('m4', 1, b64('bbbb'), true); // would be 6 > 4
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/exceeds declared totalSize/);
    }
  });

  it('rejects final flag if assembled bytes != declared totalSize', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m5', { ...META, totalSize: 10, chunkCount: 2 });
    reg.chunk('m5', 0, b64('aa'), false); // 2 bytes
    const r = reg.chunk('m5', 1, b64('bb'), true); // total 4, but declared 10
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/!= declared totalSize/);
    }
  });

  it('rejects final flag arriving before all chunks', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m6', { ...META, totalSize: 2, chunkCount: 5 });
    const r = reg.chunk('m6', 0, b64('hi'), true); // claims final at seq 0 but chunkCount=5
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/only 1\/5 chunks received/);
    }
  });

  it('rejects a chunk for a missing messageId', () => {
    const reg = new RelayBufferRegistry();
    const r = reg.chunk('never-started', 0, b64('x'), true);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/no in-flight buffer/);
    }
  });

  it('rejects duplicate start for same messageId', () => {
    const reg = new RelayBufferRegistry();
    const meta = { ...META, totalSize: 1, chunkCount: 1 };
    expect(reg.start('m-dup', meta)).toEqual({ status: 'started' });
    const r = reg.start('m-dup', meta);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/duplicate webhook.relay.start/);
    }
  });

  it('rejects start with totalSize over the 25 MiB cap', () => {
    const reg = new RelayBufferRegistry();
    const r = reg.start('m-huge', {
      ...META,
      totalSize: 26 * 1024 * 1024,
      chunkCount: 1,
    });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toMatch(/exceeds max/);
    }
  });

  it('rejects start with chunkCount = 0', () => {
    const reg = new RelayBufferRegistry();
    const r = reg.start('m-zero', { ...META, totalSize: 0, chunkCount: 0 });
    expect(r.status).toBe('error');
  });

  it('drops an abandoned buffer after TTL', () => {
    const reg = new RelayBufferRegistry({ bufferTtlMs: 1_000 });
    reg.start('m-ttl', { ...META, totalSize: 4, chunkCount: 2 });
    reg.chunk('m-ttl', 0, b64('aa'), false);
    expect(reg.size).toBe(1);
    vi.advanceTimersByTime(1_500);
    expect(reg.size).toBe(0);
  });

  it('clear() drops every in-flight buffer', () => {
    const reg = new RelayBufferRegistry();
    reg.start('a', { ...META, totalSize: 1, chunkCount: 1 });
    reg.start('b', { ...META, totalSize: 1, chunkCount: 1 });
    expect(reg.size).toBe(2);
    reg.clear();
    expect(reg.size).toBe(0);
  });

  it('handles an empty body (totalSize 0, single empty chunk with final=true)', () => {
    const reg = new RelayBufferRegistry();
    reg.start('m-empty', { ...META, totalSize: 0, chunkCount: 1 });
    const r = reg.chunk('m-empty', 0, '', true);
    expect(r.status).toBe('completed');
    if (r.status === 'completed') {
      expect(r.body.length).toBe(0);
    }
  });
});
