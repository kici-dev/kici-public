import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes, type AdminRouteDeps } from './admin.js';
import type { Role } from '../secrets/rbac.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Create mock admin route dependencies.
 * All methods are vi.fn() stubs for isolated testing.
 */
function createMockDeps(overrides?: Partial<AdminRouteDeps>): AdminRouteDeps {
  return {
    tokenManager: {
      validate: vi.fn(),
      generateToken: vi.fn(),
      listTokens: vi.fn(),
      revokeToken: vi.fn(),
      ensureBootstrapToken: vi.fn(),
    } as any,
    rbac: new RbacEnforcer(),
    secretStore: {
      getSecrets: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      listKeys: vi.fn(),
      listScopes: vi.fn(),
      getAllSecrets: vi.fn(),
      rotateKey: vi.fn(),
    } as any,
    auditLogger: {
      log: vi.fn(),
      query: vi.fn(),
    } as any,
    ...overrides,
  };
}

/** Helper: make a request to the admin routes app. */
async function request(
  app: ReturnType<typeof createAdminRoutes>,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
) {
  const headers: Record<string, string> = {};
  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
  if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const init: RequestInit = {
    method,
    headers,
  };
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  // Paths starting with / are absolute, otherwise prepend admin prefix
  const url = path.startsWith('/../')
    ? `http://localhost${path.slice(3)}`
    : `http://localhost/api/v1/admin${path}`;
  return app.request(url, init);
}

