import { describe, expect, it, vi } from 'vitest';
import { ChunkLru } from './lru.js';

describe('ChunkLru', () => {
  it('stores values up to maxBytes', () => {
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 100,
      sizeOf: (b) => b.byteLength,
    });
    lru.set('a', Buffer.alloc(30));
    lru.set('b', Buffer.alloc(30));
    expect(lru.bytes).toBe(60);
    expect(lru.entries).toBe(2);
    expect(lru.get('a')).toBeDefined();
    expect(lru.get('b')).toBeDefined();
  });

  it('evicts least-recently-used entries on overflow', () => {
    const evicted: string[] = [];
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 100,
      sizeOf: (b) => b.byteLength,
      onEvict: (k) => evicted.push(k as string),
    });
    lru.set('a', Buffer.alloc(40));
    lru.set('b', Buffer.alloc(40));
    // Touch `a` so `b` becomes LRU
    lru.get('a');
    lru.set('c', Buffer.alloc(40));
    expect(evicted).toEqual(['b']);
    expect(lru.get('a')).toBeDefined();
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBeDefined();
  });

  it('overwrites an existing key and adjusts bytes', () => {
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 1000,
      sizeOf: (b) => b.byteLength,
    });
    lru.set('a', Buffer.alloc(50));
    lru.set('a', Buffer.alloc(70));
    expect(lru.bytes).toBe(70);
    expect(lru.entries).toBe(1);
  });

  it('evicts multiple entries if the new one is large', () => {
    const evicted: string[] = [];
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 100,
      sizeOf: (b) => b.byteLength,
      onEvict: (k) => evicted.push(k as string),
    });
    lru.set('a', Buffer.alloc(30));
    lru.set('b', Buffer.alloc(30));
    lru.set('c', Buffer.alloc(30));
    lru.set('big', Buffer.alloc(90));
    expect(evicted).toEqual(['a', 'b', 'c']);
    expect(lru.entries).toBe(1);
  });

  it('clear calls onEvict for all remaining entries', () => {
    const onEvict = vi.fn();
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 1000,
      sizeOf: (b) => b.byteLength,
      onEvict,
    });
    lru.set('a', Buffer.alloc(10));
    lru.set('b', Buffer.alloc(10));
    lru.clear();
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(lru.bytes).toBe(0);
    expect(lru.entries).toBe(0);
  });
});
