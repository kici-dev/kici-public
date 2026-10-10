import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccessLogSource, ActorType, OrchestratorMode } from '@kici-dev/engine';
import type { AuthTokenInfo } from './admin-auth.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import { UNSCOPED_REQUIRED_MESSAGE } from '../secrets/routing-key-scope.js';
import { DEFAULT_ORG_ID } from '../oidc/orchestrator-mint.js';
import * as relay from '../ws/test-relay-handlers.js';
import * as remoteSources from '../pipeline/remote-source-store.js';
import { TestUploadStorageUnavailableError } from './uploads.js';
import {
  NO_PLATFORM_ORG_MESSAGE,
  createTestDirectRoutes,
  directOrgId,
  testDirectRouteDeps,
  type TestDirectRouteDeps,
} from './test-direct.js';

vi.mock('../ws/test-relay-handlers.js', () => ({
  handleTestUploadsInit: vi.fn(),
  handleTestTrigger: vi.fn(),
  handleTestRunStatus: vi.fn(),
  handleTestRunLogs: vi.fn(),
  handleTestCancel: vi.fn(),
}));

vi.mock('../pipeline/remote-source-store.js', async (orig) => {
  const actual = await orig<typeof remoteSources>();
  return { ...actual, provisionRemoteSource: vi.fn() };
});

const TOKENS: Record<string, AuthTokenInfo> = {
  dev: { id: 'tok-dev', role: 'admin', routingKey: null, label: 'dev', subject: 'dev@x.test' },
  aud: { id: 'tok-aud', role: 'auditor', routingKey: null, label: 'aud', subject: null },
  scoped: { id: 'tok-sc', role: 'admin', routingKey: 'github:42', label: 'sc', subject: null },
};

const RELAY_BASE = { db: {}, agentRegistry: {} };

function makeApp(over: Partial<TestDirectRouteDeps> = {}) {
  const deps: TestDirectRouteDeps = {
    tokenManager: { validate: vi.fn(async (t: string) => TOKENS[t] ?? null) },
    rbac: new RbacEnforcer(),
    mode: OrchestratorMode.enum.independent,
    platformOrgId: () => undefined,
    db: {} as TestDirectRouteDeps['db'],
    relayDeps: () => RELAY_BASE as unknown as ReturnType<TestDirectRouteDeps['relayDeps']>,
    ...over,
  };
  return createTestDirectRoutes(deps);
}

function call(
  app: ReturnType<typeof makeApp>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const TRIGGER_BODY = {
  fixtureId: 'fix-1',
  event: { type: 'push', targetBranch: 'main', payload: {} },
};

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/v1/test/whoami'],
  ['POST', '/api/v1/test/uploads/init', {}],
  ['POST', '/api/v1/test/trigger', TRIGGER_BODY],
  ['GET', '/api/v1/test/runs/run-1'],
  ['GET', '/api/v1/test/runs/run-1/logs?cursor=0'],
  ['POST', '/api/v1/test/runs/run-1/cancel'],
];

beforeEach(() => {
  vi.mocked(relay.handleTestUploadsInit).mockReset().mockResolvedValue({
    uploadId: 'up-1',
    signedUrl: 'http://127.0.0.1:14333/put',
    publicKey: 'pk',
    expiresIn: 3600,
  });
  vi.mocked(relay.handleTestTrigger)
    .mockReset()
    .mockResolvedValue({ runId: 'run-1', status: 'accepted', jobIds: ['j1'] });
  vi.mocked(relay.handleTestRunStatus)
    .mockReset()
    .mockResolvedValue({ runId: 'run-1', status: 'running', jobs: [], done: false });
  vi.mocked(relay.handleTestRunLogs)
    .mockReset()
    .mockResolvedValue({ lines: ['a'], nextCursor: 1, done: false });
  vi.mocked(relay.handleTestCancel).mockReset().mockResolvedValue({ cancelled: true });
  vi.mocked(remoteSources.provisionRemoteSource).mockReset().mockResolvedValue(undefined);
});

describe('directOrgId', () => {
  it('uses the default org in independent mode and the Platform org otherwise', () => {
    expect(directOrgId(OrchestratorMode.enum.independent, 'org_7')).toBe(DEFAULT_ORG_ID);
    expect(directOrgId(OrchestratorMode.enum.hybrid, 'org_7')).toBe('org_7');
    expect(directOrgId(OrchestratorMode.enum.platform, undefined)).toBeNull();
  });
});

