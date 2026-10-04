import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GithubAppNameRefresher,
  refreshGithubSourceIdentity,
  refreshResolvedGithubSource,
  type RefreshableSourceStore,
} from './github-app-name-refresher.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
}));

/** What `GET /app` returns for an App holding every required event and permission. */
const COMPLETE = {
  events: ['push', 'pull_request', 'check_run', 'check_suite', 'issue_comment'],
  permissions: {
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
    checks: 'write',
    members: 'read',
    issues: 'read',
  },
};
const noInstallations = vi.fn(async () => []);

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
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'New', slug: 'new', ...COMPLETE });

    const result = await refreshGithubSourceIdentity(
      store,
      'github:1',
      fetchIdentity,
      noInstallations,
    );

    expect(result).toEqual({
      routingKey: 'github:1',
      changed: true,
      oldName: 'Old',
      newName: 'New',
      oldSlug: 'old',
      newSlug: 'new',
      missingEvents: [],
      missingPermissions: [],
      installationsPendingApproval: [],
    });
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
  });

  // fails-when: the refresh drops the gap fields, or a gap blocks the name sync.
  it('reports gaps and still syncs the name', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({
      name: 'New',
      slug: 'new',
      events: ['push', 'pull_request', 'check_run', 'check_suite'],
      permissions: {
        contents: 'read',
        metadata: 'read',
        pull_requests: 'read',
        checks: 'write',
        members: 'read',
      },
    });
    const result = await refreshGithubSourceIdentity(
      store,
      'github:1',
      fetchIdentity,
      noInstallations,
    );
    expect(result.missingEvents).toEqual(['issue_comment']);
    expect(result.missingPermissions).toEqual(['issues']);
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
  });

  // fails-when: a failed installations call is swallowed and reads as "no pending installations".
  // breaks-if-wrong: the name and slug sync still writes before the installations call fails.
  it('syncs the name, then fails the refresh when listing installations fails', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'New', slug: 'new', ...COMPLETE });
    const failingInstallations = vi.fn().mockRejectedValue(new Error('rate limited'));
    await expect(
      refreshGithubSourceIdentity(store, 'github:1', fetchIdentity, failingInstallations),
    ).rejects.toThrow(
      'github:1: name and slug synced, but listing the GitHub App installations failed: rate limited',
    );
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
  });

  it('handles config already parsed as an object (jsonb read shape)', async () => {
    // The `sources.config` column is jsonb, so the DB driver returns it as an
    // already-parsed object on read. A blind JSON.parse of that object stringifies
    // it to "[object Object]" and throws — this covers the object path.
    const store: RefreshableSourceStore & { updateSource: ReturnType<typeof vi.fn> } = {
      listSources: vi
        .fn()
        .mockResolvedValue([
          { routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' },
        ]),
      getSourceWithSecrets: vi.fn().mockResolvedValue({
        provider: 'github',
        config: { appId: '3863473' }, // object, not a JSON string
        privateKey: 'pem',
      }),
      updateSource: vi.fn().mockResolvedValue(undefined),
    };
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'New', slug: 'new', ...COMPLETE });

    const result = await refreshGithubSourceIdentity(
      store,
      'github:1',
      fetchIdentity,
      noInstallations,
    );

    expect(fetchIdentity).toHaveBeenCalledWith({ appId: '3863473', privateKey: 'pem' });
    expect(result.changed).toBe(true);
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
  });

  it('does not write when name + slug are unchanged', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Same', slug: 'same' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'Same', slug: 'same', ...COMPLETE });

    const result = await refreshGithubSourceIdentity(
      store,
      'github:1',
      fetchIdentity,
      noInstallations,
    );

    expect(result.changed).toBe(false);
    expect(store.updateSource).not.toHaveBeenCalled();
  });

  it('rejects a non-GitHub routing key', async () => {
    const store = makeStore(
      [{ routing_key: 'generic:abc', provider: 'generic', name: 'X', slug: null }],
      { 'generic:abc': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn();
    await expect(
      refreshGithubSourceIdentity(store, 'generic:abc', fetchIdentity, noInstallations),
    ).rejects.toThrow(/not a github source/i);
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it('throws a clear error for an unknown routing key', async () => {
    const store = makeStore([], {});
    await expect(
      refreshGithubSourceIdentity(store, 'github:404', vi.fn(), noInstallations),
    ).rejects.toThrow(/not found/i);
  });
});

describe('refreshResolvedGithubSource', () => {
  it('refreshes from the given row without listing sources', async () => {
    const store = makeStore(
      [{ routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' }],
      { 'github:1': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn().mockResolvedValue({ name: 'New', slug: 'new', ...COMPLETE });

    const result = await refreshResolvedGithubSource(
      store,
      { routing_key: 'github:1', provider: 'github', name: 'Old', slug: 'old' },
      fetchIdentity,
      noInstallations,
    );

    expect(result).toEqual({
      routingKey: 'github:1',
      changed: true,
      oldName: 'Old',
      newName: 'New',
      oldSlug: 'old',
      newSlug: 'new',
      missingEvents: [],
      missingPermissions: [],
      installationsPendingApproval: [],
    });
    expect(store.updateSource).toHaveBeenCalledWith('github:1', { name: 'New', slug: 'new' });
    // The whole point of this function: it never re-reads the sources table.
    expect(store.listSources).not.toHaveBeenCalled();
  });

  it('rejects a non-GitHub row', async () => {
    const store = makeStore(
      [{ routing_key: 'generic:abc', provider: 'generic', name: 'X', slug: null }],
      { 'generic:abc': { appId: '1', privateKey: 'pem' } },
    );
    const fetchIdentity = vi.fn();
    await expect(
      refreshResolvedGithubSource(
        store,
        { routing_key: 'generic:abc', provider: 'generic', name: 'X', slug: null },
        fetchIdentity,
        noInstallations,
      ),
    ).rejects.toThrow(/not a github source/i);
    expect(fetchIdentity).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ name: 'A2', slug: 'a2', ...COMPLETE }) // github:1 changed
      .mockRejectedValueOnce(new Error('GitHub down')); // github:2 throws

    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity,
      fetchInstallations: noInstallations,
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

  it('reads the sources table exactly once when refreshing N github sources (no N+1)', async () => {
    const store = makeStore(
      [
        { routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' },
        { routing_key: 'github:2', provider: 'github', name: 'B', slug: 'b' },
        { routing_key: 'github:3', provider: 'github', name: 'C', slug: 'c' },
      ],
      {
        'github:1': { appId: '1', privateKey: 'pem1' },
        'github:2': { appId: '2', privateKey: 'pem2' },
        'github:3': { appId: '3', privateKey: 'pem3' },
      },
    );
    const fetchIdentity = vi
      .fn()
      .mockResolvedValue({ name: 'unchanged', slug: 'unchanged', ...COMPLETE });

    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity,
      fetchInstallations: noInstallations,
      scanIntervalMs: 60_000,
    });

    await refresher.refresh();

    // One list for the whole batch — was 1 + N before the split.
    expect(store.listSources).toHaveBeenCalledTimes(1);
    // Each github source still gets its own identity fetch.
    expect(fetchIdentity).toHaveBeenCalledTimes(3);

    refresher.stop();
  });

  // fails-when: the interval never logs a gap, so it never reaches Loki.
  // breaks-if-wrong: a complete App logs no warning.
  it('logs one warning per App with gaps and none for a complete App', async () => {
    warnSpy.mockClear();
    const store = makeStore(
      [
        { routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' },
        { routing_key: 'github:2', provider: 'github', name: 'B', slug: 'b' },
      ],
      { 'github:1': { appId: '1', privateKey: 'p' }, 'github:2': { appId: '2', privateKey: 'p' } },
    );
    const fetchIdentity = vi.fn(async ({ appId }: { appId: string }) =>
      appId === '1'
        ? { name: 'A', slug: 'a', ...COMPLETE }
        : { name: 'B', slug: 'b', ...COMPLETE, events: ['push'] },
    );
    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity,
      fetchInstallations: noInstallations,
      scanIntervalMs: 60_000,
    });
    await refresher.refresh();
    const gapWarnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('lacks'));
    expect(gapWarnings).toHaveLength(1);
    expect(gapWarnings[0][1]).toMatchObject({ routingKey: 'github:2' });
  });

  it('runs an immediate refresh on start and clears the interval on stop', async () => {
    const store = makeStore([], {});
    const refresher = new GithubAppNameRefresher({
      sourceStore: store,
      fetchIdentity: vi.fn(),
      fetchInstallations: noInstallations,
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
