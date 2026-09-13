import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildLocalTriggerRequest, triggerRun, type RunDiscoveryClient } from './plane-trigger.js';

describe('buildLocalTriggerRequest', () => {
  it('builds a GitHub-shaped push body + generic webhook path', () => {
    const req = buildLocalTriggerRequest({
      orgId: '__default__',
      sourceId: 'src-1',
      repoFullName: '.',
      event: 'push',
      ref: 'refs/heads/kici-local',
      sha: 'abc123',
      defaultBranch: 'kici-local',
    });
    expect(req.path).toBe('/webhook/__default__/generic/src-1');
    expect(req.headers['x-event-type']).toBe('push');
    expect(req.headers['x-delivery-id']).toBeTruthy();
    const body = JSON.parse(req.body);
    expect(body.ref).toBe('refs/heads/kici-local');
    expect(body.after).toBe('abc123');
    expect(body.repository).toEqual({ full_name: '.', default_branch: 'kici-local' });
  });

  it('builds a dispatch body carrying action + client_payload', () => {
    const req = buildLocalTriggerRequest({
      orgId: '__default__',
      sourceId: 'src-1',
      repoFullName: '.',
      event: 'dispatch',
      ref: 'refs/heads/master',
      sha: 'abc123',
      defaultBranch: 'master',
      action: 'deploy-stg',
      clientPayload: { mode: 'full', skipBuild: true },
    });
    expect(req.headers['x-event-type']).toBe('dispatch');
    const body = JSON.parse(req.body);
    expect(body.action).toBe('deploy-stg');
    expect(body.client_payload).toEqual({ mode: 'full', skipBuild: true });
    // Provenance fields are still present.
    expect(body.after).toBe('abc123');
  });

  it('omits dispatch-only fields for a push event', () => {
    const req = buildLocalTriggerRequest({
      orgId: '__default__',
      sourceId: 'src-1',
      repoFullName: '.',
      event: 'push',
      ref: 'refs/heads/master',
      sha: 'abc123',
      defaultBranch: 'master',
    });
    const body = JSON.parse(req.body);
    expect(body.action).toBeUndefined();
    expect(body.client_payload).toBeUndefined();
  });
});

