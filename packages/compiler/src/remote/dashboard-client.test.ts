import { describe, it, expect, vi, afterEach } from 'vitest';
import { DashboardClient, DashboardClientError } from './dashboard-client.js';
import type { GlobalConfig } from './config.js';

const baseConfig: GlobalConfig = {
  platformEndpoint: 'https://platform.example',
  pat: 'kici_pat_abc',
  activeOrgId: 'org-1',
};

afterEach(() => vi.restoreAllMocks());

describe('DashboardClient.fromConfig', () => {
  it('throws not-logged-in when no PAT', () => {
    expect(() => DashboardClient.fromConfig({ platformEndpoint: 'x' })).toThrowError(/kici login/);
  });

  it('throws no-active-org when activeOrgId missing', () => {
    expect(() =>
      DashboardClient.fromConfig({ platformEndpoint: 'x', pat: 'kici_pat_abc' }),
    ).toThrowError(/kici org use/);
  });

  it('builds org-scoped URLs and sends the bearer token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = DashboardClient.fromConfig(baseConfig);
    await client.getJson('/runs');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/v1/orgs/org-1/runs',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer kici_pat_abc' }),
      }),
    );
  });

  it('maps 403 to a permission DashboardClientError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Insufficient permission: runs.read needed' }), {
        status: 403,
      }),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    await expect(client.getJson('/runs')).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
    });
  });

  it('maps 503 to an orchestrator-offline error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const client = DashboardClient.fromConfig(baseConfig);
    await expect(client.getJson('/runs/x/detail')).rejects.toMatchObject({
      kind: 'orchestrator_offline',
    });
  });

  it('maps 404 to a not-found error carrying the detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 }),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    await expect(client.getJson('/runs/x')).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
    });
  });

  it('maps 429 to a cooldown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Wait 5s' }), { status: 429 }),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    await expect(client.postJson('/runs/x/rerun')).rejects.toMatchObject({
      kind: 'cooldown',
      status: 429,
    });
  });
});

describe('DashboardClient typed methods', () => {
  it('listRuns builds a query string from filters and validates the response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ runs: [], total: 0, page: 1, pageSize: 20, hasMore: false }),
          { status: 200 },
        ),
      );
    const client = DashboardClient.fromConfig(baseConfig);
    const page = await client.listRuns({ status: 'running', workflow: 'ci', page: 2 });
    expect(page.pageSize).toBe(20);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/orgs/org-1/runs?');
    expect(calledUrl).toContain('status=running');
    expect(calledUrl).toContain('workflow=ci');
    expect(calledUrl).toContain('page=2');
  });

  it('getInfrastructure validates the tree response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ orchestrators: [], alerts: [] }), { status: 200 }),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    const infra = await client.getInfrastructure();
    expect(infra.orchestrators).toEqual([]);
  });

  it('getRun unwraps the run envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          run: {
            runId: 'r1',
            workflowName: 'ci',
            status: 'success',
            repoIdentifier: 'o/r',
            sha: 'abc',
            ref: 'main',
            triggerEvent: 'push',
            commitMessage: null,
            jobCount: 1,
            startedAt: '2026-06-12T00:00:00.000Z',
            completedAt: null,
            durationMs: null,
            parentRunId: null,
            originalRunId: null,
            triggeredBy: null,
            triggeredByUser: null,
            cancelledBy: null,
            cancelledByUser: null,
            hadCompileJob: false,
            compileJobId: null,
            source: null,
          },
        }),
        { status: 200 },
      ),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    const run = await client.getRun('r1');
    expect(run.runId).toBe('r1');
  });

  it('cancelByBranch posts to the branch endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ cancelledRuns: 2 }), { status: 200 }));
    const client = DashboardClient.fromConfig(baseConfig);
    const out = await client.cancelByBranch('main');
    expect(out.cancelledRuns).toBe(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/orgs/org-1/runs/cancel-by-branch');
  });

  it('rerunRun returns the new run id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ newRunId: 'r2' }), { status: 200 }),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    const out = await client.rerunRun('r1');
    expect(out.newRunId).toBe('r2');
  });

  it('listRegistrations hits /registrations and passes filters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            registrations: [],
            registryVersion: 3,
            registryUpdatedAt: '2026-01-01',
          }),
          { status: 200 },
        ),
      );
    const client = DashboardClient.fromConfig(baseConfig);
    const out = await client.listRegistrations({ triggerType: 'schedule', repoIdentifier: 'o/r' });
    expect(out.registryVersion).toBe(3);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/orgs/org-1/registrations?');
    expect(url).toContain('triggerType=schedule');
    expect(url).toContain('repoIdentifier=o%2Fr');
  });

  it('listEnvironments requests includeSecrets and returns the contexts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          environments: [
            { name: 'prod', enabled: true, allowLocalExecution: true, secretKeys: ['API_KEY'] },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = DashboardClient.fromConfig(baseConfig);
    const out = await client.listEnvironments(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'prod', secretKeys: ['API_KEY'] });
    expect(fetchMock.mock.calls[0][0]).toContain('/orgs/org-1/environments?includeSecrets=true');
  });
});
