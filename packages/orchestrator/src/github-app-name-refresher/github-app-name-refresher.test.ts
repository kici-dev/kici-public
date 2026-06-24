import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GithubAppNameRefresher,
  refreshGithubSourceIdentity,
  type RefreshableSourceStore,
} from './github-app-name-refresher.js';

function makeStore(
  sources: Array<{ routing_key: string; provider: string; name: string; slug: string | null }>,
  secrets: Record<string, { appId: string; privateKey: string } | null>,
): RefreshableSourceStore & {
  updateSource: ReturnType<typeof vi.fn>;
} {
  return {
    listSources: vi.fn().mockResolvedValue(sources),
    getSourceWithSecrets: vi.fn(async (rk: string) => {
      const s = sources.find((x) => x.routing_key === rk);
      const sec = secrets[rk];
      if (!s || !sec) return null;
      const config = JSON.stringify({ appId: sec.appId });
      return { ...s, config, privateKey: sec.privateKey } as never;
    }),
    updateSource: vi.fn().mockResolvedValue(undefined),
  };
}

describe('refreshGithubSourceIdentity', () => {
  it('updates name + slug when GitHub reports a change', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'New', slug: 'new' });

    const result = await refreshGithubSourceIdentity(store, 'github:1', fetchIdentity);

    expect(result).toEqual({
      routingKey: 'github:1',
      changed: true,
      oldName: 'Old',
      newName: 'New',
      oldSlug: 'old',
      newSlug: 'new',
    });
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
  });

  it('does not write when name + slug are unchanged', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Same', slug: 'same' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'Same', slug: 'same' });

    const result = await refreshGithubSourceIdentity(store, 'github:1', fetchIdentity);

    expect(result.changed).toBe(false);
    expect(store.updateSource).not.toHaveBeenCalled();
  });

  it('rejects a non-GitHub routing key', async () => {
    const store = makeStore(
      [{ routing_key: 'generic:abc', provider: 'generic', name: 'X', slug: null }],
      { 'generic:abc': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn();
    await expect(refreshGithubSourceIdentity(store, 'generic:abc', fetchIdentity)).rejects.toThrow(
      /not a github source/i,
    );
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it('throws a clear error for an unknown routing key', async () => {
    const store = makeStore([], {});
    await expect(refreshGithubSourceIdentity(store, 'github:404', vi.fn())).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('GithubAppNameRefresher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes every GitHub source on each tick, isolating per-source errors', async () => {
    const store = makeStore(
      [
        { routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' },
        { routing_key: 'github:2', provider: 'github', name: 'B', slug: 'b' },
        { routing_key: 'generic:x', provider: 'generic', name: 'G', slug: null },
      ],
      {
        'github:1': { appId: '1', privateKey: 'pem1' },
        'github:2': { appId: '2', privateKey: 'pem2' },
        'generic:x': { appId: '0', privateKey: 'pem0' },
      },
    );
    const fetchIdentity = vi
      .fn()
      .mockResolvedValueOnce({ name: 'A2', slug: 'a2' }) // github:1 changed
      .mockRejectedValueOnce(new Error('GitHub down')); // github:2 throws

    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity,
      scanIntervalMs: 60_000,
    });

    await refresher.refresh();

    // Only the two GitHub sources are fetched (generic skipped).
    expect(fetchIdentity).toHaveBeenCalledTimes(2);
    // github:1 changed → written; github:2 threw → no write, no crash.
    expect(store.updateSource).toHaveBeenCalledTimes(1);
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'A2', slug: 'a2' });

    refresher.stop();
  });

  it('runs an immediate refresh on start and clears the interval on stop', async () => {
    const store = makeStore([], {});
    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity: vi.fn(),
      scanIntervalMs: 1_000,
    });
    await refresher.start();
    expect(store.listSources).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.listSources).toHaveBeenCalledTimes(2);

    refresher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.listSources).toHaveBeenCalledTimes(2);
  });
});
