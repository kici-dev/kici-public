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
      getSourceWithSecrets: vi
        .fn()
        .mockResolvedValue({
          ...ghRow,
          config: JSON.stringify({ appId: '42' }),
          privateKey: 'pem',
        }),
      updateSource,
    });
    const fetchAppIdentity = vi.fn().mockResolvedValue({ name: 'New Name', slug: 'new-slug' });
    const app = createSourceRoutes({ sourceStore, fetchAppIdentity });

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
    });
    expect(updateSource).toHaveBeenCalledWith('github:42', { name: 'New Name', slug: 'new-slug' });
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
    const app = createSourceRoutes({ sourceStore, fetchAppIdentity });

    const res = await app.request('/sources/generic%3Ax/refresh', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(fetchAppIdentity).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown routing key', async () => {
    const sourceStore = createMockSourceStore({ listSources: vi.fn().mockResolvedValue([]) });
    const app = createSourceRoutes({ sourceStore, fetchAppIdentity: vi.fn() });

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
        return { ...r, config: JSON.stringify({ appId: rk.split(':')[1] }), privateKey: 'pem' };
      }),
      updateSource,
    });
    const fetchAppIdentity = vi
      .fn()
      .mockResolvedValueOnce({ name: 'A2', slug: 'a2' })
      .mockRejectedValueOnce(new Error('GitHub down'));
    const app = createSourceRoutes({ sourceStore, fetchAppIdentity });

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
});
