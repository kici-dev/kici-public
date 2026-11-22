import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSourceRoutes } from './admin-sources.js';
import { Hono } from 'hono';
import { DuplicateSourceError, type SourceStore } from '../sources/source-store.js';
import { validateGitHubSource } from '../sources/source-validator.js';

vi.mock('../sources/source-validator.js', () => ({
  validateGitHubSource: vi.fn().mockResolvedValue({ valid: true, appName: 'Test' }),
}));

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

describe('admin source routes', () => {
  describe('PATCH /sources/:routingKey', () => {
    it('returns 404 when source does not exist', async () => {
      const sourceStore = createMockSourceStore();
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A999', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Source not found');
    });

    it('returns 200 when source exists', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'Updated',
        routing_key: 'github:42',
        config: JSON.stringify({ appId: '42' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const sourceStore = createMockSourceStore({
        getSource: vi.fn().mockResolvedValue(source),
        updateSource: vi.fn().mockResolvedValue(source),
      });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A42', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
    });

    it('forwards customerId to the source store', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'Updated',
        routing_key: 'github:42',
        customer_id: 'org-xyz',
        config: JSON.stringify({ appId: '42' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const updateSource = vi.fn().mockResolvedValue(source);
      const sourceStore = createMockSourceStore({
        getSource: vi.fn().mockResolvedValue(source),
        updateSource,
      });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A42', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: 'org-xyz' }),
      });

      expect(res.status).toBe(200);
      expect(updateSource).toHaveBeenCalledWith(
        'github:42',
        expect.objectContaining({ customerId: 'org-xyz' }),
      );
    });
  });

  describe('GET /sources/github-webhook-url (manifest pre-flight)', () => {
    it('returns the resolved webhook url', async () => {
      const sourceStore = createMockSourceStore();
      const app = createSourceRoutes({
        sourceStore,
        resolveGithubWebhookUrl: vi
          .fn()
          .mockResolvedValue({ webhookUrl: 'https://api.kici.dev/webhook/org_x/github' }),
      });

      const res = await app.request('/sources/github-webhook-url');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { webhookUrl: string | null };
      expect(body.webhookUrl).toBe('https://api.kici.dev/webhook/org_x/github');
    });

    it('returns null + note when no public base is resolvable', async () => {
      const sourceStore = createMockSourceStore();
      const app = createSourceRoutes({
        sourceStore,
        resolveGithubWebhookUrl: vi
          .fn()
          .mockResolvedValue({ webhookUrl: null, webhookNote: 'platform-no-public-url' }),
      });

      const res = await app.request('/sources/github-webhook-url');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { webhookUrl: string | null; webhookNote?: string };
      expect(body.webhookUrl).toBeNull();
      expect(body.webhookNote).toBe('platform-no-public-url');
    });

    it('returns null + note when no resolver is wired', async () => {
      const sourceStore = createMockSourceStore();
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github-webhook-url');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { webhookUrl: string | null; webhookNote?: string };
      expect(body.webhookUrl).toBeNull();
      expect(body.webhookNote).toBe('resolver-unavailable');
    });

    // fails-when: the pre-flight drops the Platform's page, so kici-admin prints the
    //   default page for a Platform that serves its own
    it('reports the Platform manifest page when the resolver returns one', async () => {
      const app = createSourceRoutes({
        sourceStore: createMockSourceStore(),
        resolveGithubWebhookUrl: vi
          .fn()
          .mockResolvedValue({ webhookUrl: 'https://kici.corp.example/webhook/org_x/github' }),
        resolveGithubManifestCallbackUrl: () =>
          'https://kici.corp.example/github/manifest-callback',
      });

      const body = (await (await app.request('/sources/github-webhook-url')).json()) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({
        webhookUrl: 'https://kici.corp.example/webhook/org_x/github',
        manifestCallbackUrl: 'https://kici.corp.example/github/manifest-callback',
      });
    });

    it('reports the page even when the webhook URL cannot be resolved', async () => {
      const app = createSourceRoutes({
        sourceStore: createMockSourceStore(),
        resolveGithubManifestCallbackUrl: () =>
          'https://kici.corp.example/github/manifest-callback',
      });

      const body = (await (await app.request('/sources/github-webhook-url')).json()) as Record<
        string,
        unknown
      >;
      expect(body.webhookUrl).toBeNull();
      expect(body.manifestCallbackUrl).toBe('https://kici.corp.example/github/manifest-callback');
    });

    // breaks-if-wrong: an independent orchestrator's pre-flight is unchanged
    it.each([
      ['returns null', () => null],
      ['is absent', undefined],
    ])('omits manifestCallbackUrl when the resolver %s', async (_label, resolver) => {
      const app = createSourceRoutes({
        sourceStore: createMockSourceStore(),
        resolveGithubWebhookUrl: vi
          .fn()
          .mockResolvedValue({ webhookUrl: 'https://ci.example.com/webhook/org_x/github' }),
        ...(resolver && { resolveGithubManifestCallbackUrl: resolver }),
      });

      const body = (await (await app.request('/sources/github-webhook-url')).json()) as Record<
        string,
        unknown
      >;
      expect(body).toEqual({ webhookUrl: 'https://ci.example.com/webhook/org_x/github' });
    });
  });

  describe('POST /sources/refresh-all', () => {
    it('refreshes every github source with a single sources-table read', async () => {
      const rows = [
        { id: 's1', provider: 'github', name: 'A', slug: 'a', routing_key: 'github:1' },
        { id: 's2', provider: 'github', name: 'B', slug: 'b', routing_key: 'github:2' },
        { id: 's3', provider: 'github', name: 'C', slug: 'c', routing_key: 'github:3' },
        { id: 'g1', provider: 'generic', name: 'G', slug: null, routing_key: 'generic:x' },
      ];
      const listSources = vi.fn().mockResolvedValue(rows);
      const sourceStore = createMockSourceStore({
        listSources,
        getSourceWithSecrets: vi.fn().mockResolvedValue({
          provider: 'github',
          config: JSON.stringify({ appId: '1' }),
          privateKey: 'pem',
        }),
        updateSource: vi.fn().mockResolvedValue(undefined),
      });
      const fetchAppIdentity = vi.fn().mockResolvedValue({
        name: 'unchanged',
        slug: 'unchanged',
        events: [],
        permissions: {},
      });
      const app = createSourceRoutes({
        sourceStore,
        fetchAppIdentity,
        fetchAppInstallations: vi.fn().mockResolvedValue([]),
      });

      const res = await app.request('/sources/refresh-all', { method: 'POST' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ routingKey: string }>;
        errors: Array<{ routingKey: string }>;
      };
      // Only the three github sources refresh; the generic one is filtered out.
      expect(body.results).toHaveLength(3);
      expect(body.errors).toHaveLength(0);
      expect(fetchAppIdentity).toHaveBeenCalledTimes(3);
      // The whole batch reads the sources table exactly once, not 1 + N.
      expect(listSources).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /sources', () => {
    it('includes customerId in the list response', async () => {
      const sourceStore = createMockSourceStore({
        listSources: vi.fn().mockResolvedValue([
          {
            id: 's1',
            provider: 'github',
            name: 'Main',
            routing_key: 'github:42',
            customer_id: 'org-main',
            config: JSON.stringify({ appId: '42' }),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ]),
      });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sources: Array<{ routingKey: string; customerId: string }>;
      };
      expect(body.sources[0].routingKey).toBe('github:42');
      expect(body.sources[0].customerId).toBe('org-main');
    });
  });

  // A routing key is an already-decoded Hono path param. A second decode
  // throws a URIError (500) on a stray `%`, or collapses a `%NN`-looking key
  // onto a DIFFERENT source (wrong-source read/mutation). These routes do no
  // charset validation on routing keys.
  describe('source :routingKey path param is decoded exactly once (no double-decode)', () => {
    it('PATCH forwards a literal-% routing key verbatim (was a 500)', async () => {
      const getSource = vi.fn().mockResolvedValue(null);
      const sourceStore = createMockSourceStore({ getSource });
      const app = createSourceRoutes({ sourceStore });

      // URL segment `github%3A100%25done` decodes (once, by Hono) to the
      // literal `github:100%done`.
      const res = await app.request('/sources/github%3A100%25done', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
      expect(getSource).toHaveBeenCalledWith('github:100%done');
    });

    it('GET webhook-secret forwards a literal-% routing key verbatim', async () => {
      const getSourceWithSecrets = vi.fn().mockResolvedValue(null);
      const sourceStore = createMockSourceStore({ getSourceWithSecrets });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A100%25done/webhook-secret');

      expect(res.status).toBe(404);
      expect(getSourceWithSecrets).toHaveBeenCalledWith('github:100%done');
    });

    it('DELETE forwards a literal-% routing key verbatim', async () => {
      const removeSource = vi.fn().mockResolvedValue(undefined);
      const sourceStore = createMockSourceStore({ removeSource });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A100%25done', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(removeSource).toHaveBeenCalledWith('github:100%done');
    });

    it('does not collapse a %NN-looking routing key onto a different source', async () => {
      const removeSource = vi.fn().mockResolvedValue(undefined);
      const sourceStore = createMockSourceStore({ removeSource });
      const app = createSourceRoutes({ sourceStore });

      // URL `a%2520b` → Hono decodes ONCE → `a%20b` (a five-char routing key).
      // A second decode would wrongly yield `a b` and delete a different source.
      const res = await app.request('/sources/a%2520b', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(removeSource).toHaveBeenCalledWith('a%20b');
      expect(removeSource).not.toHaveBeenCalledWith('a b');
    });

    it('POST refresh forwards a literal-% routing key verbatim (was a 500)', async () => {
      // A non-GitHub row makes the helper throw "not a GitHub source", mapped
      // to a structured 400 — so a 400 proves listSources() found the row by the
      // SINGLY-decoded key. A second decode raises a URIError on `%` → 500.
      const listSources = vi
        .fn()
        .mockResolvedValue([
          { routing_key: 'github:100%done', provider: 'gitlab', name: 'n', slug: null },
        ]);
      const sourceStore = createMockSourceStore({ listSources });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/github%3A100%25done/refresh', { method: 'POST' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('github:100%done');
    });

    it('POST refresh does not collapse a %NN-looking routing key onto a different source', async () => {
      // URL `a%2520b` → Hono decodes ONCE → `a%20b`. A second decode yields
      // `a b`, which misses this row and reports the wrong key back.
      const listSources = vi
        .fn()
        .mockResolvedValue([{ routing_key: 'a%20b', provider: 'gitlab', name: 'n', slug: null }]);
      const sourceStore = createMockSourceStore({ listSources });
      const app = createSourceRoutes({ sourceStore });

      const res = await app.request('/sources/a%2520b/refresh', { method: 'POST' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('a%20b');
      expect(body.error).not.toContain('Source not found');
    });
  });
});

describe('GET /sources ingressUrl', () => {
  const githubRow = {
    id: 'src-1',
    provider: 'github',
    name: 'a',
    routing_key: 'github:42',
    customer_id: 'org_a',
    config: {},
    created_at: new Date(0),
    updated_at: new Date(0),
  };

  // fails-when: the field is absent, or the resolver gets the wrong id or org.
  // breaks-if-wrong: rows still list when no resolver is wired (second test).
  it('carries the URL the resolver builds from each row id and org', async () => {
    const listSources = vi.fn().mockResolvedValue([githubRow]);
    const resolveSourceIngressUrl = vi.fn(
      () => 'https://ci.example.com/webhook/org_a/github/src-1',
    );
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore({ listSources }),
      resolveSourceIngressUrl,
    });
    const body = (await (await app.request('/sources')).json()) as {
      sources: Array<{ ingressUrl: string | null }>;
    };
    expect(resolveSourceIngressUrl).toHaveBeenCalledWith({ id: 'src-1', customerId: 'org_a' });
    expect(body.sources[0].ingressUrl).toBe('https://ci.example.com/webhook/org_a/github/src-1');
  });

  it('is null without a resolver, and the rows still list', async () => {
    const listSources = vi.fn().mockResolvedValue([githubRow]);
    const app = createSourceRoutes({ sourceStore: createMockSourceStore({ listSources }) });
    const res = await app.request('/sources');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: Array<{ routingKey: string; ingressUrl: string | null }>;
    };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].routingKey).toBe('github:42');
    expect(body.sources[0].ingressUrl).toBeNull();
  });
});

