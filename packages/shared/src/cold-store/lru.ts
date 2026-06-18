/**
 * In-process size-bounded LRU cache.
 *
 * Used by the cold-store rehydrate path (Phase B+) to keep recently-read
 * chunks hot in memory, so that e.g. a user paginating a 90-day audit
 * window doesn't re-fetch the same S3 chunks for each page. Phase A
 * ships the primitive so Phase B's first consumer gets a debugged
 * LRU rather than having to write one.
 *
 * Size is tracked in bytes via a caller-supplied `sizeOf` function.
 * Eviction happens on `set()` when the accumulated byte count exceeds
 * `maxBytes`.
 */
export interface ChunkLruOptions<V> {
  maxBytes: number;
  sizeOf: (value: V) => number;
  onEvict?: (key: unknown, value: V) => void;
}

export class ChunkLru<K, V> {
  private readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly onEvict?: (key: K, value: V) => void;
  private readonly map: Map<K, V> = new Map();
  private readonly sizes: Map<K, number> = new Map();
  private totalBytes = 0;

  constructor(opts: ChunkLruOptions<V>) {
    this.maxBytes = opts.maxBytes;
    this.sizeOf = opts.sizeOf;
    this.onEvict = opts.onEvict as ChunkLru<K, V>['onEvict'];
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get entries(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to move to MRU position.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      const prevSize = this.sizes.get(key) ?? 0;
      this.totalBytes -= prevSize;
      this.map.delete(key);
      this.sizes.delete(key);
    }
    const size = this.sizeOf(value);
    this.map.set(key, value);
    this.sizes.set(key, size);
    this.totalBytes += size;

    while (this.totalBytes > this.maxBytes && this.map.size > 0) {
      const firstKey = this.map.keys().next().value as K;
      const evicted = this.map.get(firstKey) as V;
      const evictedSize = this.sizes.get(firstKey) ?? 0;
      this.map.delete(firstKey);
      this.sizes.delete(firstKey);
      this.totalBytes -= evictedSize;
      this.onEvict?.(firstKey, evicted);
    }
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.map.entries()) {
        this.onEvict(key, value);
      }
    }
    this.map.clear();
    this.sizes.clear();
    this.totalBytes = 0;
  }
}
