import { describe, it, expect } from 'vitest';
import { COLD_BUCKET_NAMES, coldDaysToBucket, isLongerColdRetention } from './bucket.js';

describe('coldDaysToBucket', () => {
  it('forever maps to "forever"', () => {
    expect(coldDaysToBucket('forever')).toBe('forever');
  });

  it('canonical TTL values map to canonical buckets', () => {
    expect(coldDaysToBucket(30)).toBe('30d');
    expect(coldDaysToBucket(180)).toBe('180d');
    expect(coldDaysToBucket(365)).toBe('1y');
    expect(coldDaysToBucket(730)).toBe('2y');
  });

  it('rounds non-canonical TTLs DOWN (never purge sooner than the row says)', () => {
    expect(coldDaysToBucket(7)).toBe('30d');
    expect(coldDaysToBucket(31)).toBe('180d');
    expect(coldDaysToBucket(200)).toBe('1y');
    expect(coldDaysToBucket(500)).toBe('2y');
  });

  it('TTLs above 2y but not "forever" get a literal `${days}d` bucket', () => {
    expect(coldDaysToBucket(1095)).toBe('1095d');
    expect(coldDaysToBucket(1825)).toBe('1825d');
  });

  it('emits only the documented bucket names for canonical TTLs', () => {
    const seen = new Set([
      coldDaysToBucket(30),
      coldDaysToBucket(180),
      coldDaysToBucket(365),
      coldDaysToBucket(730),
      coldDaysToBucket('forever'),
    ]);
    for (const name of seen) {
      expect(COLD_BUCKET_NAMES).toContain(name);
    }
    expect(seen.size).toBe(COLD_BUCKET_NAMES.length);
  });

  it('throws on undefined / NaN / non-positive input (catches engine map gaps loudly)', () => {
    // Production regression: the engine retention helper returned undefined
    // for an unknown action string and the framework silently produced a
    // `"undefinedd"` bucket prefix that wedged the cold_store_chunks index
    // INSERT and the read-through.
    expect(() => coldDaysToBucket(undefined as never)).toThrow(/invalid retention value/);
    expect(() => coldDaysToBucket(Number.NaN as never)).toThrow(/invalid retention value/);
    expect(() => coldDaysToBucket(0 as never)).toThrow(/invalid retention value/);
    expect(() => coldDaysToBucket(-1 as never)).toThrow(/invalid retention value/);
  });
});

describe('isLongerColdRetention', () => {
  it('forever beats any number', () => {
    expect(isLongerColdRetention('forever', 30)).toBe(true);
    expect(isLongerColdRetention('forever', 730)).toBe(true);
    expect(isLongerColdRetention('forever', 1)).toBe(true);
  });

  it('forever does not beat itself', () => {
    expect(isLongerColdRetention('forever', 'forever')).toBe(false);
  });

  it('numbers compare numerically', () => {
    expect(isLongerColdRetention(180, 30)).toBe(true);
    expect(isLongerColdRetention(30, 180)).toBe(false);
    expect(isLongerColdRetention(30, 30)).toBe(false);
  });

  it('any number loses to forever', () => {
    expect(isLongerColdRetention(730, 'forever')).toBe(false);
    expect(isLongerColdRetention(1, 'forever')).toBe(false);
  });
});
