import { describe, it, expect } from 'vitest';
import { buildIsNeeded } from './dispatch-matched-workflow.js';

/**
 * The `__build__` gate: whether a dispatch runs a build before its real jobs,
 * answered for TWO independent caches.
 */
describe('buildIsNeeded', () => {
  const base = {
    cacheInfraAvailable: true,
    sourceHit: true,
    contentHash: 'c0ffee',
    depHit: true,
    lockfileHash: 'deadbeef',
  };

  it('is false when both caches are warm', () => {
    expect(buildIsNeeded(base)).toBe(false);
  });

  it('is true on a source miss', () => {
    expect(buildIsNeeded({ ...base, sourceHit: false })).toBe(true);
  });

  // A dependency bump leaves the source warm and the deps cold; a gate reading
  // only the source miss never builds, so no dep tarball is ever uploaded and
  // every agent installs from the registry on every job.
  it('is true on a dep miss even when the source is warm', () => {
    expect(buildIsNeeded({ ...base, depHit: false })).toBe(true);
  });

  it('is true when both miss', () => {
    expect(buildIsNeeded({ ...base, sourceHit: false, depHit: false })).toBe(true);
  });

  // A miss with no hash has no cache key, so a build's artifact could never be
  // looked up.
  it('ignores a miss whose hash is absent', () => {
    expect(buildIsNeeded({ ...base, sourceHit: false, contentHash: undefined })).toBe(false);
    expect(buildIsNeeded({ ...base, depHit: false, lockfileHash: undefined })).toBe(false);
  });

  // No bundle / build coordinator, or a cross-source or in-place run: nowhere to
  // cache into, so no miss justifies a build.
  it('is false whenever the cache infrastructure is unavailable', () => {
    expect(
      buildIsNeeded({ ...base, cacheInfraAvailable: false, sourceHit: false, depHit: false }),
    ).toBe(false);
  });
});
