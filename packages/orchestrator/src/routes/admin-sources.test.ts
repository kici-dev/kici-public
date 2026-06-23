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
});
