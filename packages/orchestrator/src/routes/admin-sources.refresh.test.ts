import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSourceRoutes } from './admin-sources.js';
import type { SourceStore } from '../sources/source-store.js';

function createMockSourceStore(overrides?: Partial<SourceStore>): SourceStore {
  return {
    addSource: vi.fn(),
    listSources: vi.fn().mockResolvedValue([]),
    getSource: vi.fn().mockResolvedValue(null),
    getSourceWithSecrets: vi.fn().mockResolvedValue(null),
    updateSource: vi.fn(),
    removeSource: vi.fn(),
    ...overrides,
  } as unknown as SourceStore;
}

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

const ghRow = {
  routing_key: 'github:42',
  provider: 'github',
  name: 'Old Name',
  slug: 'old-slug',
};

describe('POST /sources/:routingKey/refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates name + slug and returns the diff when GitHub reports a change', async () => {
    const updateSource = vi.fn().mockResolvedValue(undefined);
    const sourceStore = createMockSourceStore({
      listSources: vi.fn().mockResolvedValue([ghRow]),
      getSourceWithSecrets: vi.fn().mockResolvedValue({
        ...ghRow,
        config: JSON.stringify({ appId: '42' }),
        privateKey: 'pem',
      }),
      updateSource,
    });
    const fetchAppIdentity = vi
      .fn()
      .mockResolvedValue({ name: 'New Name', slug: 'new-slug', ...COMPLETE });
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity,
      fetchAppInstallations: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request('/sources/github%3A42/refresh', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      routingKey: 'github:42',
      changed: true,
      oldName: 'Old Name',
      newName: 'New Name',
      oldSlug: 'old-slug',
      newSlug: 'new-slug',
      missingEvents: [],
      missingPermissions: [],
      installationsPendingApproval: [],
    });
    expect(updateSource).toHaveBeenCalledWith('github:42', { name: 'New Name', slug: 'new-slug' });
  });

  // fails-when: the route drops the gap fields or never lists the App's installations.
  it('returns the gap fields for an App lacking issue_comment and an installation pending approval', async () => {
    const sourceStore = createMockSourceStore({
      listSources: vi.fn().mockResolvedValue([ghRow]),
      getSourceWithSecrets: vi.fn().mockResolvedValue({
        ...ghRow,
        config: JSON.stringify({ appId: '42' }),
        privateKey: 'pem',
      }),
      updateSource: vi.fn().mockResolvedValue(undefined),
    });
    const fetchAppIdentity = vi.fn().mockResolvedValue({
      name: 'Old Name',
      slug: 'old-slug',
      events: ['push', 'pull_request', 'check_run', 'check_suite'],
      permissions: COMPLETE.permissions,
    });
    const fetchAppInstallations = vi.fn().mockResolvedValue([
      {
        id: 7,
        account: 'acme',
        accountType: 'Organization',
        permissions: {
          contents: 'read',
          metadata: 'read',
          pull_requests: 'read',
          checks: 'write',
          members: 'read',
        },
      },
    ]);
    const app = createSourceRoutes({ sourceStore, fetchAppIdentity, fetchAppInstallations });

    const res = await app.request('/sources/github%3A42/refresh', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      changed: false,
      missingEvents: ['issue_comment'],
      missingPermissions: [],
      installationsPendingApproval: [
        { installationId: 7, account: 'acme', missingPermissions: ['issues'] },
      ],
    });
    expect(fetchAppInstallations).toHaveBeenCalledWith({ appId: '42', privateKey: 'pem' });
  });

  it('returns 400 for a non-GitHub source', async () => {
    const sourceStore = createMockSourceStore({
      listSources: vi
        .fn()
        .mockResolvedValue([
          { routing_key: 'generic:x', provider: 'generic', name: 'G', slug: null },
        ]),
    });
    const fetchAppIdentity = vi.fn();
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity,
      fetchAppInstallations: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request('/sources/generic%3Ax/refresh', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(fetchAppIdentity).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown routing key', async () => {
    const sourceStore = createMockSourceStore({ listSources: vi.fn().mockResolvedValue([]) });
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity: vi.fn(),
      fetchAppInstallations: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request('/sources/github%3A404/refresh', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('POST /sources/refresh-all', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refreshes every GitHub source and reports per-source errors', async () => {
    const rows = [
      { routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' },
      { routing_key: 'github:2', provider: 'github', name: 'B', slug: 'b' },
      { routing_key: 'generic:x', provider: 'generic', name: 'G', slug: null },
    ];
    const updateSource = vi.fn().mockResolvedValue(undefined);
    const sourceStore = createMockSourceStore({
      listSources: vi.fn().mockResolvedValue(rows),
      getSourceWithSecrets: vi.fn(async (rk: string) => {
        const r = rows.find((x) => x.routing_key === rk)!;
        return {
          ...r,
          config: JSON.stringify({ appId: rk.split(':')[1] }),
          privateKey: 'pem',
        } as never;
      }),
      updateSource,
    });
    const fetchAppIdentity = vi
      .fn()
      .mockResolvedValueOnce({ name: 'A2', slug: 'a2', ...COMPLETE })
      .mockRejectedValueOnce(new Error('GitHub down'));
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity,
      fetchAppInstallations: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request('/sources/refresh-all', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ routingKey: string; changed: boolean }>;
      errors: Array<{ routingKey: string }>;
    };
    // Only the two GitHub sources are attempted; generic is excluded.
    expect(fetchAppIdentity).toHaveBeenCalledTimes(2);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ routingKey: 'github:1', changed: true });
    expect(body.errors).toEqual([{ routingKey: 'github:2', error: 'GitHub down' }]);
  });

  // fails-when: refresh-all drops the gap fields from each result.
  it('carries the gap fields on each result', async () => {
    const rows = [{ routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' }];
    const sourceStore = createMockSourceStore({
      listSources: vi.fn().mockResolvedValue(rows),
      getSourceWithSecrets: vi.fn().mockResolvedValue({
        ...rows[0],
        config: JSON.stringify({ appId: '1' }),
        privateKey: 'pem',
      }),
      updateSource: vi.fn().mockResolvedValue(undefined),
    });
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity: vi
        .fn()
        .mockResolvedValue({ name: 'A', slug: 'a', ...COMPLETE, events: [] }),
      fetchAppInstallations: vi.fn().mockResolvedValue([]),
    });

    const res = await app.request('/sources/refresh-all', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).toMatchObject({
      routingKey: 'github:1',
      // check_run / check_suite are implied by the App's Checks write grant.
      missingEvents: ['push', 'pull_request', 'issue_comment'],
      missingPermissions: [],
      installationsPendingApproval: [],
    });
  });

  // fails-when: a failed installations listing aborts the whole run instead of one source.
  // breaks-if-wrong: the other sources still refresh, and the failed one's name sync still writes.
  it('reports a failed installations listing as that source error and refreshes the rest', async () => {
    const rows = [
      { routing_key: 'github:1', provider: 'github', name: 'A', slug: 'a' },
      { routing_key: 'github:2', provider: 'github', name: 'B', slug: 'b' },
    ];
    const updateSource = vi.fn().mockResolvedValue(undefined);
    const sourceStore = createMockSourceStore({
      listSources: vi.fn().mockResolvedValue(rows),
      getSourceWithSecrets: vi.fn(async (rk: string) => {
        const r = rows.find((x) => x.routing_key === rk)!;
        return {
          ...r,
          config: JSON.stringify({ appId: rk.split(':')[1] }),
          privateKey: 'pem',
        } as never;
      }),
      updateSource,
    });
    const fetchAppInstallations = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce([]);
    const app = createSourceRoutes({
      sourceStore,
      fetchAppIdentity: vi
        .fn()
        .mockResolvedValue({ name: 'Renamed', slug: 'renamed', ...COMPLETE }),
      fetchAppInstallations,
    });

    const res = await app.request('/sources/refresh-all', { method: 'POST' });

    const body = (await res.json()) as {
      results: Array<{ routingKey: string }>;
      errors: Array<{ routingKey: string; error: string }>;
    };
    expect(body.results.map((r) => r.routingKey)).toEqual(['github:2']);
    expect(body.errors).toEqual([
      {
        routingKey: 'github:1',
        error:
          'github:1: name and slug synced, but listing the GitHub App installations failed: rate limited',
      },
    ]);
    expect(updateSource).toHaveBeenCalledWith('github:1', { name: 'Renamed', slug: 'renamed' });
    expect(updateSource).toHaveBeenCalledWith('github:2', { name: 'Renamed', slug: 'renamed' });
  });
});