describe('GET /api/v1/test/whoami', () => {
  it('names the caller, the mode, the org and its test-run permissions', async () => {
    const res = await call(makeApp(), 'dev', 'GET', '/api/v1/test/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tokenId: 'tok-dev',
      label: 'dev',
      subject: 'dev@x.test',
      role: 'admin',
      mode: 'independent',
      orgId: '__default__',
      permissions: { trigger: true, read: true },
    });
  });

  it('reports an auditor as unable to trigger', async () => {
    const res = await call(makeApp(), 'aud', 'GET', '/api/v1/test/whoami');
    expect((await res.json()).permissions).toEqual({ trigger: false, read: true });
  });

  it('reports a null org on a connected orchestrator that has none yet', async () => {
    const app = makeApp({ mode: OrchestratorMode.enum.hybrid });
    const res = await call(app, 'dev', 'GET', '/api/v1/test/whoami');
    expect(res.status).toBe(200);
    expect((await res.json()).orgId).toBeNull();
  });

  it('answers 401 for an unknown token', async () => {
    const res = await call(makeApp(), 'nope', 'GET', '/api/v1/test/whoami');
    expect(res.status).toBe(401);
  });
});

describe('scoped tokens', () => {
  it.each(ROUTES)('refuses a routing-key-scoped token on %s %s', async (method, path, body) => {
    const res = await call(makeApp(), 'scoped', method, path, body);
    // fails-when: a routing-key token reaches a route whose routing key the server chooses
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: UNSCOPED_REQUIRED_MESSAGE });
  });
});

describe('permissions', () => {
  it.each([
    ['POST', '/api/v1/test/trigger', TRIGGER_BODY],
    ['POST', '/api/v1/test/uploads/init', {}],
    ['POST', '/api/v1/test/runs/run-1/cancel', undefined],
  ] as Array<[string, string, unknown]>)(
    'refuses an auditor on %s %s',
    async (method, path, body) => {
      const res = await call(makeApp(), 'aud', method, path, body);
      // fails-when: the permission check is missing or checks test_run.read
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Permission denied: test_run.trigger required' });
      expect(relay.handleTestTrigger).not.toHaveBeenCalled();
      expect(relay.handleTestUploadsInit).not.toHaveBeenCalled();
      expect(relay.handleTestCancel).not.toHaveBeenCalled();
    },
  );

  it.each([['/api/v1/test/runs/run-1'], ['/api/v1/test/runs/run-1/logs']])(
    'lets an auditor read %s',
    async (path) => {
      // breaks-if-wrong: read-only tokens still follow runs
      expect((await call(makeApp(), 'aud', 'GET', path)).status).toBe(200);
    },
  );
});

describe('POST /api/v1/test/trigger', () => {
  it('ignores a client routing key and acts under the server-chosen one', async () => {
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/trigger', {
      ...TRIGGER_BODY,
      routingKey: 'remote:victim',
    });
    expect(res.status).toBe(200);
    const [msg, deps] = vi.mocked(relay.handleTestTrigger).mock.calls[0];
    // fails-when: a client-supplied routing key reaches processTestTrigger
    expect(msg.routingKey).toBe('remote:__default__');
    expect(msg.actor).toEqual({ type: ActorType.enum.service_account, id: 'tok-dev' });
    expect(deps.accessLogSource).toBe(AccessLogSource.enum.admin_http);
    expect(deps.orgId).toBe('__default__');
    expect(deps.routingKey).toBe('remote:__default__');
  });

  it('uses the Platform org on a connected orchestrator', async () => {
    const app = makeApp({ mode: OrchestratorMode.enum.hybrid, platformOrgId: () => 'org_7' });
    await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY);
    // breaks-if-wrong: hybrid runs under remote:<platform org>
    expect(vi.mocked(relay.handleTestTrigger).mock.calls[0][0].routingKey).toBe('remote:org_7');
  });

  it('answers 503 on a connected orchestrator with no org yet', async () => {
    const app = makeApp({ mode: OrchestratorMode.enum.hybrid });
    const trig = await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY);
    expect(trig.status).toBe(503);
    expect(await trig.json()).toEqual({ error: NO_PLATFORM_ORG_MESSAGE });
    const init = await call(app, 'dev', 'POST', '/api/v1/test/uploads/init', {});
    expect(init.status).toBe(503);
    expect(relay.handleTestTrigger).not.toHaveBeenCalled();
  });

  it('answers 422 with the payload when the run is rejected', async () => {
    vi.mocked(relay.handleTestTrigger).mockResolvedValue({
      runId: 'run-x',
      status: 'rejected',
      reason: 'no workflow matched',
      jobIds: [],
    });
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY);
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe('no workflow matched');
  });

  it('answers 400 for a body without a fixture id', async () => {
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/trigger', { event: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Validation error');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await makeApp().request('/api/v1/test/trigger', {
      method: 'POST',
      headers: { authorization: 'Bearer dev' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('remote-source anchor', () => {
  it('provisions the independent anchor once across two triggers', async () => {
    const app = makeApp();
    await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY);
    await call(app, 'dev', 'POST', '/api/v1/test/uploads/init', {});
    expect(remoteSources.provisionRemoteSource).toHaveBeenCalledTimes(1);
    expect(remoteSources.provisionRemoteSource).toHaveBeenCalledWith(expect.anything(), {
      orgId: '__default__',
      clusterId: null,
    });
  });

  it('never provisions on a connected orchestrator', async () => {
    const app = makeApp({ mode: OrchestratorMode.enum.hybrid, platformOrgId: () => 'org_7' });
    await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY);
    // breaks-if-wrong: a connected orchestrator's cluster_id must not be nulled
    expect(remoteSources.provisionRemoteSource).not.toHaveBeenCalled();
  });

  it('retries the anchor after a failed provision', async () => {
    vi.mocked(remoteSources.provisionRemoteSource)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const app = makeApp();
    expect((await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY)).status).toBe(500);
    expect((await call(app, 'dev', 'POST', '/api/v1/test/trigger', TRIGGER_BODY)).status).toBe(200);
    expect(remoteSources.provisionRemoteSource).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/v1/test/uploads/init', () => {
  it('returns the upload payload', async () => {
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/uploads/init', {
      sha: 'abc',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).uploadId).toBe('up-1');
    expect(vi.mocked(relay.handleTestUploadsInit).mock.calls[0][0].sha).toBe('abc');
  });

  it('answers 503 with the message when the orchestrator has no storage', async () => {
    vi.mocked(relay.handleTestUploadsInit).mockRejectedValue(
      new TestUploadStorageUnavailableError('no object storage configured'),
    );
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/uploads/init', {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no object storage configured' });
  });
});

