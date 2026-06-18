/**
 * Admin API routes for secrets management.
 *
 * Provides CRUD endpoints for contexts, secrets, tokens, audit log queries,
 * and key rotation. All routes are protected by Bearer token authentication
 * and RBAC permission checks.
 *
 * Secret values are write-only -- there is deliberately no "get secret value"
 * endpoint. Values are only read during dispatch resolution.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope, requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import type { AuditLogger } from '../secrets/audit-logger.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { SharedConfigStore } from '../config/shared-store.js';
import { createSourceRoutes } from './admin-sources.js';
import { createDbRoutes } from './admin-db.js';
import { createBackendRoutes } from './admin-backends.js';
import { createOrgSettingsRoutes } from './admin-org-settings.js';
import { createClusterNameRoutes } from './admin-cluster-name.js';
import { createMaintenanceRoutes } from './admin-maintenance.js';
import { createAdminEnvironmentRoutes } from './admin-environments.js';
import { createAdminQueueExecutionRoutes } from './admin-queue-execution.js';
import type { SourceStore } from '../sources/source-store.js';
import type { JoinTokenManager } from '../cluster/join-token.js';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import type { BackendSyncManager } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { AccessLogWriter } from '../audit/access-log.js';

const logger = createLogger({ prefix: 'admin-api' });

/**
 * Dependencies for admin API routes.
 */
export interface AdminRouteDeps {
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  secretStore: PgSecretStore;
  auditLogger: AuditLogger;
  /** Optional -- for agent token CRUD endpoints. */
  tokenStore?: AgentTokenStore;
  /**
   * Optional -- for kicking in-flight agent WS on token revoke.
   *
   * The DELETE /api/v1/agent-tokens/:id route calls
   * `agentRegistry.disconnectByTokenId(id)` synchronously after
   * `tokenStore.revoke(id)` so a revoked token loses data-plane
   * authority immediately instead of staying live until the agent
   * itself disconnects. Mirrors the fix on the orch->Platform
   * leg (`disconnectByKeyId`).
   *
   * When unset, the DELETE route returns 503 — agent-token revoke is
   * meaningless without the kick path because a revoked token would
   * still grant in-flight authority for hours-to-days.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Optional -- fan out the revoke to every peer in a clustered orchestrator.
   *
   * The DELETE /api/v1/agent-tokens/:id route calls this after the synchronous
   * local kick, so every peer's `AgentRegistry.disconnectByTokenId(tokenId)`
   * runs locally and closes its own in-flight WS for the same token. Mirrors
   *'s Valkey fan-out pattern on the orch->Platform leg.
   *
   * Unset on standalone deployments (no peer fabric) -- the local kick alone
   * is sufficient there.
   */
  broadcastAgentTokenRevoke?: (tokenId: string) => void;
  /** Optional -- for source management endpoints. */
  sourceStore?: SourceStore;
  /**
   * Optional -- resolves the public webhook URL for a newly added source so
   * `kici-admin source add` can print it. Wired in platform/hybrid mode to
   * register-and-await the Platform ack; independent mode returns a null URL
   * with a note.
   */
  resolveSourceWebhookUrl?: (params: {
    routingKey: string;
    provider: string;
    sourceId: string;
  }) => Promise<{ webhookUrl: string | null; webhookNote?: string }>;
  /** Optional -- for DB migration endpoints. */
  db?: Kysely<any>;
  /** Optional -- for DB migration endpoints. */
  pool?: pg.Pool;
  /** Optional -- for cluster join token creation. */
  joinTokenManager?: JoinTokenManager;
  /** Optional -- for secret backend management endpoints. */
  backendRegistry?: BackendRegistry;
  /** Optional -- for secret backend health checking. */
  backendHealthChecker?: BackendHealthChecker;
  /** Optional -- for secret backend scope sync. */
  backendSyncManager?: BackendSyncManager;
  /**
   * Optional -- for `POST /api/v1/admin/rotate-key`.
   *
   * When set, `rotate-key` re-encrypts `config_versions` alongside
   * `scoped_secrets` in two sequential transactions. When unset (e.g. a
   * secret-store-only admin deployment), config rotation is skipped and the
   * response reports `reEncryptedConfigs: 0`.
   */
  sharedStore?: SharedConfigStore;
  /**
   * Optional -- attribution writer for routes that emit an `access_log`
   * row directly (today: org-settings dashboard-write policy flips). When
   * unset, those routes execute the mutation without recording — the
   * write is best-effort, never gating.
   */
  accessLog?: AccessLogWriter;
}

/** Hono env type for admin routes with context variables. */
type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

// ── Zod schemas for request validation ──────────────────────────────

const setScopedSecretSchema = z.object({
  value: z.string(),
});

