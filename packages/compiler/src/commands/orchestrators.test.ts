import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { orchestratorsListCommand, orchestratorsUseCommand } from './orchestrators.js';

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
  mergeGlobalConfig: vi.fn().mockResolvedValue({}),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('kici orchestrators', () => {
  const fetchMock = vi.fn();
  let loadGlobalConfig: ReturnType<typeof vi.fn>;
  let mergeGlobalConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();

    const configMod = await import('../remote/config.js');
    loadGlobalConfig = configMod.loadGlobalConfig as ReturnType<typeof vi.fn>;
    mergeGlobalConfig = configMod.mergeGlobalConfig as ReturnType<typeof vi.fn>;

    loadGlobalConfig.mockResolvedValue({
      pat: 'pat-1',
      platformEndpoint: 'https://api.kici.dev',
      activeOrgId: 'org_a',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('list', () => {
    it('fetches the orchestrators index for the active org', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          orchestrators: [
            { clusterName: 'cluster-1', routingKeys: [], orchVersion: '0.1.0' },
            { clusterName: 'cluster-2', routingKeys: [], orchVersion: '0.1.0' },
          ],
        }),
      );
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const ok = await orchestratorsListCommand({});

      expect(ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_a/orchestrators');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pat-1');
      const printed = spy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('cluster-1');
      expect(printed).toContain('cluster-2');
      spy.mockRestore();
    });

    it('marks the per-org default cluster', async () => {
      loadGlobalConfig.mockResolvedValue({
        pat: 'pat-1',
        platformEndpoint: 'https://api.kici.dev',
        activeOrgId: 'org_a',
        defaultClusters: { org_a: 'cluster-2' },
      });
      fetchMock.mockResolvedValue(
        jsonResponse({
          orchestrators: [
            { clusterName: 'cluster-1', routingKeys: [], orchVersion: null },
            { clusterName: 'cluster-2', routingKeys: [], orchVersion: null },
          ],
        }),
      );
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await orchestratorsListCommand({});

      const defaultLine = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('*'));
      expect(defaultLine).toContain('cluster-2');
      spy.mockRestore();
    });

    it('uses --org over the active org', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ orchestrators: [] }));
      await orchestratorsListCommand({ org: 'org_override' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.kici.dev/api/v1/orgs/org_override/orchestrators');
    });

    it('errors when not logged in', async () => {
      loadGlobalConfig.mockResolvedValue({});
      expect(await orchestratorsListCommand({})).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('errors when no org is resolved', async () => {
      loadGlobalConfig.mockResolvedValue({ pat: 'p', platformEndpoint: 'https://api.kici.dev' });
      expect(await orchestratorsListCommand({})).toBe(false);
    });
  });

  describe('use', () => {
    it('writes config.defaultClusters[orgId] for a connected cluster', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          orchestrators: [{ clusterName: 'cluster-1', routingKeys: [], orchVersion: null }],
        }),
      );
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const ok = await orchestratorsUseCommand('cluster-1', {});

      expect(ok).toBe(true);
      expect(mergeGlobalConfig).toHaveBeenCalledWith({
        defaultClusters: { org_a: 'cluster-1' },
      });
      spy.mockRestore();
    });

    it('merges into existing defaultClusters without clobbering other orgs', async () => {
      loadGlobalConfig.mockResolvedValue({
        pat: 'pat-1',
        platformEndpoint: 'https://api.kici.dev',
        activeOrgId: 'org_a',
        defaultClusters: { org_b: 'cluster-b' },
      });
      fetchMock.mockResolvedValue(
        jsonResponse({
          orchestrators: [{ clusterName: 'cluster-1', routingKeys: [], orchVersion: null }],
        }),
      );
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await orchestratorsUseCommand('cluster-1', {});

      expect(mergeGlobalConfig).toHaveBeenCalledWith({
        defaultClusters: { org_b: 'cluster-b', org_a: 'cluster-1' },
      });
      spy.mockRestore();
    });

    it('rejects an unknown cluster name', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          orchestrators: [{ clusterName: 'cluster-1', routingKeys: [], orchVersion: null }],
        }),
      );

      const ok = await orchestratorsUseCommand('nope', {});

      expect(ok).toBe(false);
      expect(mergeGlobalConfig).not.toHaveBeenCalled();
    });
  });
});