describe('admin routes', () => {
  let deps: AdminRouteDeps;
  let app: ReturnType<typeof createAdminRoutes>;
  const validToken = 'test-token-abc123';

  beforeEach(() => {
    deps = createMockDeps();
    app = createAdminRoutes(deps);

    // Default: validate returns owner role
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'user-1',
      role: 'owner' as Role,
      routingKey: null,
      label: 'test',
    });
  });

  // ── Auth middleware ────────────────────────────────────────────

  describe('auth middleware', () => {
    it('rejects missing Authorization header with 401', async () => {
      const res = await request(app, 'GET', '/secrets/scopes?orgId=org-1');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Missing authorization');
    });

    it('rejects non-Bearer Authorization header with 401', async () => {
      const res = await app.request('http://localhost/api/v1/admin/secrets/scopes?orgId=org-1', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects invalid token with 401', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue(null);
      const res = await request(app, 'GET', '/secrets/scopes?orgId=org-1', { token: 'bad-token' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired token');
    });
  });

  // ── Scoped secret CRUD ──────────────────────────────────────────

  describe('scoped secret operations', () => {
    it('list scopes requires orgId query parameter', async () => {
      const res = await request(app, 'GET', '/secrets/scopes', { token: validToken });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('orgId required');
    });

    it('list scopes returns scopes for an org', async () => {
      (deps.secretStore.listScopes as any).mockResolvedValue(['aws/prod', 'aws/staging']);

      const res = await request(app, 'GET', '/secrets/scopes?orgId=org-1', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scopes).toEqual(['aws/prod', 'aws/staging']);
    });

    it('list scopes requires secret.read permission', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });
      const res = await request(app, 'GET', '/secrets/scopes?orgId=org-1', { token: validToken });
      expect(res.status).toBe(403);
    });

    it('list keys requires orgId and scope query params', async () => {
      const res = await request(app, 'GET', '/secrets/keys?orgId=org-1', { token: validToken });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('orgId and scope required');
    });

    it('list keys returns key names for a scope', async () => {
      (deps.secretStore.listKeys as any).mockResolvedValue(['DB_HOST', 'DB_PASSWORD']);

      const res = await request(app, 'GET', '/secrets/keys?orgId=org-1&scope=aws/prod', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toEqual(['DB_HOST', 'DB_PASSWORD']);
    });

    it('set secret calls secretStore.setSecret with scoped API', async () => {
      (deps.secretStore.setSecret as any).mockResolvedValue(undefined);

      const res = await request(app, 'PUT', '/secrets/org-1/aws%2Fprod/MY_KEY', {
        token: validToken,
        body: { value: 'secret-value' },
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.setSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'MY_KEY',
        'secret-value',
      );
      expect(deps.auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'setSecret',
          secretKeys: ['MY_KEY'],
        }),
      );
    });

    it('set secret requires secret.write permission', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });
      const res = await request(app, 'PUT', '/secrets/org-1/scope/KEY', {
        token: validToken,
        body: { value: 'val' },
      });
      expect(res.status).toBe(403);
    });

    it('delete secret calls secretStore.deleteSecret with scoped API', async () => {
      (deps.secretStore.deleteSecret as any).mockResolvedValue(undefined);

      const res = await request(app, 'DELETE', '/secrets/org-1/aws%2Fprod/MY_KEY', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.deleteSecret).toHaveBeenCalledWith('org-1', 'aws/prod', 'MY_KEY');
    });
  });

  // ── Audit log ─────────────────────────────────────────────────

  describe('audit endpoint', () => {
    it('returns audit entries with filters', async () => {
      const entries = [
        { id: '1', action: 'setSecret', contextName: 'prod' },
        { id: '2', action: 'deleteSecret', contextName: 'prod' },
      ];
      (deps.auditLogger.query as any).mockResolvedValue(entries);

      const res = await request(app, 'GET', '/audit?contextName=prod&limit=10', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual(entries);
      expect(deps.auditLogger.query).toHaveBeenCalledWith(
        expect.objectContaining({
          contextName: 'prod',
          limit: 10,
        }),
      );
    });

    it('auditor role can query audit log', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });
      (deps.auditLogger.query as any).mockResolvedValue([]);

      const res = await request(app, 'GET', '/audit', { token: validToken });
      expect(res.status).toBe(200);
    });

    it('auditor cannot write secrets', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'test',
      });

      const writeRes = await request(app, 'PUT', '/secrets/org-1/scope/KEY', {
        token: validToken,
        body: { value: 'secret' },
      });
      expect(writeRes.status).toBe(403);
    });
  });

  // ── Token management ──────────────────────────────────────────

  describe('token management', () => {
    it('creates token and returns plaintext once', async () => {
      (deps.tokenManager.generateToken as any).mockResolvedValue({
        token: 'generated-token-xxx',
        id: 'tok-1',
      });

      const res = await request(app, 'POST', '/tokens', {
        token: validToken,
        body: { label: 'ci-key', role: 'admin' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token).toBe('generated-token-xxx');
      expect(body.id).toBe('tok-1');
    });

    it('lists tokens without hashes', async () => {
      (deps.tokenManager.listTokens as any).mockResolvedValue([
        { id: 'tok-1', label: 'ci-key', role: 'admin' },
      ]);

      const res = await request(app, 'GET', '/tokens', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toHaveLength(1);
    });

    it('revokes token', async () => {
      (deps.tokenManager.revokeToken as any).mockResolvedValue(undefined);

      const res = await request(app, 'DELETE', '/tokens/tok-1', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
    });
  });

  // ── Agent Token CRUD ─────────────────────────────────────────

  describe('agent token management', () => {
    it('creates a static agent token with kat_ prefix', async () => {
      const mockTokenStore = {
        createStatic: vi.fn().mockResolvedValue({
          token: 'kat_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          id: 'at-1',
        }),
        list: vi.fn().mockResolvedValue([
          {
            id: 'at-1',
            token_prefix: 'kat_abcdef01',
            labels: '["linux","x64"]',
            agent_type: 'static',
            created_at: '2026-02-19T00:00:00Z',
            last_seen_at: null,
            expires_at: null,
          },
        ]),
        revoke: vi.fn(),
      };

      const depsWithTokens = createMockDeps({ tokenStore: mockTokenStore as any });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'POST', '/../api/v1/agent-tokens', {
        token: validToken,
        body: { labels: ['linux', 'x64'] },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token).toMatch(/^kat_/);
      expect(body.id).toBe('at-1');
      expect(body.agentType).toBe('static');
    });

    it('lists agent tokens without hash', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([
          {
            id: 'at-1',
            token_prefix: 'kat_abcdef01',
            labels: '["linux","x64"]',
            agent_type: 'static',
            created_at: '2026-02-19T00:00:00Z',
            last_seen_at: null,
            expires_at: null,
          },
          {
            id: 'at-2',
            token_prefix: 'kat_12345678',
            labels: '[]',
            agent_type: 'ephemeral',
            created_at: '2026-02-19T01:00:00Z',
            last_seen_at: '2026-02-19T01:30:00Z',
            expires_at: '2026-02-19T02:00:00Z',
          },
        ]),
        revoke: vi.fn(),
      };

      const depsWithTokens = createMockDeps({ tokenStore: mockTokenStore as any });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'GET', '/../api/v1/agent-tokens', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toHaveLength(2);
      // Verify no hash field is present
      for (const t of body.tokens) {
        expect(t).not.toHaveProperty('token_hash');
        expect(t).toHaveProperty('tokenPrefix');
        expect(t).toHaveProperty('agentType');
      }
    });

    it('filters tokens by type', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([
          {
            id: 'at-1',
            token_prefix: 'kat_abcdef01',
            labels: '["linux"]',
            agent_type: 'static',
            created_at: '2026-02-19T00:00:00Z',
            last_seen_at: null,
            expires_at: null,
          },
        ]),
        revoke: vi.fn(),
      };

      const depsWithTokens = createMockDeps({ tokenStore: mockTokenStore as any });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'GET', '/../api/v1/agent-tokens?type=static', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(mockTokenStore.list).toHaveBeenCalledWith({ agentType: 'static' });
    });

    it('revokes token, kicks in-flight WS, fans out to peers, and returns 200 with local kicked count', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(true),
      };
      const mockAgentRegistry = {
        disconnectByTokenId: vi.fn().mockReturnValue(2),
      };
      const broadcastAgentTokenRevoke = vi.fn();

      const depsWithTokens = createMockDeps({
        tokenStore: mockTokenStore as any,
        agentRegistry: mockAgentRegistry as any,
        broadcastAgentTokenRevoke,
      });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'DELETE', '/../api/v1/agent-tokens/at-1', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(mockTokenStore.revoke).toHaveBeenCalledWith('at-1');
      expect(mockAgentRegistry.disconnectByTokenId).toHaveBeenCalledTimes(1);
      expect(mockAgentRegistry.disconnectByTokenId).toHaveBeenCalledWith('at-1');
      // Cross-peer fan-out: broadcaster is invoked once with the token id
      // after the local kick; the response carries only the local count.
      expect(broadcastAgentTokenRevoke).toHaveBeenCalledTimes(1);
      expect(broadcastAgentTokenRevoke).toHaveBeenCalledWith('at-1');
      const body = await res.json();
      expect(body).toEqual({ kicked: 2 });
    });

    it('returns 200 with kicked count even when no peer broadcaster is wired (standalone)', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(true),
      };
      const mockAgentRegistry = {
        disconnectByTokenId: vi.fn().mockReturnValue(1),
      };

      // No `broadcastAgentTokenRevoke` -- standalone deployments don't have a
      // peer fabric. The local kick is sufficient and the route must still
      // return 200 with the kicked count.
      const depsWithTokens = createMockDeps({
        tokenStore: mockTokenStore as any,
        agentRegistry: mockAgentRegistry as any,
      });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'DELETE', '/../api/v1/agent-tokens/at-2', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ kicked: 1 });
    });

    it('returns 404 when revoke fails (not found or already revoked)', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(false),
      };
      const mockAgentRegistry = {
        disconnectByTokenId: vi.fn().mockReturnValue(0),
      };
      const broadcastAgentTokenRevoke = vi.fn();

      const depsWithTokens = createMockDeps({
        tokenStore: mockTokenStore as any,
        agentRegistry: mockAgentRegistry as any,
        broadcastAgentTokenRevoke,
      });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'DELETE', '/../api/v1/agent-tokens/nonexistent', {
        token: validToken,
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Agent token not found or already revoked');
      // Verify list() is NOT called (no longer needed to distinguish 404 vs 409)
      expect(mockTokenStore.list).not.toHaveBeenCalled();
      // Kick path must NOT run when the DB row was already revoked /
      // missing -- there is no token to "kick" and the count would be
      // misleading.
      expect(mockAgentRegistry.disconnectByTokenId).not.toHaveBeenCalled();
      // Same for the cross-peer fan-out: a 404 means the row was never
      // revoked here, so there is no event to broadcast.
      expect(broadcastAgentTokenRevoke).not.toHaveBeenCalled();
    });

    it('returns 503 when agentRegistry is missing (refuses silent revoke without kick)', async () => {
      const mockTokenStore = {
        createStatic: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(true),
      };

      // Wired: tokenStore is present, agentRegistry is NOT.
      const depsWithTokens = createMockDeps({ tokenStore: mockTokenStore as any });
      (depsWithTokens.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      const appWithTokens = createAdminRoutes(depsWithTokens);

      const res = await request(appWithTokens, 'DELETE', '/../api/v1/agent-tokens/at-1', {
        token: validToken,
      });
      expect(res.status).toBe(503);
      // Token store revoke MUST NOT run -- a 204 / 200 with no kick path
      // would silently regress the fix.
      expect(mockTokenStore.revoke).not.toHaveBeenCalled();
    });
  });

  // ── Key rotation ──────────────────────────────────────────────

  describe('key rotation', () => {
    it('rotates key and returns re-encrypted count', async () => {
      (deps.secretStore.rotateKey as any).mockResolvedValue({ reEncrypted: 5 });

      const res = await request(app, 'POST', '/rotate-key', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reEncrypted).toBe(5);
    });

    it('admin cannot rotate keys', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'admin' as Role,
        routingKey: null,
        label: 'test',
      });

      const res = await request(app, 'POST', '/rotate-key', { token: validToken });
      expect(res.status).toBe(403);
    });
  });
});
