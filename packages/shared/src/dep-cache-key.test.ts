import { describe, expect, it } from 'vitest';
import { depCacheKeyOf } from './dep-cache-key.js';

describe('depCacheKeyOf', () => {
  it('reads both fields of a lock file that records them', () => {
    expect(depCacheKeyOf({ lockfileHash: 'h', siblingsDigest: 'd' })).toEqual({
      lockfileHash: 'h',
      siblingsDigest: 'd',
    });
  });

  it('reads a missing, empty or non-string field as null', () => {
    // fails-when: a malformed operator-supplied lock file stores a non-string key
    expect(depCacheKeyOf({})).toEqual({ lockfileHash: null, siblingsDigest: null });
    expect(depCacheKeyOf({ lockfileHash: '', siblingsDigest: 42 })).toEqual({
      lockfileHash: null,
      siblingsDigest: null,
    });
  });
});
