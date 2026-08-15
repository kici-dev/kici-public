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
import { createLogger, toErrorMessage } from '@kici-dev/shared';
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
import { createTrustPolicyRoutes } from './admin-trust-policy.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import { createClusterSettingsRoutes } from './admin-cluster-settings.js';
import { createClusterNameRoutes } from './admin-cluster-name.js';
import { createMaintenanceRoutes } from './admin-maintenance.js';
import { createOrchestratorDrainRoutes } from './admin-orchestrator-drain.js';
import type { DrainController } from '../drain/drain-controller.js';
import { createAdminContextRoutes } from './admin-contexts.js';
import { createAdminQueueExecutionRoutes } from './admin-queue-execution.js';
import type { SourceStore } from '../sources/source-store.js';
import type { JoinTokenManager } from '../cluster/join-token.js';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import type { BackendSyncManager, OrchestratorMode } from '@kici-dev/engine';
import { validateScopeName, validateSecretKey } from '@kici-dev/engine';
import {
  loadRoutableStores,
  resolveScope,
  toWireScope,
  type ScopedSecretStore,
} from '../secrets/scope-routing.js';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { AccessLogWriter } from '../audit/access-log.js';
import { createBearerAuthMiddleware } from './admin-auth.js';

const logger = createLogger({ prefix: 'admin-api' });

/**
 * Dependencies for admin API routes.
 */
export interface AdminRouteDeps {
  tokenManager: TokenManager;
  /**
   * Orchestrator operating mode. Gates mode-specific admin behavior — today the
   * `observed`-mode refusal of GitHub-App source creation (those sources are
   * Platform-relayed by nature, and an observed orchestrator never accepts a
   * relay). Optional so WS-only / test admins can omit it.
   */
  mode?: OrchestratorMode;
  rbac: RbacEnforcer;
  secretStore: PgSecretStore;
  auditLogger: AuditLogger;
  /**
   * Fleet-wide default for the global-workflows master switch, applied when the
   * cluster column is NULL. Optional so WS-only / test admins can omit it;
   * omitting it means the secure default (disabled).
   */
  globalWorkflowsEnabledDefault?: boolean;
  /**
   * Optional -- the coordinator drain controller. When provided, the
   * `POST`/`GET /api/v1/admin/orchestrator/drain` routes are mounted (backing
   * the `kici-admin orchestrator drain` verbs). Omitted on WS-only admins.
   */
  drainController?: DrainController;
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
  /**
   * Optional -- resolves the org-scoped GitHub webhook URL for the manifest
   * setup pre-flight (before any App exists). Wired in platform/hybrid mode.
   */
  resolveGithubWebhookUrl?: () => Promise<{ webhookUrl: string | null; webhookNote?: string }>;
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
  /**
   * Optional -- fulfil deferred attestations on demand (mints in the running
   * orchestrator process, which owns the Platform WS). Backs
   * `POST /api/v1/admin/attestations/retry` (the `kici-admin attestations retry`
   * command). Unset on a WS-only / non-coordinator admin.
   */
  retryAttestations?: (opts: {
    runId?: string;
    includeRejected?: boolean;
  }) => Promise<{ minted: number; stillPending: number; rejected: number }>;
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
  // Optional absolute expiry (ISO datetime). Omitted = never expires.
  expiresAt: z.string().datetime().optional(),
});