describe('GET /sources githubUrl', () => {
  const row = {
    id: 'src-1',
    provider: 'github',
    name: 'a',
    routing_key: 'github:42',
    customer_id: 'org_a',
    config: { appId: '42' },
    github_url: null as string | null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
  const listed = async (rows: unknown[]) => {
    const listSources = vi.fn().mockResolvedValue(rows);
    const app = createSourceRoutes({ sourceStore: createMockSourceStore({ listSources }) });
    return ((await (await app.request('/sources')).json()) as { sources: object[] }).sources;
  };

  it('carries the server from the github_url column, never from config', async () => {
    // fails-when: the listed server is missing for a GHES source
    expect((await listed([{ ...row, github_url: 'https://ghe.corp.example' }]))[0]).toMatchObject({
      githubUrl: 'https://ghe.corp.example',
    });
    // fails-when: a config.githubUrl an older peer stored lists as the server
    const planted = { ...row, config: { appId: '42', githubUrl: 'https://evil.example' } };
    expect((await listed([planted]))[0]).not.toHaveProperty('githubUrl');
    // fails-when: the stale config copy shows beside the real top-level githubUrl
    const both = { ...planted, github_url: 'https://ghe.corp.example' };
    expect((await listed([both]))[0]).toMatchObject({
      githubUrl: 'https://ghe.corp.example',
      config: { appId: '42' },
    });
    expect((await listed([both]))[0]).not.toHaveProperty('config.githubUrl');
    // breaks-if-wrong: a github.com source's entry gains no githubUrl key
    expect((await listed([row]))[0]).not.toHaveProperty('githubUrl');
  });
});

describe('source org on a Platform-attached orchestrator', () => {
  const validator = vi.mocked(validateGitHubSource);
  const addedRow = (customerId: string) => ({
    id: 's1',
    provider: 'github',
    name: 'Test',
    routing_key: 'github:42',
    customer_id: customerId,
  });
  const post = (app: ReturnType<typeof createSourceRoutes>, body: Record<string, unknown>) =>
    app.request('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        name: 'n',
        appId: '42',
        privateKey: 'k',
        ...body,
      }),
    });

  beforeEach(() => {
    validator.mockClear();
  });

  it('files a new source under the attached org', async () => {
    // fails-when: the route ignores the attachment and files under __default__.
    const addSource = vi.fn().mockResolvedValue(addedRow('org_A'));
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore({ addSource }),
      getPlatformOrgId: () => 'org_A',
    });
    const res = await post(app, {});
    expect(res.status).toBe(201);
    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'org_A' }));
    expect(((await res.json()) as { customerId: string }).customerId).toBe('org_A');
  });

  it('refuses a mismatched customerId with 400 before validating', async () => {
    const addSource = vi.fn();
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore({ addSource }),
      getPlatformOrgId: () => 'org_A',
    });
    const res = await post(app, { customerId: 'org_B' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"org_A"');
    expect(validator).not.toHaveBeenCalled();
    expect(addSource).not.toHaveBeenCalled();
  });

  it('refuses a non-string customerId', async () => {
    const app = createSourceRoutes({ sourceStore: createMockSourceStore() });
    const res = await post(app, { customerId: 7 });
    expect(res.status).toBe(400);
  });

  it('refuses with 503 while the attachment is pending', async () => {
    const addSource = vi.fn();
    const app = createSourceRoutes({
      sourceStore: createMockSourceStore({ addSource }),
      getPlatformOrgId: () => undefined,
    });
    const res = await post(app, {});
    expect(res.status).toBe(503);
    expect(addSource).not.toHaveBeenCalled();
  });

  it('independent orchestrator keeps __default__', async () => {
    // breaks-if-wrong: an independent orchestrator files exactly as before.
    const addSource = vi.fn().mockResolvedValue(addedRow('__default__'));
    const app = createSourceRoutes({ sourceStore: createMockSourceStore({ addSource }) });
    const res = await post(app, {});
    expect(res.status).toBe(201);
    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ customerId: '__default__' }));
  });

  it('GET /sources reports platformAttachment and attachedOrgId', async () => {
    const attachedApp = createSourceRoutes({
      sourceStore: createMockSourceStore(),
      getPlatformOrgId: () => 'org_A',
    });
    expect(await (await attachedApp.request('/sources')).json()).toMatchObject({
      platformAttachment: 'attached',
      attachedOrgId: 'org_A',
      sources: [],
    });
    const independent = createSourceRoutes({ sourceStore: createMockSourceStore() });
    expect(await (await independent.request('/sources')).json()).toMatchObject({
      platformAttachment: 'none',
      attachedOrgId: null,
    });
  });

  describe('PATCH warning', () => {
    const existing = { ...addedRow('org_A'), config: JSON.stringify({ appId: '42' }) };
    const patch = async (getPlatformOrgId: (() => string | undefined) | undefined, org: string) => {
      const app = createSourceRoutes({
        sourceStore: createMockSourceStore({
          getSource: vi.fn().mockResolvedValue(existing),
          updateSource: vi.fn().mockResolvedValue(existing),
        }),
        ...(getPlatformOrgId && { getPlatformOrgId }),
      });
      const res = await app.request('/sources/github%3A42', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: org }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { warning?: string };
    };

    it('succeeds with a warning when the org is not the attached one', async () => {
      const body = await patch(() => 'org_A', 'org_B');
      expect(body.warning).toContain('"org_A"');
      expect(body.warning).toContain('kici-admin source update github:42 --org org_A');
    });

    it('carries no warning for the attached org', async () => {
      expect((await patch(() => 'org_A', 'org_A')).warning).toBeUndefined();
    });

    it('carries no warning on an independent orchestrator', async () => {
      expect((await patch(undefined, 'org_B')).warning).toBeUndefined();
    });
  });
});