const createTokenSchema = z.object({
  label: z.string().min(1).max(255),
  role: z.enum(['owner', 'admin', 'auditor']),
  routingKey: z.string().nullable().optional(),
});

const createAgentTokenSchema = z.object({
  labels: z.array(z.string()).optional(),
  createdBy: z.string().optional(),
});

const createJoinTokenSchema = z.object({
  orgId: z.string().min(1),
  routingKey: z.string().min(1),
  expiryMs: z.number().positive().optional(),
});

/**
 * Create admin API routes with Bearer token authentication and RBAC.
 *
 * @param deps - Admin route dependencies (token manager, RBAC, secret store, audit logger, etc.)
 * @returns Hono app with admin routes mounted at /api/v1/admin/*
 */
export function createAdminRoutes(deps: AdminRouteDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // ── Bearer token auth middleware ────────────────────────────────
  const authMiddleware = async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const token = authHeader.slice(7);
    const tokenInfo = await deps.tokenManager.validate(token);
    if (!tokenInfo) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    c.set('role', tokenInfo.role);
    c.set('userId', tokenInfo.id);
    c.set('routingKey', tokenInfo.routingKey);
    await next();
  };
  app.use('/api/v1/agent-tokens', authMiddleware);
  app.use('/api/v1/agent-tokens/*', authMiddleware);
  app.use('/api/v1/admin/*', authMiddleware);

  // ── Scoped secret CRUD ─────────────────────────────────────────

  // List scopes for an org
  app.get('/api/v1/admin/secrets/scopes', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const scopes = await deps.secretStore.listScopes(orgId);
      return c.json({ scopes }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List secret key names in a scope (no values)
  app.get('/api/v1/admin/secrets/keys', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      const scope = c.req.query('scope');
      if (!orgId || !scope) return c.json({ error: 'orgId and scope required' }, 400);
      const denied = enforceRoutingKeyScope(c, scope);
      if (denied) return denied;
      const keys = await deps.secretStore.listKeys(orgId, scope);
      return c.json({ keys }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Scope CRUD (registered before generic :orgId/:scope/:key routes
  //    to avoid Hono's LinearRouter matching "scopes" as :orgId) ──

  // Create empty scope
  app.post('/api/v1/admin/secrets/scopes', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = z.object({ orgId: z.string(), scope: z.string() }).parse(body);
      const denied = enforceRoutingKeyScope(c, parsed.scope);
      if (denied) return denied;
      await deps.secretStore.createScope(parsed.orgId, parsed.scope);
      return c.json({ created: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Rename scope
  app.put('/api/v1/admin/secrets/scopes/rename', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = z
        .object({ orgId: z.string(), oldScope: z.string(), newScope: z.string() })
        .parse(body);
      const deniedOld = enforceRoutingKeyScope(c, parsed.oldScope);
      if (deniedOld) return deniedOld;
      const deniedNew = enforceRoutingKeyScope(c, parsed.newScope);
      if (deniedNew) return deniedNew;
      await deps.secretStore.renameScope(parsed.orgId, parsed.oldScope, parsed.newScope);
      return c.json({ renamed: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Delete scope and all its secrets
  app.delete('/api/v1/admin/secrets/scopes/:orgId/:scope', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.delete');
      const orgId = c.req.param('orgId');
      const scope = decodeURIComponent(c.req.param('scope'));
      const denied = enforceRoutingKeyScope(c, scope);
      if (denied) return denied;
      await deps.secretStore.deleteScope(orgId, scope);
      return c.json({ deleted: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Set scoped secret
  app.put('/api/v1/admin/secrets/:orgId/:scope/:key', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = setScopedSecretSchema.parse(body);
      const orgId = c.req.param('orgId');
      const scope = c.req.param('scope');
      const key = c.req.param('key');
      const denied = enforceRoutingKeyScope(c, scope);
      if (denied) return denied;
      await deps.secretStore.setSecret(orgId, scope, key, parsed.value);

      await deps.auditLogger.log({
        action: 'setSecret',
        contextName: scope,
        routingKey: null,
        secretKeys: [key],
        outcome: 'allowed',
        runId: null,
        jobId: null,
        userId: c.get('userId'),
        role: c.get('role'),
        metadata: { orgId },
      });

      return c.json({ set: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Delete scoped secret
  app.delete('/api/v1/admin/secrets/:orgId/:scope/:key', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.delete');
      const orgId = c.req.param('orgId');
      const scope = c.req.param('scope');
      const key = c.req.param('key');
      const denied = enforceRoutingKeyScope(c, scope);
      if (denied) return denied;
      await deps.secretStore.deleteSecret(orgId, scope, key);

      await deps.auditLogger.log({
        action: 'deleteSecret',
        contextName: scope,
        routingKey: null,
        secretKeys: [key],
        outcome: 'allowed',
        runId: null,
        jobId: null,
        userId: c.get('userId'),
        role: c.get('role'),
        metadata: { orgId },
      });

      return c.json({ deleted: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Key rotation ────────────────────────────────────────────────

  app.post('/api/v1/admin/rotate-key', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'key.rotate');
      // Two sequential transactions — secrets first, then config. Keeps the
      // secrets rotation atomic on its own so a config-rotation bug can't
      // roll back a successful secrets rotation. Both are idempotent, so on
      // partial failure the operator just re-runs `rotate-key`.
      const secretsResult = await deps.secretStore.rotateKey();
      const configsResult = deps.sharedStore
        ? await deps.sharedStore.rotateKey()
        : { reEncrypted: 0, skipped: 0 };
      await deps.auditLogger.log({
        action: 'rotateKey',
        contextName: '*',
        routingKey: null,
        secretKeys: null,
        outcome: 'allowed',
        runId: null,
        jobId: null,
        userId: c.get('userId'),
        role: c.get('role'),
        metadata: {
          reEncrypted: secretsResult.reEncrypted,
          reEncryptedConfigs: configsResult.reEncrypted,
          skippedConfigs: configsResult.skipped,
        },
      });
      return c.json(
        {
          reEncrypted: secretsResult.reEncrypted,
          reEncryptedConfigs: configsResult.reEncrypted,
          skippedConfigs: configsResult.skipped,
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Audit log ───────────────────────────────────────────────────

  app.get('/api/v1/admin/audit', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'audit.read');
      const tokenRoutingKey = c.get('routingKey');
      const requestedRoutingKey = c.req.query('routingKey') ?? undefined;
      // Routing-key-scoped tokens can only read audit rows that match
      // their scope. If the caller asked for a different routing key,
      // refuse; otherwise force the filter so unfiltered queries don't
      // leak rows from other routing keys.
      if (tokenRoutingKey) {
        if (requestedRoutingKey && requestedRoutingKey !== tokenRoutingKey) {
          const denied = enforceRoutingKeyScope(c, requestedRoutingKey);
          if (denied) return denied;
        }
      }
      const effectiveRoutingKey = tokenRoutingKey ?? requestedRoutingKey;
      const query = {
        contextName: c.req.query('contextName') ?? undefined,
        routingKey: effectiveRoutingKey,
        action: c.req.query('action') ?? undefined,
        from: c.req.query('from') ? new Date(c.req.query('from')!) : undefined,
        to: c.req.query('to') ? new Date(c.req.query('to')!) : undefined,
        limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 100,
        offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
        // Opt-in: include archived rows from cold-store.
        includeArchived: c.req.query('includeArchived') === 'true',
      };
      const entries = await deps.auditLogger.query(query);
      return c.json({ entries }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Token management ────────────────────────────────────────────

  // Create token
  app.post('/api/v1/admin/tokens', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const body = await c.req.json();
      const parsed = createTokenSchema.parse(body);
      const result = await deps.tokenManager.generateToken(
        parsed.label,
        parsed.role,
        parsed.routingKey,
      );
      return c.json({ token: result.token, id: result.id }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List tokens (without hashes)
  app.get('/api/v1/admin/tokens', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const tokens = await deps.tokenManager.listTokens();
      return c.json({ tokens }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Revoke token
  app.delete('/api/v1/admin/tokens/:id', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      await deps.tokenManager.revokeToken(c.req.param('id'));
      return c.json({ revoked: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Agent Token CRUD ──────────────────────────────────────────────

  // Create static agent token
  app.post('/api/v1/agent-tokens', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const body = await c.req.json().catch(() => ({}));
      const parsed = createAgentTokenSchema.parse(body);
      const result = await deps.tokenStore.createStatic({
        labels: parsed.labels,
        createdBy: parsed.createdBy ?? c.get('userId'),
      });
      // Fetch the created row for full response (without hash)
      const tokens = await deps.tokenStore.list();
      const created = tokens.find((t) => t.id === result.id);
      return c.json(
        {
          id: result.id,
          token: result.token,
          tokenPrefix: created?.token_prefix ?? result.token.slice(0, 12),
          labels: parsed.labels ?? [],
          agentType: 'static',
          createdAt: created?.created_at ?? new Date().toISOString(),
        },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List agent tokens (non-revoked)
  app.get('/api/v1/agent-tokens', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const typeFilter = c.req.query('type') ?? undefined;
      const tokens = await deps.tokenStore.list(typeFilter ? { agentType: typeFilter } : undefined);
      return c.json({
        tokens: tokens.map((t) => ({
          id: t.id,
          tokenPrefix: t.token_prefix,
          labels: t.labels ? (typeof t.labels === 'string' ? JSON.parse(t.labels) : t.labels) : [],
          agentType: t.agent_type,
          createdAt: t.created_at,
          lastSeenAt: t.last_seen_at,
          expiresAt: t.expires_at,
        })),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Revoke agent token
  app.delete('/api/v1/agent-tokens/:id', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
    if (!deps.agentRegistry) {
      //: refuse to revoke without the kick path. A 204 here would
      // be a silent regression — the DB row would flip but every
      // in-flight WS authenticated by this token would retain
      // data-plane authority until it disconnected.
      return c.json({ error: 'Agent registry not available' }, 503);
    }
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const id = c.req.param('id');
      const revoked = await deps.tokenStore.revoke(id);
      if (!revoked) {
        return c.json({ error: 'Agent token not found or already revoked' }, 404);
      }
      // Synchronous local kick: close every in-flight WS authenticated
      // under this token before responding so the operator's CLI
      // feedback reflects what actually happened on the wire.
      const kicked = deps.agentRegistry.disconnectByTokenId(id);
      // Fan out the revoke to every peer in a clustered orchestrator so
      // each peer kicks its own in-flight WS for the same token. The
      // helper is unset on standalone deployments — the local kick is
      // sufficient there.
      deps.broadcastAgentTokenRevoke?.(id);
      logger.info('Agent token revoked', { tokenId: id, kicked });
      return c.json({ kicked }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Join token management ──────────────────────────────────────────

  // Create join token (for cluster bootstrap)
  app.post('/api/v1/admin/join-tokens', async (c) => {
    if (!deps.joinTokenManager) {
      return c.json({ error: 'Join token management not available' }, 503);
    }
    try {
      deps.rbac.requirePermission(c.get('role'), 'token.manage');
      const body = await c.req.json();
      const parsed = createJoinTokenSchema.parse(body);
      const denied = enforceRoutingKeyScope(c, parsed.routingKey);
      if (denied) return denied;
      const token = await deps.joinTokenManager.createToken({
        orgId: parsed.orgId,
        routingKey: parsed.routingKey,
        createdBy: c.get('userId'),
        expiryMs: parsed.expiryMs,
      });

      // Calculate expiry for response
      const expiryMs = parsed.expiryMs ?? 3600_000;
      const expiresAt = new Date(Date.now() + expiryMs).toISOString();

      return c.json({ token, expiresAt }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Mount source management routes (optional -- only when sourceStore is provided)
  if (deps.sourceStore) {
    app.route(
      '/api/v1/admin',
      createSourceRoutes({
        sourceStore: deps.sourceStore,
        resolveSourceWebhookUrl: deps.resolveSourceWebhookUrl,
      }),
    );
  }

  // Mount DB migration routes (optional -- only when db and pool are provided)
  if (deps.db && deps.pool) {
    app.route('/api/v1/admin', createDbRoutes({ db: deps.db, pool: deps.pool }));
  }

  // Mount backend management routes (optional -- only when registry and healthChecker are provided)
  if (deps.backendRegistry && deps.backendHealthChecker) {
    app.route(
      '/api/v1/admin',
      createBackendRoutes({
        registry: deps.backendRegistry,
        healthChecker: deps.backendHealthChecker,
        syncManager: deps.backendSyncManager,
      }),
    );
  }

  // Mount org-settings routes (optional -- only when db is provided).
  // Backs the `kici-admin org-settings global-workflows` subcommands.
  if (deps.db) {
    app.route(
      '/api/v1/admin',
      createOrgSettingsRoutes({ db: deps.db, rbac: deps.rbac, accessLog: deps.accessLog }),
    );
  }

  // Mount cluster-name routes (optional -- only when db is provided).
  // Backs the `kici-admin cluster-name {get,set}` subcommands.
  if (deps.db) {
    app.route(
      '/api/v1/admin',
      createClusterNameRoutes({ db: deps.db, rbac: deps.rbac, accessLog: deps.accessLog }),
    );
  }

  // Mount maintenance routes (queue clear, purge-stale, secrets purge).
  // Optional -- only when db is provided (never a WS-only admin).
  if (deps.db) {
    app.route('/api/v1/admin', createMaintenanceRoutes({ db: deps.db }));
  }

  // Mount environment management routes (create/bind/set-policy/list/show/template).
  // Optional -- only when db is provided.
  if (deps.db) {
    app.route('/api/v1/admin', createAdminEnvironmentRoutes({ db: deps.db, rbac: deps.rbac }));
  }

  // Mount queue + execution read routes (5a #3 /).
  // Optional -- only when db is provided.
  if (deps.db) {
    app.route('/api/v1/admin', createAdminQueueExecutionRoutes({ db: deps.db, rbac: deps.rbac }));
  }

  return app;
}

function handleError(c: any, err: unknown) {
  return handleAdminError(c, err, logger);
}
