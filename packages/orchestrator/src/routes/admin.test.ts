import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes, type AdminRouteDeps } from './admin.js';
import type { Role } from '../secrets/rbac.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import { SecretScopeExistsError, SecretScopeNotFoundError } from '../secrets/pg-secret-store.js';

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
      createScope: vi.fn(),
      renameScope: vi.fn(),
      deleteScope: vi.fn(),
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

  // ── Scope rename ──────────────────────────────────────────────
  describe('scope rename', () => {
    it('renames an existing scope and returns 200', async () => {
      (deps.secretStore.renameScope as any).mockResolvedValue(undefined);

      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'aws/prod', newScope: 'aws/production' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ renamed: true });
      expect(deps.secretStore.renameScope).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'aws/production',
      );
    });

    it('returns 404 (not 500) when renaming a non-existent scope', async () => {
      (deps.secretStore.renameScope as any).mockRejectedValue(
        new SecretScopeNotFoundError('does-not-exist'),
      );

      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'does-not-exist', newScope: 'does-not-exist-2' },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Secret scope 'does-not-exist' not found" });
    });

    it('returns 409 (not 500) when the destination scope is already occupied', async () => {
      // The store refuses the merge; the route must surface it as a conflict
      // the operator can fix by choosing a free name, not a server fault.
      (deps.secretStore.renameScope as any).mockRejectedValue(
        new SecretScopeExistsError('aws/staging'),
      );

      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'aws/prod', newScope: 'aws/staging' },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Secret scope 'aws/staging' already exists" });
    });

    it('returns 400 when the request body is malformed (missing newScope)', async () => {
      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'aws/prod' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
    });
  });

  // ── Scope-name validation ─────────────────────────────────────
  describe('scope-name validation', () => {
    it('POST /secrets/scopes rejects an empty-path-segment scope with 400', async () => {
      const res = await request(app, 'POST', '/secrets/scopes', {
        token: validToken,
        body: { orgId: 'org-1', scope: 'a//b' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.createScope).not.toHaveBeenCalled();
    });

    it('POST /secrets/scopes rejects a percent-containing scope with 400', async () => {
      const res = await request(app, 'POST', '/secrets/scopes', {
        token: validToken,
        body: { orgId: 'org-1', scope: 'a%b' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.createScope).not.toHaveBeenCalled();
    });

    it('PUT /secrets/scopes/rename rejects a malformed newScope with 400', async () => {
      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'good', newScope: 'bad%name' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
    });

    it('PUT /secrets/scopes/rename allows a malformed oldScope with a valid newScope', async () => {
      (deps.secretStore.renameScope as any).mockResolvedValue(undefined);
      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'bad%name', newScope: 'good/name' },
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.renameScope).toHaveBeenCalledWith('org-1', 'bad%name', 'good/name');
    });

    it('PUT /secrets/:orgId/:scope/:key rejects a malformed scope with 400', async () => {
      // 'a%25b' decodes to the literal scope 'a%b' at the handler.
      const res = await request(app, 'PUT', '/secrets/org-1/a%25b/KEY', {
        token: validToken,
        body: { value: 'v' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    });
  });

  // ── Backend-qualified scopes ──────────────────────────────────
  describe('backend-qualified scopes', () => {
    it('PUT /secrets accepts a pg: qualifier and stores the BARE path', async () => {
      (deps.secretStore.setSecret as any).mockResolvedValue(undefined);
      const res = await request(app, 'PUT', '/secrets/org-1/pg%3Aaws%2Fprod/DB_PASSWORD', {
        token: validToken,
        body: { value: 'secret' },
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.setSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'DB_PASSWORD',
        'secret',
      );
    });

    it('PUT /secrets audits the scope in QUALIFIED wire form', async () => {
      (deps.secretStore.setSecret as any).mockResolvedValue(undefined);
      await request(app, 'PUT', '/secrets/org-1/pg%3Aaws%2Fprod/DB_PASSWORD', {
        token: validToken,
        body: { value: 'secret' },
      });
      expect(deps.auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'setSecret', contextName: 'pg:aws/prod' }),
      );
    });

    it('DELETE /secrets strips the qualifier and audits the wire form', async () => {
      (deps.secretStore.deleteSecret as any).mockResolvedValue(undefined);
      const res = await request(app, 'DELETE', '/secrets/org-1/pg%3Aaws%2Fprod/DB_PASSWORD', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.deleteSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'DB_PASSWORD',
      );
      expect(deps.auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deleteSecret', contextName: 'pg:aws/prod' }),
      );
    });

    it('POST /secrets/scopes creates the bare path for a qualified scope', async () => {
      (deps.secretStore.createScope as any).mockResolvedValue(undefined);
      const res = await request(app, 'POST', '/secrets/scopes', {
        token: validToken,
        body: { orgId: 'org-1', scope: 'pg:aws/prod' },
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.createScope).toHaveBeenCalledWith('org-1', 'aws/prod');
    });

    it('GET /secrets/keys strips the qualifier before listing', async () => {
      (deps.secretStore.listKeys as any).mockResolvedValue(['DB_HOST']);
      const res = await request(app, 'GET', '/secrets/keys?orgId=org-1&scope=pg%3Aaws%2Fprod', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.listKeys).toHaveBeenCalledWith('org-1', 'aws/prod');
    });

    it('DELETE /secrets/scopes/:orgId/:scope strips the qualifier', async () => {
      (deps.secretStore.deleteScope as any).mockResolvedValue(undefined);
      const res = await request(app, 'DELETE', '/secrets/scopes/org-1/pg%3Aaws%2Fprod', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.deleteScope).toHaveBeenCalledWith('org-1', 'aws/prod');
    });

    it('rename strips the qualifier on both sides', async () => {
      (deps.secretStore.renameScope as any).mockResolvedValue(undefined);
      const res = await request(app, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'pg:old', newScope: 'pg:new' },
      });
      expect(res.status).toBe(200);
      expect(deps.secretStore.renameScope).toHaveBeenCalledWith('org-1', 'old', 'new');
    });

    it('rename rejects a cross-backend move with 400 and touches no store', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
        renameScope: vi.fn(),
      };
      const crossDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockResolvedValue(new Map([['vault', vaultStore]])),
        } as any,
      });
      (crossDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      const crossApp = createAdminRoutes(crossDeps);
      const res = await request(crossApp, 'PUT', '/secrets/scopes/rename', {
        token: validToken,
        body: { orgId: 'org-1', oldScope: 'pg:old', newScope: 'vault:new' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('across backends') });
      expect(crossDeps.secretStore.renameScope).not.toHaveBeenCalled();
      expect(vaultStore.renameScope).not.toHaveBeenCalled();
    });

    it('routes a registered non-pg qualifier to that backend store', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn().mockResolvedValue(undefined),
        deleteSecret: vi.fn(),
      };
      const multiDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockResolvedValue(new Map([['vault', vaultStore]])),
        } as any,
      });
      (multiDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      const multiApp = createAdminRoutes(multiDeps);
      const res = await request(multiApp, 'PUT', '/secrets/org-1/vault%3Aaws%2Fprod/K', {
        token: validToken,
        body: { value: 'v' },
      });
      expect(res.status).toBe(200);
      expect(vaultStore.setSecret).toHaveBeenCalledWith('org-1', 'aws/prod', 'K', 'v');
      expect(multiDeps.secretStore.setSecret).not.toHaveBeenCalled();
    });

    it('routes pg: to the CONFIGURED store, never the registry-built one', async () => {
      // The registry synthesizes its own PgSecretStore for the default `pg`
      // row — one with customerSecretsEnabled defaulted to true, key version
      // hardcoded to 1, and no old-master-key fallback. Routing `pg:<path>`
      // there would bypass the operator's pgCustomerSecrets toggle and make
      // `pg:x` behave differently from `x`.
      const registryPgStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
      };
      const shadowedDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockResolvedValue(new Map([['pg', registryPgStore]])),
        } as any,
      });
      (shadowedDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      (shadowedDeps.secretStore.setSecret as any).mockResolvedValue(undefined);
      const shadowedApp = createAdminRoutes(shadowedDeps);
      const res = await request(shadowedApp, 'PUT', '/secrets/org-1/pg%3Aaws/K', {
        token: validToken,
        body: { value: 'v' },
      });
      expect(res.status).toBe(200);
      expect(shadowedDeps.secretStore.setSecret).toHaveBeenCalledWith('org-1', 'aws', 'K', 'v');
      expect(registryPgStore.setSecret).not.toHaveBeenCalled();
    });

    it('keys an UNREGISTERED head whole so routing keys stay 400-rejected', async () => {
      const res = await request(app, 'PUT', '/secrets/org-1/github%3A42/K', {
        token: validToken,
        body: { value: 'v' },
      });
      expect(res.status).toBe(400);
      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    });

    it('fails closed with a 5xx when the backend registry throws', async () => {
      const brokenDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockRejectedValue(new Error('registry down')),
        } as any,
      });
      (brokenDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      const brokenApp = createAdminRoutes(brokenDeps);
      const res = await request(brokenApp, 'PUT', '/secrets/org-1/pg%3Aaws/K', {
        token: validToken,
        body: { value: 'v' },
      });
      expect(res.status).toBe(500);
      expect(brokenDeps.secretStore.setSecret).not.toHaveBeenCalled();
    });
  });

  // ── Cross-backend scope listing ───────────────────────────────
  describe('GET /secrets/scopes ?allBackends', () => {
    it('defaults to the bare pg-only listing (byte-identical to before)', async () => {
      (deps.secretStore.listScopes as any).mockResolvedValue(['aws/prod']);
      const res = await request(app, 'GET', '/secrets/scopes?orgId=org-1', { token: validToken });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scopes: ['aws/prod'] });
    });

    it('qualifies every scope when allBackends=true', async () => {
      const vaultStore = {
        listScopes: vi.fn().mockResolvedValue(['aws/staging']),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
      };
      const multiDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockResolvedValue(new Map([['vault', vaultStore]])),
        } as any,
      });
      (multiDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      (multiDeps.secretStore.listScopes as any).mockResolvedValue(['aws/prod']);
      const multiApp = createAdminRoutes(multiDeps);
      const res = await request(multiApp, 'GET', '/secrets/scopes?orgId=org-1&allBackends=true', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scopes: ['pg:aws/prod', 'vault:aws/staging'] });
    });

    it('skips an unreachable backend instead of failing the whole listing', async () => {
      const vaultStore = {
        listScopes: vi.fn().mockRejectedValue(new Error('vault unreachable')),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
      };
      const multiDeps = createMockDeps({
        backendRegistry: {
          loadAllStores: vi.fn().mockResolvedValue(new Map([['vault', vaultStore]])),
        } as any,
      });
      (multiDeps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'admin' });
      (multiDeps.secretStore.listScopes as any).mockResolvedValue(['aws/prod']);
      const multiApp = createAdminRoutes(multiDeps);
      const res = await request(multiApp, 'GET', '/secrets/scopes?orgId=org-1&allBackends=true', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scopes: ['pg:aws/prod'] });
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

    it('forwards mandatoryLabels from the request body to createStatic', async () => {
      const mockTokenStore = {
        createStatic: vi.fn().mockResolvedValue({ token: 'kat_x', id: 'at-2' }),
        list: vi.fn().mockResolvedValue([]),
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
        body: {
          labels: ['linux', 'kici:privileged:root'],
          mandatoryLabels: ['kici:privileged:root'],
        },
      });
      expect(res.status).toBe(201);
      expect(mockTokenStore.createStatic).toHaveBeenCalledWith(
        expect.objectContaining({ mandatoryLabels: ['kici:privileged:root'] }),
      );
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

    it('sweeps secret backend configs and surfaces the counters in body + audit', async () => {
      const backendRegistry = {
        rotateKey: vi.fn().mockResolvedValue({ reEncrypted: 3, skipped: 1 }),
      };
      const sharedStore = { rotateKey: vi.fn().mockResolvedValue({ reEncrypted: 2, skipped: 0 }) };
      const localDeps = createMockDeps({
        backendRegistry: backendRegistry as any,
        sharedStore: sharedStore as any,
      });
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });
      (localDeps.secretStore.rotateKey as any).mockResolvedValue({ reEncrypted: 5 });
      const localApp = createAdminRoutes(localDeps);

      const res = await request(localApp, 'POST', '/rotate-key', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reEncryptedBackends).toBe(3);
      expect(body.skippedBackends).toBe(1);
      expect(backendRegistry.rotateKey).toHaveBeenCalledTimes(1);

      // Audit metadata carries the same two fields.
      const auditCall = (localDeps.auditLogger.log as any).mock.calls[0][0];
      expect(auditCall.metadata.reEncryptedBackends).toBe(3);
      expect(auditCall.metadata.skippedBackends).toBe(1);
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

  // ── Attestations retry (deferred-attestation outbox drain) ──────
  describe('attestations retry', () => {
    it('forwards includeRejected + returns the rejected count', async () => {
      const retryAttestations = vi.fn(async () => ({ minted: 1, stillPending: 2, rejected: 3 }));
      const localDeps = createMockDeps({ retryAttestations });
      const localApp = createAdminRoutes(localDeps);
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });

      const res = await request(localApp, 'POST', '/attestations/retry', {
        token: validToken,
        body: { includeRejected: true },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ minted: 1, stillPending: 2, rejected: 3 });
      expect(retryAttestations).toHaveBeenCalledWith({ includeRejected: true });
    });

    it('defaults includeRejected to false when the body omits it', async () => {
      const retryAttestations = vi.fn(async () => ({ minted: 0, stillPending: 0, rejected: 0 }));
      const localDeps = createMockDeps({ retryAttestations });
      const localApp = createAdminRoutes(localDeps);
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'user-1',
        role: 'owner' as Role,
        routingKey: null,
        label: 'test',
      });

      const res = await request(localApp, 'POST', '/attestations/retry', { token: validToken });
      expect(res.status).toBe(200);
      expect(retryAttestations).toHaveBeenCalledWith({ includeRejected: false });
    });

    it('403s an auditor and never runs the mutation', async () => {
      const retryAttestations = vi.fn(async () => ({ minted: 0, stillPending: 0, rejected: 0 }));
      const localDeps = createMockDeps({ retryAttestations });
      const localApp = createAdminRoutes(localDeps);
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'tok-auditor',
        role: 'auditor' as Role,
        routingKey: null,
        label: 'auditor',
      });

      const res = await request(localApp, 'POST', '/attestations/retry', {
        token: 'auditor-token',
        body: { includeRejected: true },
      });
      expect(res.status).toBe(403);
      expect(retryAttestations).not.toHaveBeenCalled();
    });

    it('owner succeeds and writes an attestation.retry access-log row', async () => {
      const retryAttestations = vi.fn(async () => ({ minted: 1, stillPending: 2, rejected: 3 }));
      const record = vi.fn(async () => undefined);
      const localDeps = createMockDeps({ retryAttestations, accessLog: { record } as any });
      const localApp = createAdminRoutes(localDeps);
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'tok-owner',
        role: 'owner' as Role,
        routingKey: null,
        label: 'owner',
      });

      const res = await request(localApp, 'POST', '/attestations/retry', {
        token: 'owner-token',
        body: { includeRejected: true },
      });
      expect(res.status).toBe(200);
      expect(retryAttestations).toHaveBeenCalledWith({ includeRejected: true });
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        action: 'attestation.retry',
        target: { type: 'attestation', id: 'all-pending' },
        meta: { include_rejected: true, minted: 1, still_pending: 2, rejected: 3 },
      });
    });

    it('403s a routing-key-scoped token (unscoped-token required)', async () => {
      const retryAttestations = vi.fn(async () => ({ minted: 0, stillPending: 0, rejected: 0 }));
      const localDeps = createMockDeps({ retryAttestations });
      const localApp = createAdminRoutes(localDeps);
      (localDeps.tokenManager.validate as any).mockResolvedValue({
        id: 'tok-scoped',
        role: 'owner' as Role,
        routingKey: 'some-key',
        label: 'scoped',
      });

      const res = await request(localApp, 'POST', '/attestations/retry', {
        token: 'scoped-token',
        body: {},
      });
      expect(res.status).toBe(403); // requireUnscopedToken denies scoped tokens
      expect(retryAttestations).not.toHaveBeenCalled();
    });
  });

  // A scope is a single already-decoded Hono path param. The handler must NOT
  // decode it a second time — a second decode throws a URIError (500) when the
  // literal scope carries a stray `%`. `validateScopeName` restricts scope
  // segments to [A-Za-z0-9_.-], so a `%`-bearing scope can never be created;
  // the fix here turns a 500 on client-controlled input into a clean structured
  // response, and is not an exploitable wrong-scope mutation for valid scopes.
  // The sibling PUT /secrets/:orgId/:scope/:key route already reads the param
  // plain — that is the shape this route now matches.
  describe('scope path param is decoded exactly once (no double-decode)', () => {
    it('DELETE scope forwards a literal-% scope verbatim (was a 500)', async () => {
      // URL segment `100%25done` decodes (once, by Hono) to the literal `100%done`.
      const res = await request(app, 'DELETE', '/secrets/scopes/org-1/100%25done', {
        token: validToken,
      });

      expect(res.status).toBe(200);
      expect(deps.secretStore.deleteScope).toHaveBeenCalledWith('org-1', '100%done');
    });

    it('does not collapse a %NN-looking scope onto a different scope', async () => {
      // URL `a%2520b` → Hono decodes ONCE → `a%20b` (a five-char scope). A
      // second decode would wrongly yield `a b` and target a different scope.
      const res = await request(app, 'DELETE', '/secrets/scopes/org-1/a%2520b', {
        token: validToken,
      });

      expect(res.status).toBe(200);
      expect(deps.secretStore.deleteScope).toHaveBeenCalledWith('org-1', 'a%20b');
      expect(deps.secretStore.deleteScope).not.toHaveBeenCalledWith('org-1', 'a b');
    });
  });
});

describe('trust-policy mount requires an audit sink', () => {
  const validToken = 'test-token-abc123';

  function withDeps(overrides: Partial<AdminRouteDeps>) {
    const deps = createMockDeps({ db: {} as never, mode: 'independent', ...overrides });
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'user-1',
      role: 'owner' as Role,
      routingKey: null,
      label: 'test',
    });
    return createAdminRoutes(deps);
  }

  it('mounts the route when an access log is wired', async () => {
    // Positive control: without this, the negative below would also pass if the
    // route had simply been deleted or renamed.
    const app = withDeps({ accessLog: { recordInTransaction: vi.fn() } as never });
    const res = await request(app, 'GET', '/trust-policy', { token: validToken });
    expect(res.status).not.toBe(404);
  });

  it('does not mount the route without one', async () => {
    // The route guarantees a trust-policy write is always attributable. An
    // orchestrator assembled with no access log gets NO trust-policy route
    // rather than one that would accept an unauditable write.
    const app = withDeps({ accessLog: undefined });
    const res = await request(app, 'GET', '/trust-policy', { token: validToken });
    expect(res.status).toBe(404);
  });
});
