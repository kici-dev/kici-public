import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSourceRoutes, type RedeliverDeliveries } from './admin-sources.js';
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

const githubSourceWithSecrets = {
  routing_key: 'github:42',
  provider: 'github',
  name: 'App',
  config: JSON.stringify({ appId: '42' }),
  privateKey: 'pem',
};

const WINDOW = { since: '2026-09-01T00:00:00Z', until: '2026-09-02T00:00:00Z' };

/** Mount the source routes behind the routing-key scope the auth middleware sets. */
function withTokenRoutingKey(inner: ReturnType<typeof createSourceRoutes>, routingKey: string) {
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('routingKey' as never, routingKey as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

function post(app: { request: Hono['request'] }, body: unknown, key = 'github%3A42') {
  return app.request(`/sources/${key}/redeliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stubRedeliver(): RedeliverDeliveries {
  return vi.fn(async (_app, opts) => ({
    since: opts.since.toISOString(),
    until: opts.until.toISOString(),
    dryRun: opts.dryRun === true,
    matched: 1,
    truncated: false,
    redelivered: opts.dryRun ? 0 : 1,
    failed: 0,
    results: [
      {
        deliveryId: 7,
        guid: 'g-7',
        deliveredAt: '2026-09-01T12:00:00Z',
        event: 'push',
        action: null,
        originalStatusCode: 502,
        outcome: opts.dryRun ? ('would-redeliver' as const) : ('redelivered' as const),
      },
    ],
  }));
}

describe('POST /sources/:routingKey/redeliver', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replays the window with the source App credentials and returns the tally', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const redeliverDeliveries = stubRedeliver();
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      routingKey: 'github:42',
      matched: 1,
      redelivered: 1,
      failed: 0,
      dryRun: false,
    });
    expect(redeliverDeliveries).toHaveBeenCalledWith(
      { appId: '42', privateKey: 'pem' },
      { since: new Date(WINDOW.since), until: new Date(WINDOW.until), dryRun: undefined },
    );
  });

  it('threads dryRun through without sending anything', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const redeliverDeliveries = stubRedeliver();
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries });

    const res = await post(app, { ...WINDOW, dryRun: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, redelivered: 0 });
    expect(redeliverDeliveries).toHaveBeenCalledWith(expect.anything(), {
      since: new Date(WINDOW.since),
      until: new Date(WINDOW.until),
      dryRun: true,
    });
  });

  it('accepts a timestamp with a non-UTC offset', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries: stubRedeliver() });

    const res = await post(app, {
      since: '2026-09-01T02:00:00+02:00',
      until: '2026-09-02T02:00:00+02:00',
    });

    expect(res.status).toBe(200);
  });

  it('returns 400 when a bound is missing or unparseable', async () => {
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore(),
      redeliverDeliveries: stubRedeliver(),
    });

    for (const body of [{}, { since: 'yesterday', until: WINDOW.until }, { since: WINDOW.since }]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('ISO-8601'),
      });
    }
  });

  it('returns 400 when since is not earlier than until', async () => {
    const redeliverDeliveries = stubRedeliver();
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore(),
      redeliverDeliveries,
    });

    const res = await post(app, { since: WINDOW.until, until: WINDOW.since });

    expect(res.status).toBe(400);
    expect(redeliverDeliveries).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown source', async () => {
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore(),
      redeliverDeliveries: stubRedeliver(),
    });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-GitHub source', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi
        .fn()
        .mockResolvedValue({ ...githubSourceWithSecrets, provider: 'gitlab' }),
    });
    const redeliverDeliveries = stubRedeliver();
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('not a GitHub source'),
    });
    expect(redeliverDeliveries).not.toHaveBeenCalled();
  });

  it('returns 400 when the stored config carries no App id', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi
        .fn()
        .mockResolvedValue({ ...githubSourceWithSecrets, config: JSON.stringify({}) }),
    });
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries: stubRedeliver() });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('App id'),
    });
  });

  it('reads an already-parsed jsonb config object', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi
        .fn()
        .mockResolvedValue({ ...githubSourceWithSecrets, config: { appId: '99' } }),
    });
    const redeliverDeliveries = stubRedeliver();
    const app = createSourceRoutes({ sourceStore, redeliverDeliveries });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(200);
    expect(redeliverDeliveries).toHaveBeenCalledWith(
      { appId: '99', privateKey: 'pem' },
      expect.anything(),
    );
  });

  it('allows a routing-key-scoped token targeting its own source', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const app = withTokenRoutingKey(
      createSourceRoutes({ sourceStore, redeliverDeliveries: stubRedeliver() }),
      'github:42',
    );

    expect((await post(app, WINDOW)).status).toBe(200);
  });

  it('refuses a routing-key-scoped token targeting a different source', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const redeliverDeliveries = stubRedeliver();
    const app = withTokenRoutingKey(
      createSourceRoutes({ sourceStore, redeliverDeliveries }),
      'github:other',
    );

    const res = await post(app, WINDOW);

    expect(res.status).toBe(403);
    expect(redeliverDeliveries).not.toHaveBeenCalled();
  });

  it('returns 500 when the replay itself throws', async () => {
    const sourceStore = createMockSourceStore({
      getSourceWithSecrets: vi.fn().mockResolvedValue(githubSourceWithSecrets),
    });
    const app = createSourceRoutes({
      sourceStore,
      redeliverDeliveries: vi.fn().mockRejectedValue(new Error('github unreachable')),
    });

    const res = await post(app, WINDOW);

    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('github unreachable'),
    });
  });
});
