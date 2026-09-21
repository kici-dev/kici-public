import { describe, it, expect } from 'vitest';
import { isLegacyKey, legacyDepTarballKeys, classifyLegacyKeys } from './legacy-prefixes.js';
import { userCacheEntryKey } from './user-cache.js';
import { sourceTarballKey, sourcePointerKey } from './source-cache.js';
import { depTarballKey, depPointerKey } from './dep-cache.js';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);

// Every "current" key below is built by the writer that produces it, so the
// table cannot drift from the layout the orchestrator actually writes.
const CURRENT_KEYS: readonly string[] = [
  userCacheEntryKey({ org: 'org-1', repo: 'owner/repo', scope: 'shared' }, 'node-deps-v1'),
  `${userCacheEntryKey({ org: 'org-1', repo: 'owner/repo', scope: 'shared' }, 'node-deps-v1')}.hash`,
  `${userCacheEntryKey({ org: 'org-1', repo: 'owner/repo', scope: 'shared' }, 'node-deps-v1')}.size`,
  userCacheEntryKey(
    { org: 'org-1', repo: 'owner/repo', scope: 'isolated', runId: 'run-7' },
    'Build',
  ),
  // An in-flight upload: not a committed entry, and never a purge target.
  'cache/org-1/owner_repo/shared/.tmp-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.tar.gz',
  sourceTarballKey('org-1', HEX64_A),
  sourcePointerKey('org-1', HEX64_B),
  depTarballKey(HEX64_A, 'linux', 'x64'),
  depPointerKey(HEX64_B, 'linux', 'x64'),
  depPointerKey(HEX64_B, 'linux', 'x64', 'd'.repeat(16)),
];

// The retired layouts of the user, source, and dependency caches — the shapes
// `kici-admin cache purge-legacy` exists to delete.
const LEGACY_KEYS: readonly string[] = [
  'cache/org-1/owner_repo/shared/node-deps-v1.tar.gz',
  'cache/org-1/owner_repo/shared/node-deps-v1.tar.gz.hash',
  'cache/org-1/owner_repo/shared/node-deps-v1.tar.gz.size',
  'cache/org-1/owner_repo/iso/run-7/Build.tar.gz',
  `source/${HEX64_A}.tar.gz`,
];

describe('isLegacyKey', () => {
  // fails-when: a shape the current writers produce is classified legacy — the
  // purge would then delete a live object.
  it.each(CURRENT_KEYS)('is false for the current-layout key %s', (key) => {
    expect(isLegacyKey(key)).toBe(false);
  });

  // fails-when: a retired shape is not recognised, so the purge leaves it behind.
  it.each(LEGACY_KEYS)('is true for the retired-layout key %s', (key) => {
    expect(isLegacyKey(key)).toBe(true);
  });

  // fails-when: the predicate keys on the prefix alone — a `deps/` tarball is
  // the same shape in both layouts, so by shape it is never legacy.
  it('is false for every deps/ key, whose retired and current shapes coincide', () => {
    expect(isLegacyKey(depTarballKey(HEX64_A, 'linux', 'x64'))).toBe(false);
    expect(isLegacyKey(`deps/linux-x64/${HEX64_B}.hash`)).toBe(false);
  });

  it('is false for keys outside the cache prefixes', () => {
    expect(isLegacyKey('provenance/run/job/abc.kici.json')).toBe(false);
    expect(isLegacyKey('agent-packages/0.9.0/kici-agent-linux-x64.tar.gz')).toBe(false);
    expect(isLegacyKey('.kici-cluster-id')).toBe(false);
  });
});

describe('legacyDepTarballKeys', () => {
  // A retired pair: the tarball is named by the lockfile hash and its sidecar
  // shares the stem. A current pair never does — the tarball is named by its
  // own content hash and the pointer by the lockfile hash.
  it('returns a tarball whose stem also carries a .hash sidecar', () => {
    const legacyTarball = `deps/linux-x64/${HEX64_B}.tar.gz`;
    const legacySidecar = `deps/linux-x64/${HEX64_B}.hash`;
    expect(legacyDepTarballKeys([legacySidecar, legacyTarball])).toEqual([legacyTarball]);
  });

  // fails-when: a content-addressed tarball with a live pointer beside it is
  // returned — that is exactly the pair the current writer produces.
  it('returns nothing for a current tarball + pointer pair', () => {
    const keys = [
      depTarballKey(HEX64_A, 'linux', 'x64'),
      depPointerKey(HEX64_B, 'linux', 'x64'),
      depPointerKey(HEX64_C, 'linux', 'x64', 'd'.repeat(16)),
    ];
    expect(legacyDepTarballKeys(keys)).toEqual([]);
  });

  // fails-when: the stem match ignores the platform segment, pairing a tarball
  // on one platform with a sidecar on another.
  it('pairs a tarball only with a sidecar under the same platform-arch segment', () => {
    expect(
      legacyDepTarballKeys([
        `deps/linux-x64/${HEX64_B}.tar.gz`,
        `deps/linux-arm64/${HEX64_B}.hash`,
      ]),
    ).toEqual([]);
  });

  it('never returns the .hash object itself', () => {
    const legacySidecar = `deps/linux-x64/${HEX64_B}.hash`;
    expect(legacyDepTarballKeys([legacySidecar, `deps/linux-x64/${HEX64_B}.tar.gz`])).not.toContain(
      legacySidecar,
    );
  });
});

describe('classifyLegacyKeys', () => {
  it('groups every legacy key under its prefix and leaves current keys out', () => {
    const legacyDep = `deps/linux-x64/${HEX64_B}.tar.gz`;
    const listing = [...CURRENT_KEYS, ...LEGACY_KEYS, `deps/linux-x64/${HEX64_B}.hash`, legacyDep];
    const byPrefix = classifyLegacyKeys(listing);
    expect(byPrefix.get('cache/')).toEqual(LEGACY_KEYS.filter((k) => k.startsWith('cache/')));
    expect(byPrefix.get('source/')).toEqual([`source/${HEX64_A}.tar.gz`]);
    expect(byPrefix.get('deps/')).toEqual([legacyDep]);
    // fails-when: any current key lands in a bucket.
    for (const keys of byPrefix.values()) {
      for (const key of keys) expect(CURRENT_KEYS).not.toContain(key);
    }
  });
});