describe('triggerRun', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        json: async () => ({ accepted: true, deliveryId: 'rk:del-1' }),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const input = {
    orgId: '__default__',
    sourceId: 'src-1',
    repoFullName: '.',
    event: 'push' as const,
    ref: 'refs/heads/kici-local',
    sha: 'abc',
    defaultBranch: 'kici-local',
  };

  it('sends the webhook and resolves the discovered runId', async () => {
    // First poll: no run yet; second poll: the run appears.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ runs: [{ runId: 'run-9' }] });
    const client: RunDiscoveryClient = { get };
    const runId = await triggerRun('http://127.0.0.1:4319', 'tok', input, {
      client,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(runId).toBe('run-9');
    // The webhook was POSTed to the generic route.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      '/webhook/__default__/generic/src-1',
    );
  });

  it('throws when no run appears before the timeout', async () => {
    const client: RunDiscoveryClient = { get: vi.fn().mockResolvedValue({ runs: [] }) };
    await expect(
      triggerRun('http://127.0.0.1:4319', 'tok', input, {
        client,
        pollIntervalMs: 1,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/no run appeared/);
  });

  it('polls by the delivery id of THIS webhook, never "newest since"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        json: async () => ({ accepted: true, deliveryId: 'rk:mine' }),
      }),
    );
    // The discovery poll MUST carry the captured, url-encoded delivery id.
    // A decoy run from another invocation is never returned because the
    // filtered query only matches this delivery.
    const get = vi.fn(async (path: string) => {
      expect(path).toContain('deliveryId=rk%3Amine');
      return { runs: [{ runId: 'run-mine' }] };
    });
    const runId = await triggerRun('http://127.0.0.1:4319', 'tok', input, {
      client: { get: get as RunDiscoveryClient['get'] },
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(runId).toBe('run-mine');
  });

  it('captures the delivery id from a resend when the first send has none', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, json: async () => ({ rejected: true }) })
      .mockResolvedValue({
        status: 202,
        json: async () => ({ accepted: true, deliveryId: 'rk:late' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const get = vi.fn(async (path: string) =>
      path.includes('deliveryId=rk%3Alate') ? { runs: [{ runId: 'run-late' }] } : { runs: [] },
    );
    const runId = await triggerRun('http://127.0.0.1:4319', 'tok', input, {
      client: { get: get as RunDiscoveryClient['get'] },
      pollIntervalMs: 1,
      resendAfterMs: 1,
      timeoutMs: 5_000,
    });
    expect(runId).toBe('run-late');
  });
});

describe('triggerRun timeout diagnosis', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        json: async () => ({ accepted: true, deliveryId: 'rk:del-diag' }),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const input = {
    orgId: '__default__',
    sourceId: 'src-1',
    repoFullName: '.',
    event: 'push' as const,
    ref: 'refs/heads/kici-local',
    sha: 'cafebabe',
    defaultBranch: 'kici-local',
  };

  /** Route a single `get` mock across the three paths the diagnosis reads. */
  const routed = (routes: {
    runs?: unknown;
    health?: unknown;
    eventLog?: unknown;
  }): RunDiscoveryClient => ({
    get: vi.fn(async (path: string) => {
      if (path.startsWith('/cluster/health')) {
        if (routes.health === undefined) throw new Error('health unavailable');
        return routes.health;
      }
      if (path.startsWith('/api/v1/admin/event-log')) {
        if (routes.eventLog === undefined) throw new Error('event-log unavailable');
        return routes.eventLog;
      }
      return routes.runs ?? { runs: [] };
    }) as RunDiscoveryClient['get'],
  });

  const timeout = (client: RunDiscoveryClient) =>
    triggerRun('http://127.0.0.1:4319', 'tok', input, {
      client,
      pollIntervalMs: 1,
      timeoutMs: 30,
      repoBasePath: '/tmp/clone-x',
      logPath: '/home/dev/.kici/local/orchestrator.log',
    });

  it('names the election grace period when the plane has not elected a leader', async () => {
    // fails-when: the diagnosis ignores /cluster/health and reports the generic
    // fallback while the plane is still a dormant follower.
    await expect(
      timeout(
        routed({ health: { role: 'follower', leaderId: null }, eventLog: { deliveries: [] } }),
      ),
    ).rejects.toThrow(/plane is not leader yet \(election grace period\)/);
  });

  it('names the missing lock file when the plane recorded lockfile_missing', async () => {
    // fails-when: the diagnosis does not read the delivery's event-log status,
    // so a delivery the plane explicitly rejected reports "no run appeared".
    await expect(
      timeout(
        routed({
          health: { role: 'leader', leaderId: 'i-1' },
          eventLog: {
            deliveries: [
              { status: 'lockfile_missing', errorMessage: null, ref: 'refs/heads/kici-local' },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/no kici\.lock\.json at cafebabe in \/tmp\/clone-x/);
  });

  it('reports the recorded delivery status for any other terminal status', async () => {
    // fails-when: a non-lockfile_missing status falls through to the generic
    // fallback, hiding a cause the plane had already written down.
    await expect(
      timeout(
        routed({
          health: { role: 'leader', leaderId: 'i-1' },
          eventLog: {
            deliveries: [{ status: 'failed', errorMessage: 'normalizer threw', ref: null }],
          },
        }),
      ),
    ).rejects.toThrow(/recorded delivery rk:del-diag as "failed" \(normalizer threw\)/);
  });

  it('falls back to the delivery id and the plane log when nothing else answers', async () => {
    // fails-when: a diagnosis probe that throws propagates and replaces the
    // timeout with a network error, losing the original failure.
    await expect(timeout(routed({}))).rejects.toThrow(
      /no run appeared.*rk:del-diag.*\/home\/dev\/\.kici\/local\/orchestrator\.log/s,
    );
  });

  it('says the webhook was never accepted when no delivery id came back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 404, json: async () => ({ rejected: true }) }),
    );
    // fails-when: a null delivery id renders as "undefined" instead of naming
    // the fact that the plane never accepted the webhook at all.
    await expect(timeout(routed({ health: { role: 'leader', leaderId: 'i-1' } }))).rejects.toThrow(
      /the plane never accepted the webhook/,
    );
  });
});
