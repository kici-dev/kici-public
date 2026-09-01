import { describe, it, expect } from 'vitest';
import { buildIsNeeded } from './dispatch-matched-workflow.js';

/**
 * The `__build__` gate. Its job is to decide whether a dispatch has to run a
 * build before its real jobs, and it answers for TWO independent caches.
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

  // The regression this gate exists to prevent. A dependency bump changes the
  // lockfile and not the workflow source, so the source stays warm and the deps
  // go cold — and while the gate read the source miss alone, that state was
  // permanent: no build ran, nothing uploaded the dep tarball, and every agent
  // installed from the registry on every job forever after.
  it('is true on a dep miss even when the source is warm', () => {
    expect(buildIsNeeded({ ...base, depHit: false })).toBe(true);
  });

  it('is true when both miss', () => {
    expect(buildIsNeeded({ ...base, sourceHit: false, depHit: false })).toBe(true);
  });

  // A miss with no hash has no cache key to write, so a build would produce an
  // artifact nothing could ever look up.
  it('ignores a miss whose hash is absent', () => {
    expect(buildIsNeeded({ ...base, sourceHit: false, contentHash: undefined })).toBe(false);
    expect(buildIsNeeded({ ...base, depHit: false, lockfileHash: undefined })).toBe(false);
  });

  // No bundle / no build coordinator / a cross-source or in-place run: there is
  // nowhere to cache into, so neither miss can justify a build.
  it('is false whenever the cache infrastructure is unavailable', () => {
    expect(
      buildIsNeeded({ ...base, cacheInfraAvailable: false, sourceHit: false, depHit: false }),
    ).toBe(false);
  });
});