const createAgentTokenSchema = z.object({
  labels: z.array(z.string()).optional(),
  mandatoryLabels: z.array(z.string()).optional(),
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
  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin',
  });
  app.use('/api/v1/agent-tokens', authMiddleware);
  app.use('/api/v1/agent-tokens/*', authMiddleware);
  app.use('/api/v1/admin/*', authMiddleware);

  // ── Scoped secret CRUD ─────────────────────────────────────────
  // Secret scopes and routing keys are disjoint namespaces: a routing key is
  // `<provider>:<id>`, while a secret scope is a path in a backend namespace
  // whose `:` is the backend qualifier. Stores are addressed with the bare
  // path; `secrets/scope-routing.ts` owns the split. There is no
  // per-routing-key slice of the secret store, so every secret route requires
  // an unscoped admin token.

  /**
   * Load the registered secret backends for one request.
   *
   * A registry failure propagates to a 5xx rather than degrading to the
   * default store. `secrets/scope-routing.ts` owns the loading rules — see
   * `loadRoutableStores` for why the `pg` entry is always `deps.secretStore`.
   */
  const loadStores = (): Promise<Map<string, ScopedSecretStore>> =>
    loadRoutableStores<ScopedSecretStore, AuditLogger>(
      deps.backendRegistry,
      deps.auditLogger,
      deps.secretStore,
    );

  /** Resolve a wire-form scope against the live backend registry. */
  const routeScope = async (wireScope: string) =>
    resolveScope(wireScope, await loadStores(), deps.secretStore);

  // List scopes for an org
  app.get('/api/v1/admin/secrets/scopes', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      if (c.req.query('allBackends') !== 'true') {
        // Default: bare, pg-only. Byte-identical to the historical response —
        // cross-backend aggregation is opt-in until the default flips at v1.0.0
        // (see docs/user/deprecations.md).
        const scopes = await deps.secretStore.listScopes(orgId);
        return c.json({ scopes }, 200);
      }
      const stores = await loadStores();
      const scopes: string[] = [];
      for (const [backendName, store] of stores) {
        try {
          for (const path of await store.listScopes(orgId)) {
            scopes.push(toWireScope(backendName, path));
          }
        } catch (err) {
          // One unreachable backend must not blank the whole listing — the
          // operator still needs to see the backends that ARE reachable.
          logger.warn('Skipping unreachable secret backend during scope listing', {
            backendName,
            error: toErrorMessage(err),
          });
        }
      }
      scopes.sort();
      return c.json({ scopes }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List secret key names in a scope (no values)
  app.get('/api/v1/admin/secrets/keys', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      const scope = c.req.query('scope');
      if (!orgId || !scope) return c.json({ error: 'orgId and scope required' }, 400);
      const resolved = await routeScope(scope);
      const keys = await resolved.store.listKeys(orgId, resolved.path);
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
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = z.object({ orgId: z.string(), scope: z.string() }).parse(body);
      const resolved = await routeScope(parsed.scope);
      const scopeError = validateScopeName(resolved.path);
      if (scopeError) return c.json({ error: scopeError }, 400);
      if (!resolved.store.createScope) {
        return c.json(
          { error: `Backend '${resolved.backendName}' does not support scope creation` },
          400,
        );
      }
      await resolved.store.createScope(parsed.orgId, resolved.path);
      return c.json({ created: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Rename scope
  app.put('/api/v1/admin/secrets/scopes/rename', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = z
        .object({ orgId: z.string(), oldScope: z.string(), newScope: z.string() })
        .parse(body);
      const stores = await loadStores();
      const from = resolveScope(parsed.oldScope, stores, deps.secretStore);
      const to = resolveScope(parsed.newScope, stores, deps.secretStore);
      // A rename is a per-backend operation — the source store re-encrypts each
      // row under the new scope's AAD. Moving a scope BETWEEN backends is a
      // copy plus a delete, which this route does not perform, so reject it
      // outright rather than silently renaming inside the source backend.
      if (from.backendName !== to.backendName) {
        return c.json(
          {
            error:
              `Cannot rename a scope across backends ` +
              `('${from.backendName}' -> '${to.backendName}'). ` +
              `Recreate the secrets in the destination backend instead.`,
          },
          400,
        );
      }
      // Validate only the destination name — renaming a pre-existing malformed
      // scope to a conforming one is the built-in cleanup path.
      const scopeError = validateScopeName(to.path);
      if (scopeError) return c.json({ error: scopeError }, 400);
      if (!from.store.renameScope) {
        return c.json(
          { error: `Backend '${from.backendName}' does not support scope rename` },
          400,
        );
      }
      await from.store.renameScope(parsed.orgId, from.path, to.path);
      return c.json({ renamed: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Delete scope and all its secrets
  app.delete('/api/v1/admin/secrets/scopes/:orgId/:scope', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.delete');
      const orgId = c.req.param('orgId');
      const scope = c.req.param('scope');
      const resolved = await routeScope(scope);
      if (!resolved.store.deleteScope) {
        return c.json(
          { error: `Backend '${resolved.backendName}' does not support scope deletion` },
          400,
        );
      }
      await resolved.store.deleteScope(orgId, resolved.path);
      return c.json({ deleted: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Set scoped secret
  app.put('/api/v1/admin/secrets/:orgId/:scope/:key', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = await c.req.json();
      const parsed = setScopedSecretSchema.parse(body);
      const orgId = c.req.param('orgId');
      const scope = c.req.param('scope');
      const key = c.req.param('key');
      const resolved = await routeScope(scope);
      const scopeError = validateScopeName(resolved.path);
      if (scopeError) return c.json({ error: scopeError }, 400);
      // Write-path only. A `:` in the key would make the at-rest AAD
      // `orgId:scope:key` ambiguous, so two locations could share one binding.
      // Read and delete stay unvalidated so a key stored before this rule
      // remains readable and deletable.
      const keyError = validateSecretKey(key);
      if (keyError) return c.json({ error: keyError }, 400);
      await resolved.store.setSecret(orgId, resolved.path, key, parsed.value);

      await deps.auditLogger.log({
        action: 'setSecret',
        // The scope exactly as the caller sent it. The audit filter matches
        // `context_name` exactly, so normalising an unqualified scope into its
        // `pg:` form would hide the row from `kici-admin audit --context <s>`
        // and split one scope's history across two spellings at the upgrade.
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
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'secret.delete');
      const orgId = c.req.param('orgId');
      const scope = c.req.param('scope');
      const key = c.req.param('key');
      const resolved = await routeScope(scope);
      await resolved.store.deleteSecret(orgId, resolved.path, key);

      await deps.auditLogger.log({
        action: 'deleteSecret',
        // Recorded exactly as the caller sent it — see setSecret above.
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
      // Third sweep: external secret-backend configs, in their own transaction
      // so a backend bug can't roll back a good scoped_secrets rotation. Same
      // skip-and-count discipline as the config sweep.
      const backendsResult = deps.backendRegistry
        ? await deps.backendRegistry.rotateKey()
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
          reEncryptedBackends: backendsResult.reEncrypted,
          skippedBackends: backendsResult.skipped,
        },
      });
      return c.json(
        {
          reEncrypted: secretsResult.reEncrypted,
          reEncryptedConfigs: configsResult.reEncrypted,
          skippedConfigs: configsResult.skipped,
          reEncryptedBackends: backendsResult.reEncrypted,
          skippedBackends: backendsResult.skipped,
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
        parsed.expiresAt ? new Date(parsed.expiresAt) : undefined,
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
        mandatoryLabels: parsed.mandatoryLabels,
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
        resolveGithubWebhookUrl: deps.resolveGithubWebhookUrl,
        mode: deps.mode,
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
      createOrgSettingsRoutes({
        db: deps.db,
        rbac: deps.rbac,
        accessLog: deps.accessLog,
        globalWorkflowsEnabledDefault: deps.globalWorkflowsEnabledDefault ?? false,
      }),
    );
  }

  // Mount trust-policy routes (optional -- only when db is provided).
  // Backs the `kici-admin trust-policy {show,set}` subcommands. PATCH refuses
  // server-side on a Platform-attached orchestrator, where the Platform owns
  // the policy and the next push would clobber a local write.
  // The audit sink is part of the mount condition, not an optional extra: the
  // route's contract is that a trust-policy write is always attributable, so an
  // orchestrator assembled without an access log gets NO trust-policy route
  // rather than an unauditable one. A wired orchestrator always has one
  // (`accessLogWriter` is non-optional on the subsystem bundle), so this only
  // ever bites a partially-constructed test harness.
  if (deps.db && deps.accessLog) {
    const accessLog = deps.accessLog;
    app.route(
      '/api/v1/admin',
      createTrustPolicyRoutes({
        store: new TrustPolicyStore(deps.db),
        rbac: deps.rbac,
        mode: deps.mode ?? 'platform',
        accessLog,
      }),
    );
  }

  // Mount cluster-settings routes (optional -- only when db is provided).
  // Backs the `kici-admin cluster-settings {show,set,reset}` subcommands (the
  // fleet-wide tunables on cluster_settings).
  if (deps.db) {
    app.route('/api/v1/admin', createClusterSettingsRoutes({ db: deps.db, rbac: deps.rbac }));
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

  // Mount orchestrator drain routes (drain/resume/status for pre-upgrade
  // quiescing). Optional -- only when the coordinator drain controller is wired.
  if (deps.drainController) {
    app.route(
      '/api/v1/admin',
      createOrchestratorDrainRoutes({ drainController: deps.drainController, rbac: deps.rbac }),
    );
  }

  // Mount the deferred-attestation retry route. Optional -- only when the
  // retrier is wired (coordinator with a Platform connection).
  if (deps.retryAttestations) {
    const retry = deps.retryAttestations;
    app.post('/api/v1/admin/attestations/retry', async (c) => {
      let runId: string | undefined;
      let includeRejected = false;
      try {
        const raw = (await c.req.json().catch(() => ({}))) as {
          runId?: unknown;
          includeRejected?: unknown;
        };
        runId = typeof raw.runId === 'string' && raw.runId.length > 0 ? raw.runId : undefined;
        includeRejected = raw.includeRejected === true;
      } catch {
        runId = undefined;
      }
      try {
        // Cluster-wide mutating op: draining / re-arming the deferred-attestation
        // outbox affects the whole orchestrator, so require an unscoped token and
        // the dedicated attestation.retry permission (owner+admin, not auditor).
        const denied = requireUnscopedToken(c);
        if (denied) return denied;
        deps.rbac.requirePermission(c.get('role'), 'attestation.retry');
        const result = await retry({ ...(runId ? { runId } : {}), includeRejected });
        // Audit every retry — especially the include_rejected re-arm, which
        // clears a terminal rejection marker.
        await deps.accessLog?.record({
          orgId: null,
          routingKey: null,
          actor: { type: 'service_account' as const, id: c.get('userId') as string },
          action: 'attestation.retry',
          target: { type: 'attestation', id: runId ?? 'all-pending' },
          requestId: null,
          source: 'admin_http',
          outcome: 'allowed',
          meta: {
            include_rejected: includeRejected,
            run_id: runId ?? null,
            minted: result.minted,
            still_pending: result.stillPending,
            rejected: result.rejected,
          },
        });
        return c.json(result);
      } catch (err) {
        return handleError(c, err);
      }
    });
  }

  // Mount context management routes (create/bind/set-policy/list/show/template).
  // Optional -- only when db is provided.
  if (deps.db) {
    app.route('/api/v1/admin', createAdminContextRoutes({ db: deps.db, rbac: deps.rbac }));
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
