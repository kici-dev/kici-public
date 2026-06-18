import { describe, it, expect } from 'vitest';
import { CacheSpecSchema, normalizeCacheSpecs } from './cache-types.js';
import { type CacheApi } from './cache-types.js';

describe('CacheSpec', () => {
  it('accepts a minimal spec', () => {
    const parsed = CacheSpecSchema.parse({ key: 'k1', paths: ['./dist'] });
    expect(parsed.key).toBe('k1');
    expect(parsed.restoreKeys).toBeUndefined();
  });

  it('accepts restoreKeys', () => {
    const parsed = CacheSpecSchema.parse({
      key: 'node-deps-abc',
      paths: ['~/.npm'],
      restoreKeys: ['node-deps-', 'node-'],
    });
    expect(parsed.restoreKeys).toEqual(['node-deps-', 'node-']);
  });

  it('rejects an empty key', () => {
    expect(() => CacheSpecSchema.parse({ key: '', paths: ['x'] })).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => CacheSpecSchema.parse({ key: 'k', paths: [] })).toThrow();
  });

  it('normalizes a single spec and an array to an array', () => {
    expect(normalizeCacheSpecs({ key: 'k', paths: ['p'] })).toHaveLength(1);
    expect(
      normalizeCacheSpecs([
        { key: 'a', paths: ['p'] },
        { key: 'b', paths: ['q'] },
      ]),
    ).toHaveLength(2);
    expect(normalizeCacheSpecs(undefined)).toEqual([]);
  });
});

describe('CacheApi shape', () => {
  it('exposes restore returning hit + matchedKey and save returning void', async () => {
    const fake: CacheApi = {
      restore: async (spec) => ({ hit: spec.key === 'present', matchedKey: 'present' }),
      save: async () => {},
    };
    const r = await fake.restore({ key: 'present', paths: ['p'] });
    expect(r.hit).toBe(true);
    expect(r.matchedKey).toBe('present');
    await expect(fake.save({ key: 'k', paths: ['p'] })).resolves.toBeUndefined();
  });
});
