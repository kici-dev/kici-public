import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContributorCache } from './contributor-cache.js';
import type { ContributorResolver, ContributorInfo } from '@kici-dev/engine';

// ── Helpers ──────────────────────────────────────────────────────

function createMockResolver(result?: Partial<ContributorInfo>): ContributorResolver {
  return {
    provider: 'github',
    resolveContributor: vi.fn().mockResolvedValue({
      username: 'testuser',
      permission: 'write',
      isForkPR: false,
      ...result,
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ContributorCache', () => {
  let cache: ContributorCache;

  beforeEach(() => {
    cache = new ContributorCache({ ttlMs: 1000 });
  });

  it('calls resolver on cache miss', async () => {
    const resolver = createMockResolver();

    const result = await cache.resolve('github', 'owner/repo', 'testuser', resolver, {});

    expect(resolver.resolveContributor).toHaveBeenCalledOnce();
    expect(result.permission).toBe('write');
  });

  it('returns cached result on cache hit', async () => {
    const resolver = createMockResolver();

    await cache.resolve('github', 'owner/repo', 'testuser', resolver, {});
    const result = await cache.resolve('github', 'owner/repo', 'testuser', resolver, {});

    expect(resolver.resolveContributor).toHaveBeenCalledOnce();
    expect(result.permission).toBe('write');
  });

  it('uses correct cache key format', async () => {
    const resolver1 = createMockResolver({ permission: 'admin' });
    const resolver2 = createMockResolver({ permission: 'read' });

    await cache.resolve('github', 'owner/repo', 'user1', resolver1, {});
    await cache.resolve('github', 'owner/repo', 'user2', resolver2, {});

    expect(cache.size).toBe(2);
    expect(resolver1.resolveContributor).toHaveBeenCalledOnce();
    expect(resolver2.resolveContributor).toHaveBeenCalledOnce();
  });

  it('differentiates by provider', async () => {
    const resolver = createMockResolver();

    await cache.resolve('github', 'owner/repo', 'user', resolver, {});
    await cache.resolve('gitlab', 'owner/repo', 'user', resolver, {});

    expect(resolver.resolveContributor).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it('invalidates a specific entry', async () => {
    const resolver = createMockResolver();

    await cache.resolve('github', 'owner/repo', 'testuser', resolver, {});
    expect(cache.size).toBe(1);

    expect(cache.invalidate('github', 'owner/repo', 'testuser')).toBe(1);
    expect(cache.size).toBe(0);

    // Subsequent invalidate() on a missing entry returns 0.
    expect(cache.invalidate('github', 'owner/repo', 'testuser')).toBe(0);

    await cache.resolve('github', 'owner/repo', 'testuser', resolver, {});
    expect(resolver.resolveContributor).toHaveBeenCalledTimes(2);
  });

  it('clears all entries', async () => {
    const resolver = createMockResolver();

    await cache.resolve('github', 'owner/repo', 'user1', resolver, {});
    await cache.resolve('github', 'owner/repo', 'user2', resolver, {});
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('expires entries after TTL', async () => {
    // Use a very short TTL
    const shortCache = new ContributorCache({ ttlMs: 50 });
    const resolver = createMockResolver();

    await shortCache.resolve('github', 'owner/repo', 'testuser', resolver, {});
    expect(resolver.resolveContributor).toHaveBeenCalledOnce();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    await shortCache.resolve('github', 'owner/repo', 'testuser', resolver, {});
    expect(resolver.resolveContributor).toHaveBeenCalledTimes(2);
  });

  describe('invalidateByRepo', () => {
    it('deletes all entries matching {provider}:{repo}:*', async () => {
      const resolver = createMockResolver();

      // Seed: two users on owner/repo, one user on owner/other
      await cache.resolve('github', 'owner/repo', 'alice', resolver, {});
      await cache.resolve('github', 'owner/repo', 'bob', resolver, {});
      await cache.resolve('github', 'owner/other', 'alice', resolver, {});
      expect(cache.size).toBe(3);

      const count = cache.invalidateByRepo('github', 'owner/repo');

      expect(count).toBe(2);
      expect(cache.size).toBe(1);

      // The remaining entry (owner/other/alice) is still cached — no new API call
      await cache.resolve('github', 'owner/other', 'alice', resolver, {});
      expect(resolver.resolveContributor).toHaveBeenCalledTimes(3); // 3 seeds, no extra
    });

    it('does not touch entries from other providers for the same repo name', async () => {
      const resolver = createMockResolver();

      await cache.resolve('github', 'owner/repo', 'alice', resolver, {});
      await cache.resolve('gitlab', 'owner/repo', 'alice', resolver, {});
      expect(cache.size).toBe(2);

      const count = cache.invalidateByRepo('github', 'owner/repo');

      expect(count).toBe(1);
      expect(cache.size).toBe(1);
    });

    it('returns 0 when no entries match', async () => {
      const resolver = createMockResolver();

      await cache.resolve('github', 'owner/repo', 'alice', resolver, {});

      expect(cache.invalidateByRepo('github', 'owner/other')).toBe(0);
      expect(cache.size).toBe(1);
    });

    it('does not partial-match repos that share a prefix', async () => {
      const resolver = createMockResolver();

      // `owner/repo` should NOT match `owner/repo-extra` — the trailing ':'
      // in the prefix protects against that.
      await cache.resolve('github', 'owner/repo-extra', 'alice', resolver, {});
      await cache.resolve('github', 'owner/repo', 'alice', resolver, {});
      expect(cache.size).toBe(2);

      const count = cache.invalidateByRepo('github', 'owner/repo');

      expect(count).toBe(1);
      expect(cache.size).toBe(1);
    });
  });

  describe('invalidateByUserInOrg', () => {
    it('deletes all entries matching {provider}:{org}/*:{user}', async () => {
      const resolver = createMockResolver();

      // Seed: alice on two org repos, alice on a different org, bob on the same org
      await cache.resolve('github', 'acme/repo1', 'alice', resolver, {});
      await cache.resolve('github', 'acme/repo2', 'alice', resolver, {});
      await cache.resolve('github', 'other/repo1', 'alice', resolver, {});
      await cache.resolve('github', 'acme/repo1', 'bob', resolver, {});
      expect(cache.size).toBe(4);

      const count = cache.invalidateByUserInOrg('github', 'acme', 'alice');

      expect(count).toBe(2);
      expect(cache.size).toBe(2);

      // Remaining entries (other/repo1/alice, acme/repo1/bob) untouched
      await cache.resolve('github', 'other/repo1', 'alice', resolver, {});
      await cache.resolve('github', 'acme/repo1', 'bob', resolver, {});
      expect(resolver.resolveContributor).toHaveBeenCalledTimes(4); // 4 seeds, no extra
    });

    it('does not touch entries from other providers for the same org+user', async () => {
      const resolver = createMockResolver();

      await cache.resolve('github', 'acme/repo', 'alice', resolver, {});
      await cache.resolve('gitlab', 'acme/repo', 'alice', resolver, {});
      expect(cache.size).toBe(2);

      const count = cache.invalidateByUserInOrg('github', 'acme', 'alice');

      expect(count).toBe(1);
      expect(cache.size).toBe(1);
    });

    it('returns 0 when no entries match', async () => {
      const resolver = createMockResolver();

      await cache.resolve('github', 'acme/repo', 'alice', resolver, {});

      expect(cache.invalidateByUserInOrg('github', 'other', 'alice')).toBe(0);
      expect(cache.invalidateByUserInOrg('github', 'acme', 'bob')).toBe(0);
      expect(cache.size).toBe(1);
    });

    it('does not partial-match users that share a suffix', async () => {
      const resolver = createMockResolver();

      // `alice` should NOT match a user named `malice` — the leading ':'
      // in the suffix protects against that.
      await cache.resolve('github', 'acme/repo', 'malice', resolver, {});
      await cache.resolve('github', 'acme/repo', 'alice', resolver, {});
      expect(cache.size).toBe(2);

      const count = cache.invalidateByUserInOrg('github', 'acme', 'alice');

      expect(count).toBe(1);
      expect(cache.size).toBe(1);
    });

    it('does not match repos in an org whose prefix matches another org', async () => {
      const resolver = createMockResolver();

      // `acme` org prefix should NOT match `acme-extra/repo`.
      await cache.resolve('github', 'acme-extra/repo', 'alice', resolver, {});
      await cache.resolve('github', 'acme/repo', 'alice', resolver, {});
      expect(cache.size).toBe(2);

      const count = cache.invalidateByUserInOrg('github', 'acme', 'alice');

      expect(count).toBe(1);
      expect(cache.size).toBe(1);
    });
  });
});
