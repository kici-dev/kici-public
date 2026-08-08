import { describe, it, expect, vi } from 'vitest';
import { createSourceRoutes } from './admin-sources.js';
import type { SourceStore } from '../sources/source-store.js';

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
      const fetchAppIdentity = vi.fn().mockResolvedValue({ name: 'unchanged', slug: 'unchanged' });
      const app = createSourceRoutes({ sourceStore, fetchAppIdentity });

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
      // The whole batch reads the sources table exactly once — was 1 + N before.
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

  // A routing key is a single already-decoded Hono path param. The handlers
  // must NOT decode it a second time — a second decode either throws a
  // URIError (500) when the literal key carries a stray `%`, or silently
  // collapses a `%NN`-looking key onto a DIFFERENT source (wrong-source
  // read/mutation). Routing keys carry no charset validation on these routes.
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
      // The refresh route resolves the row out of listSources(). A non-GitHub
      // row makes the helper throw its "not a GitHub source" error, which the
      // route maps to a structured 400 — so a 400 here proves the lookup found
      // the row keyed by the SINGLY-decoded routing key. Under a second decode
      // the literal `%` raises a URIError and the route answers 500 instead.
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