describe('run routes', () => {
  it('answers 404 when a run is not found', async () => {
    vi.mocked(relay.handleTestRunStatus).mockResolvedValue({ error: 'Run not found' });
    vi.mocked(relay.handleTestRunLogs).mockResolvedValue({ error: 'Run not found' });
    vi.mocked(relay.handleTestCancel).mockResolvedValue({ error: 'Run not found' });
    const app = makeApp();
    expect((await call(app, 'dev', 'GET', '/api/v1/test/runs/x')).status).toBe(404);
    expect((await call(app, 'dev', 'GET', '/api/v1/test/runs/x/logs')).status).toBe(404);
    expect((await call(app, 'dev', 'POST', '/api/v1/test/runs/x/cancel')).status).toBe(404);
  });

  it('reads a malformed cursor as 0', async () => {
    await call(makeApp(), 'dev', 'GET', '/api/v1/test/runs/run-1/logs?cursor=abc');
    expect(vi.mocked(relay.handleTestRunLogs).mock.calls[0][0].cursor).toBe(0);
    await call(makeApp(), 'dev', 'GET', '/api/v1/test/runs/run-1/logs?cursor=7');
    expect(vi.mocked(relay.handleTestRunLogs).mock.calls[1][0].cursor).toBe(7);
  });

  it('cancels a run with the caller as actor and the HTTP source', async () => {
    const res = await call(makeApp(), 'dev', 'POST', '/api/v1/test/runs/run-1/cancel');
    expect(await res.json()).toEqual({ cancelled: true });
    const [msg, deps] = vi.mocked(relay.handleTestCancel).mock.calls[0];
    expect(msg.runId).toBe('run-1');
    expect(msg.actor).toEqual({ type: ActorType.enum.service_account, id: 'tok-dev' });
    expect(deps.accessLogSource).toBe(AccessLogSource.enum.admin_http);
  });
});

describe('testDirectRouteDeps', () => {
  const rest = {
    mode: OrchestratorMode.enum.independent,
    platformOrgId: () => undefined,
    db: {} as TestDirectRouteDeps['db'],
    relayDeps: () => RELAY_BASE as unknown as ReturnType<TestDirectRouteDeps['relayDeps']>,
  };

  it('is null without admin auth, so the routes are not mounted', () => {
    expect(testDirectRouteDeps({ adminDeps: undefined }, rest)).toBeNull();
  });

  it('carries the admin token manager and RBAC when admin auth is configured', () => {
    const tokenManager = { validate: vi.fn() };
    const rbac = new RbacEnforcer();
    expect(testDirectRouteDeps({ adminDeps: { tokenManager, rbac } }, rest)).toMatchObject({
      tokenManager,
      rbac,
    });
  });
});