describe('the GitHub server of a source', () => {
  const validator = vi.mocked(validateGitHubSource);
  const GHES = 'https://ghe.corp.example';
  const stored = {
    id: 's1',
    provider: 'github',
    name: 'App',
    routing_key: 'github:1',
    customer_id: '__default__',
    config: JSON.stringify({ appId: '1' }),
    github_url: GHES,
  };

  /** The routes behind a stand-in auth middleware that sets the token's routing-key scope. */
  function routesAs(routingKey: string | null, store: SourceStore): Hono {
    return new Hono()
      .use('*', (c, next) => {
        c.set('routingKey' as never, routingKey as never);
        return next();
      })
      .route('/', createSourceRoutes({ sourceStore: store }) as never);
  }

  const send = (app: Hono, method: string, path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const addBody = { provider: 'github', name: 'n', appId: '1', privateKey: 'pem' };

  /** A store holding `stored` with its private key, recording updates in `updateSource`. */
  const storeWithKey = (updateSource: SourceStore['updateSource']) =>
    createMockSourceStore({
      getSource: vi.fn().mockResolvedValue(stored),
      getSourceWithSecrets: vi.fn().mockResolvedValue({ ...stored, privateKey: 'pem' }),
      updateSource,
    });

  beforeEach(() => {
    validator.mockReset();
    validator.mockResolvedValue({ valid: true, appName: 'Test' });
  });

  it('POST with githubUrl validates at that server and stores it', async () => {
    const addSource = vi.fn().mockResolvedValue(stored);
    const app = routesAs(null, createMockSourceStore({ addSource }));

    const res = await send(app, 'POST', '/sources', { ...addBody, githubUrl: `${GHES}/` });

    expect(res.status).toBe(201);
    expect(validator).toHaveBeenCalledWith({ appId: '1', privateKey: 'pem', githubUrl: GHES });
    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ githubUrl: GHES }));
  });

  it('POST without githubUrl validates at github.com', async () => {
    const addSource = vi.fn().mockResolvedValue(stored);
    const app = routesAs(null, createMockSourceStore({ addSource }));

    await send(app, 'POST', '/sources', addBody);

    // breaks-if-wrong: the manual github.com add keeps working with no server field
    expect(validator).toHaveBeenCalledWith({
      appId: '1',
      privateKey: 'pem',
      githubUrl: undefined,
    });
  });

  it('POST refuses an invalid githubUrl with 400 before any GitHub call', async () => {
    const addSource = vi.fn();
    const app = routesAs(null, createMockSourceStore({ addSource }));

    const res = await send(app, 'POST', '/sources', {
      ...addBody,
      githubUrl: 'https://api.github.com',
    });

    // fails-when: an unvalidated githubUrl receives the App's JWT
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^githubUrl takes the web URL/);
    expect(validator).not.toHaveBeenCalled();
    expect(addSource).not.toHaveBeenCalled();
  });

  it('POST of an App id another source already uses names the App id and the one-source-per-App-id rule', async () => {
    const addSource = vi
      .fn()
      .mockRejectedValue(new DuplicateSourceError('github', '1', 'github:1'));
    const app = routesAs(null, createMockSourceStore({ addSource }));

    const res = await send(app, 'POST', '/sources', addBody);

    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('github:1');
    expect(error).toContain('an orchestrator holds one source per GitHub App id');
  });

  it('PATCH githubUrl with a routing-key-scoped token is 403 and makes no GitHub call', async () => {
    const updateSource = vi.fn();
    const store = createMockSourceStore({
      getSource: vi.fn().mockResolvedValue(stored),
      updateSource,
    });
    const app = routesAs('github:1', store);

    const res = await send(app, 'PATCH', '/sources/github%3A1', {
      githubUrl: 'https://evil.example',
    });

    // fails-when: a scoped token can redirect the App's JWT
    expect(res.status).toBe(403);
    expect(validator).not.toHaveBeenCalled();
    expect(updateSource).not.toHaveBeenCalled();
  });

  it('PATCH of another field with a routing-key-scoped token still works', async () => {
    const updateSource = vi.fn().mockResolvedValue(stored);
    const store = createMockSourceStore({
      getSource: vi.fn().mockResolvedValue(stored),
      updateSource,
    });

    const res = await send(routesAs('github:1', store), 'PATCH', '/sources/github%3A1', {
      config: { githubUrl: 'https://evil.example' },
    });

    // breaks-if-wrong: a scoped token keeps managing its own source
    expect(res.status).toBe(200);
    // The store strips githubUrl from the generic config (source-store.test.ts).
    expect(updateSource).toHaveBeenCalledWith(
      'github:1',
      expect.not.objectContaining({ githubUrl: expect.anything() }),
    );
    expect(validator).not.toHaveBeenCalled();
  });

  it('PATCH customerId needs an unscoped token: a scoped one is 403 and moves nothing', async () => {
    /** PATCH a new customer as a token scoped to `scope` (unscoped when null). */
    const patchCustomer = async (scope: string | null) => {
      const updateSource = vi.fn().mockResolvedValue(stored);
      const store = createMockSourceStore({
        getSource: vi.fn().mockResolvedValue(stored),
        updateSource,
      });
      const res = await send(routesAs(scope, store), 'PATCH', '/sources/github%3A1', {
        customerId: 'org_Y',
      });
      return { status: res.status, updateSource };
    };

    const scoped = await patchCustomer('github:1');
    // fails-when: a scoped token moves its source, and its registrations, into another org
    expect(scoped.status).toBe(403);
    expect(scoped.updateSource).not.toHaveBeenCalled();

    const unscoped = await patchCustomer(null);
    // breaks-if-wrong: the operator can still move a source between orgs
    expect(unscoped.status).toBe(200);
    expect(unscoped.updateSource).toHaveBeenCalledWith(
      'github:1',
      expect.objectContaining({ customerId: 'org_Y' }),
    );
  });

  it('PATCH githubUrl with an unscoped token re-validates at the new server before storing', async () => {
    const updateSource = vi.fn().mockResolvedValue(stored);
    const store = storeWithKey(updateSource);
    const app = routesAs(null, store);

    const res = await send(app, 'PATCH', '/sources/github%3A1', {
      githubUrl: 'https://ghe2.corp.example',
    });

    expect(res.status).toBe(200);
    expect(validator).toHaveBeenCalledWith({
      appId: '1',
      privateKey: 'pem',
      githubUrl: 'https://ghe2.corp.example',
    });
    expect(updateSource).toHaveBeenCalledWith(
      'github:1',
      expect.objectContaining({ githubUrl: 'https://ghe2.corp.example' }),
    );

    // The App does not answer at the new server: 400, nothing stored.
    validator.mockResolvedValueOnce({ valid: false, error: 'GitHub API validation failed: 401' });
    updateSource.mockClear();
    const refused = await send(app, 'PATCH', '/sources/github%3A1', {
      githubUrl: 'https://ghe3.corp.example',
    });
    expect(refused.status).toBe(400);
    expect(updateSource).not.toHaveBeenCalled();
  });

  it('PATCH githubUrl null clears the server after validating at github.com', async () => {
    const updateSource = vi.fn().mockResolvedValue(stored);
    const store = storeWithKey(updateSource);

    const res = await send(routesAs(null, store), 'PATCH', '/sources/github%3A1', {
      githubUrl: null,
    });

    expect(res.status).toBe(200);
    expect(validator).toHaveBeenCalledWith({ appId: '1', privateKey: 'pem', githubUrl: undefined });
    expect(updateSource).toHaveBeenCalledWith(
      'github:1',
      expect.objectContaining({ githubUrl: null }),
    );
  });

  describe('a stored server that is not a GitHub web URL', () => {
    const planted = { ...stored, github_url: 'http://x/y' };
    const plantedStore = (updateSource: SourceStore['updateSource']) =>
      createMockSourceStore({
        getSource: vi.fn().mockResolvedValue(planted),
        getSourceWithSecrets: vi.fn().mockResolvedValue({ ...planted, privateKey: 'pem' }),
        updateSource,
      });

    // breaks-if-wrong: the operator cannot repair the source, since every read refuses it
    it('PATCH githubUrl replaces it, validating only at the new server', async () => {
      const updateSource = vi.fn().mockResolvedValue(planted);
      const res = await send(
        routesAs(null, plantedStore(updateSource)),
        'PATCH',
        '/sources/github%3A1',
        {
          githubUrl: null,
        },
      );
      expect(res.status).toBe(200);
      expect(validator).toHaveBeenCalledWith({
        appId: '1',
        privateKey: 'pem',
        githubUrl: undefined,
      });
      expect(updateSource).toHaveBeenCalledWith(
        'github:1',
        expect.objectContaining({ githubUrl: null }),
      );
    });

    // fails-when: a key rotation validates at the planted server, or falls back to github.com
    it('PATCH of a new private key alone is refused, naming the source', async () => {
      const updateSource = vi.fn();
      const res = await send(
        routesAs(null, plantedStore(updateSource)),
        'PATCH',
        '/sources/github%3A1',
        {
          privateKey: 'new-pem',
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /^Source github:1 is refused: the stored GitHub server URL/,
      );
      expect(validator).not.toHaveBeenCalled();
      expect(updateSource).not.toHaveBeenCalled();
    });
  });

  it('PATCH of a new private key validates it at the stored server', async () => {
    const store = createMockSourceStore({
      getSource: vi.fn().mockResolvedValue(stored),
      updateSource: vi.fn().mockResolvedValue(stored),
    });

    await send(routesAs('github:1', store), 'PATCH', '/sources/github%3A1', {
      privateKey: 'new-pem',
    });

    // fails-when: a key rotation for a GHES source is validated at api.github.com and refused
    expect(validator).toHaveBeenCalledWith({ appId: '1', privateKey: 'new-pem', githubUrl: GHES });
  });

  it('PATCH of a new private key for a source with no stored App id is 400', async () => {
    const noAppId = { ...stored, config: JSON.stringify({}) };
    const updateSource = vi.fn();
    const store = createMockSourceStore({
      getSource: vi.fn().mockResolvedValue(noAppId),
      updateSource,
    });

    const res = await send(routesAs(null, store), 'PATCH', '/sources/github%3A1', {
      privateKey: 'new-pem',
    });

    // fails-when: the missing App id surfaces as a 500 instead of a client error
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Source github:1 has no stored GitHub App id' });
    expect(validator).not.toHaveBeenCalled();
    expect(updateSource).not.toHaveBeenCalled();
  });

  it('redeliver replays from the stored server', async () => {
    // Only the arguments matter here; the answer's shape is pinned in admin-sources.redeliver.test.ts.
    const redeliverDeliveries = vi.fn().mockResolvedValue({ results: [] } as never);
    const app = createSourceRoutes({ sourceStore: storeWithKey(vi.fn()), redeliverDeliveries });

    const res = await app.request('/sources/github%3A1/redeliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        since: '2026-11-01T00:00:00Z',
        until: '2026-11-01T01:00:00Z',
        dryRun: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(redeliverDeliveries).toHaveBeenCalledWith(
      { appId: '1', privateKey: 'pem', githubUrl: GHES },
      expect.objectContaining({ dryRun: true }),
    );
  });
});
