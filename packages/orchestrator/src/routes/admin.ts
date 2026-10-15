/**
 * Admin API routes: contexts, secrets, tokens, audit log queries and key
 * rotation, all behind Bearer token authentication and RBAC permission checks.
 *
 * Secret values are write-only: there is deliberately no "get secret value"
 * endpoint. Values are only read during dispatch resolution.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { enforceRoutingKeyScope, requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import type { AuditLogger } from '../secrets/audit-logger.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { SharedConfigStore } from '../config/shared-store.js';
import type { ResolvedMasterKeys } from '../secrets/config.js';
import { rotateMasterKeyWrappedTables } from '../secrets/master-key-rotation.js';
import { createSourceRoutes } from './admin-sources.js';
import { createDbRoutes } from './admin-db.js';
import { createBackendRoutes } from './admin-backends.js';
import { createOrgSettingsRoutes } from './admin-org-settings.js';
import { createTrustPolicyRoutes } from './admin-trust-policy.js';
import { createHeldRunRoutes, type HeldRunReleaseWiring } from './admin-held-runs.js';
import { HeldRunStore } from '../contexts/held-runs.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import {
  createClusterSettingsRoutes,
  type ClusterSettingsPropagationSource,
} from './admin-cluster-settings.js';
import { createClusterNameRoutes } from './admin-cluster-name.js';
import { createAdminSigningKeyRoutes } from './admin-signing-keys.js';
import { createAdminOrgRoutes } from './admin-orgs.js';
import { listHeldOrgIds } from '../db/repos/org-ids-repo.js';
import { createMaintenanceRoutes } from './admin-maintenance.js';
import { createOrchestratorDrainRoutes } from './admin-orchestrator-drain.js';
import { createScalerOrphansRoutes, type ScalerOrphansRouteDeps } from './admin-scaler-orphans.js';
import { createPeerForgetRoutes, type PeerForgetRouteDeps } from './admin-peer-forget.js';
import { createScalerReloadRoutes, type ScalerReloadRouteDeps } from './admin-scaler-reload.js';
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
import type { WebhookUrlResolution } from '../sources/webhook-url-resolvers.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-api' });

export interface AdminRouteDeps {
  tokenManager: TokenManager;
  /**
   * Connection string for the DB migration routes, which run schema work on
   * their own timeout-free pool. When omitted (WS-only / test admins) those
   * routes fall back to the shared pool.
   */
  databaseUrl?: string;
  /** Gates mode-specific admin behavior. Omitted by WS-only / test admins. */
  mode?: OrchestratorMode;
  /**
   * Whether the Platform connection is up right now, read per request. The
   * trust-policy directory route reports it so an operator can tell a directory
   * that is merely old from one that cannot refresh at all. Absent on an
   * independent orchestrator and on a test admin, which have no connection.
   */
  platformConnected?: () => boolean;
  /**
   * The org the Platform named on `auth.success`, read per request; `undefined`
   * before the first authentication. Backs the attachment `GET /org-ids` reports.
   * Absent on an independent orchestrator and on a test admin.
   */
  getPlatformOrgId?: () => string | undefined;
  rbac: RbacEnforcer;
  secretStore: PgSecretStore;
  auditLogger: AuditLogger;
  /**
   * Fleet-wide default for the global-workflows master switch, applied when the
   * cluster column is NULL. Omitted means the secure default (disabled).
   */
  globalWorkflowsEnabledDefault?: boolean;
  /**
   * When provided, mounts `POST`/`GET /api/v1/admin/orchestrator/drain` (the
   * `kici-admin orchestrator drain` verbs). Omitted on WS-only admins.
   */
  drainController?: DrainController;
  /** Backs the agent token CRUD endpoints. */
  tokenStore?: AgentTokenStore;
  /**
   * DELETE /api/v1/agent-tokens/:id calls `agentRegistry.disconnectByTokenId(id)`
   * synchronously after `tokenStore.revoke(id)` so a revoked token loses
   * data-plane authority immediately instead of staying live until the agent
   * disconnects. Mirrors the orch->Platform leg (`disconnectByKeyId`).
   *
   * When unset, the DELETE route returns 503: without the kick path a revoked
   * token would still grant in-flight authority for hours-to-days.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Fans the revoke out to every peer in a clustered orchestrator. The DELETE
   * route calls it after the synchronous local kick, so each peer's
   * `AgentRegistry.disconnectByTokenId(tokenId)` closes its own in-flight WS for
   * the same token. Mirrors the Valkey fan-out pattern on the orch->Platform leg.
   *
   * Unset on standalone deployments (no peer fabric), where the local kick
   * alone is sufficient.
   */
  broadcastAgentTokenRevoke?: (tokenId: string) => void;
  /** Backs the source management endpoints. */
  sourceStore?: SourceStore;
  /**
   * Resolves the public webhook URL for a newly added source so
   * `kici-admin source add` can print it. The rules per mode live in
   * `sources/webhook-url-resolvers.ts`.
   */
  resolveSourceWebhookUrl?: (params: {
    routingKey: string;
    provider: string;
    sourceId: string;
  }) => Promise<WebhookUrlResolution>;
  /**
   * Resolves the org-scoped GitHub webhook URL for the manifest setup
   * pre-flight (before any App exists), by mode.
   */
  resolveGithubWebhookUrl?: () => Promise<WebhookUrlResolution>;
  /** Builds the direct-ingress URL `source list` prints per GitHub source. */
  resolveSourceIngressUrl?: (row: { id: string; customerId: string | null }) => string | null;
  /** Backs the DB migration endpoints. */
  db?: Kysely<any>;
  /** Backs the DB migration endpoints. */
  pool?: pg.Pool;
  /** Backs cluster join token creation. */
  joinTokenManager?: JoinTokenManager;
  /** Backs the secret backend management endpoints. */
  backendRegistry?: BackendRegistry;
  backendHealthChecker?: BackendHealthChecker;
  backendSyncManager?: BackendSyncManager;
  /**
   * When set, `POST /api/v1/admin/rotate-key` re-encrypts `config_versions`
   * alongside `scoped_secrets` in two sequential transactions. When unset (e.g.
   * a secret-store-only admin deployment), config rotation is skipped and the
   * response reports `reEncryptedConfigs: 0`.
   */
  sharedStore?: SharedConfigStore;
  /**
   * When set, `POST /api/v1/admin/rotate-key` also sweeps the remaining
   * master-key-wrapped stores: `orchestrator_signing_keys`,
   * `dashboard_encryption_keys`, `run_ephemeral_keys`, `run_secret_outputs` and the
   * sealed job secrets in `pending_job_contexts`.
   * When unset the secrets subsystem is off and there is nothing wrapped to
   * sweep, so those counts report 0.
   */
  masterKeys?: ResolvedMasterKeys | null;
  /**
   * Attribution writer for routes that emit an `access_log` row directly
   * (today: org-settings dashboard-write policy flips). When unset, those
   * routes run the mutation without recording: the write is best-effort, never
   * gating.
   */
  accessLog?: AccessLogWriter;
  /**
   * The coordinator's live-VM listing and stop, for this node or a `--target`
   * peer. Backs `GET /api/v1/admin/scaler/orphans` and
   * `POST /api/v1/admin/scaler/orphans/stop` (`kici-admin scaler orphans`).
   * Bound by orchestrator-core once the cluster is up.
   */
  scalerOrphans?: ScalerOrphansRouteDeps;
  /**
   * Reloads the scaler config here and on every connected peer. Backs
   * `POST /api/v1/admin/scaler/reload` (`kici-admin scaler reload`). Bound by
   * orchestrator-core once the cluster is up.
   */
  scalerReload?: ScalerReloadRouteDeps;
  /**
   * Forgets a departed peer here and on every connected sibling coordinator.
   * Backs `POST /api/v1/admin/peers/forget` (`kici-admin peer forget`). Bound by
   * orchestrator-core once the cluster is up.
   */
  peerForget?: PeerForgetRouteDeps;
  /**
   * The peer view behind `GET /api/v1/admin/cluster-settings/propagation` (the
   * propagation section of `kici-admin cluster-settings show`). Bound by
   * orchestrator-core once the cluster is up; the route is not mounted without it.
   */
  clusterSettingsPropagation?: ClusterSettingsPropagationSource;
  /**
   * Fulfils deferred attestations on demand (mints in the running orchestrator
   * process, which owns the Platform WS). Backs
   * `POST /api/v1/admin/attestations/retry` (`kici-admin attestations retry`).
   * Unset on a WS-only / non-coordinator admin.
   */
  retryAttestations?: (opts: {
    runId?: string;
    includeRejected?: boolean;
  }) => Promise<{ minted: number; stillPending: number; rejected: number }>;
  /**
   * The resume wiring behind `kici-admin held-run approve|reject`. When set
   * (alongside `db` + `accessLog`), the local held-run read and decision routes
   * are mounted; they refuse with 409 on a Platform-attached orchestrator. Unset
   * leaves them unmounted, the honest state for an app that cannot dispatch a
   * released hold.
   */
  heldRunRelease?: HeldRunReleaseWiring;
}

const setScopedSecretSchema = z.object({
  value: z.string(),
});

const createTokenSchema = z.object({
  label: z.string().min(1).max(255),
  role: z.enum(['owner', 'admin', 'auditor']),
  routingKey: z.string().nullable().optional(),
  // Optional absolute expiry (ISO datetime). Omitted = never expires.
  expiresAt: z.string().datetime().optional(),
  // Optional intended holder (an OIDC `sub` or an email). Advisory metadata the
  // orchestrator cannot verify and never authorizes against; it is the join key
  // the Platform's RBAC drift report reads. Omitted leaves the token unlinked.
  subject: z.string().min(1).max(255).nullable().optional(),
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

/** Admin routes under /api/v1/admin/* (and /api/v1/agent-tokens), Bearer-authed with RBAC. */
export function createAdminRoutes(deps: AdminRouteDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

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
   * Loads the registered secret backends for one request. A registry failure
   * propagates to a 5xx rather than degrading to the default store; see
   * `loadRoutableStores` for why the `pg` entry is always `deps.secretStore`.
   */
  const loadStores = (): Promise<Map<string, ScopedSecretStore>> =>
    loadRoutableStores<ScopedSecretStore, AuditLogger>(
      deps.backendRegistry,
      deps.auditLogger,
      deps.secretStore,
    );

  const routeScope = async (wireScope: string) =>
    resolveScope(wireScope, await loadStores(), deps.secretStore);

  // Each scope is qualified as `<backend>:<path>`.
  app.get('/api/v1/admin/secrets/scopes', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.read');
    const orgId = c.req.query('orgId');
    if (!orgId) return c.json({ error: 'orgId required' }, 400);
    const stores = await loadStores();
    const scopes: string[] = [];
    for (const [backendName, store] of stores) {
      try {
        for (const path of await store.listScopes(orgId)) {
          scopes.push(toWireScope(backendName, path));
        }
      } catch (err) {
        // One unreachable backend must not blank the listing of the reachable ones.
        logger.warn('Skipping unreachable secret backend during scope listing', {
          backendName,
          error: toErrorMessage(err),
        });
      }
    }
    scopes.sort();
    return c.json({ scopes }, 200);
  });

  // Key names only, never values.
  app.get('/api/v1/admin/secrets/keys', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.read');
    const orgId = c.req.query('orgId');
    const scope = c.req.query('scope');
    if (!orgId || !scope) return c.json({ error: 'orgId and scope required' }, 400);
    const resolved = await routeScope(scope);
    const keys = await resolved.store.listKeys(orgId, resolved.path);
    return c.json({ keys }, 200);
  });

  // ── Scope CRUD (registered before generic :orgId/:scope/:key routes
  //    to avoid Hono's LinearRouter matching "scopes" as :orgId) ──

  app.post('/api/v1/admin/secrets/scopes', requireUnscoped, async (c) => {
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

    await deps.auditLogger.log({
      action: 'createScope',
      // Recorded exactly as the caller sent it — see setSecret below.
      contextName: parsed.scope,
      routingKey: null,
      secretKeys: null,
      outcome: 'allowed',
      runId: null,
      jobId: null,
      userId: c.get('userId'),
      role: c.get('role'),
      metadata: { orgId: parsed.orgId },
    });

    return c.json({ created: true }, 200);
  });

  app.put('/api/v1/admin/secrets/scopes/rename', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.write');
    const body = await c.req.json();
    const parsed = z
      .object({ orgId: z.string(), oldScope: z.string(), newScope: z.string() })
      .parse(body);
    const stores = await loadStores();
    const from = resolveScope(parsed.oldScope, stores, deps.secretStore);
    const to = resolveScope(parsed.newScope, stores, deps.secretStore);
    // A rename is per-backend: the source store re-encrypts each row under the
    // new scope's AAD. A cross-backend move is a copy plus a delete, which this
    // route does not do, so reject it rather than silently renaming inside the
    // source backend.
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
      return c.json({ error: `Backend '${from.backendName}' does not support scope rename` }, 400);
    }
    await from.store.renameScope(parsed.orgId, from.path, to.path);

    await deps.auditLogger.log({
      action: 'renameScope',
      // The row files under the scope's old name, so `kici-admin audit
      // --context <old>` ends that scope's history with the rename; the new
      // name rides in the metadata.
      contextName: parsed.oldScope,
      routingKey: null,
      secretKeys: null,
      outcome: 'allowed',
      runId: null,
      jobId: null,
      userId: c.get('userId'),
      role: c.get('role'),
      metadata: { orgId: parsed.orgId, newScope: parsed.newScope },
    });

    return c.json({ renamed: true }, 200);
  });

  app.delete('/api/v1/admin/secrets/scopes/:orgId/:scope', requireUnscoped, async (c) => {
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

    await deps.auditLogger.log({
      action: 'deleteScope',
      // Recorded exactly as the caller sent it — see setSecret below.
      contextName: scope,
      routingKey: null,
      secretKeys: null,
      outcome: 'allowed',
      runId: null,
      jobId: null,
      userId: c.get('userId'),
      role: c.get('role'),
      metadata: { orgId },
    });

    return c.json({ deleted: true }, 200);
  });

  app.put('/api/v1/admin/secrets/:orgId/:scope/:key', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.write');
    const body = await c.req.json();
    const parsed = setScopedSecretSchema.parse(body);
    const orgId = c.req.param('orgId');
    const scope = c.req.param('scope');
    const key = c.req.param('key');
    const resolved = await routeScope(scope);
    const scopeError = validateScopeName(resolved.path);
    if (scopeError) return c.json({ error: scopeError }, 400);
    // Write-path only: a `:` in the key would make the at-rest AAD
    // `orgId:scope:key` ambiguous, so two locations could share one binding.
    // Read and delete stay unvalidated so an older key remains readable and
    // deletable.
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
  });

  app.delete('/api/v1/admin/secrets/:orgId/:scope/:key', requireUnscoped, async (c) => {
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
  });

  // ── Key rotation ────────────────────────────────────────────────

  app.post('/api/v1/admin/rotate-key', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'key.rotate');
    // Secrets first, then config, in separate transactions so a config-rotation
    // bug can't roll back a successful secrets rotation. Both are idempotent, so
    // on partial failure the operator re-runs `rotate-key`.
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
    // The master-key-wrapped stores: the provenance signing key, the
    // dashboard-encryption key, run ephemeral keys, stored secret outputs and
    // the sealed secrets of stored jobs, each in its own transaction for the
    // same reason. Skipping them makes rotation destructive: dropping the old
    // key strands every one, and for the signing key the next boot throws.
    const wrapped =
      deps.masterKeys && deps.db
        ? await rotateMasterKeyWrappedTables(deps.db, deps.masterKeys, (message, meta) =>
            logger.warn(message, meta),
          )
        : {
            signingKeys: { reEncrypted: 0, skipped: 0 },
            dashboardKeys: { reEncrypted: 0, skipped: 0 },
            ephemeralKeys: { reEncrypted: 0, skipped: 0 },
            secretOutputs: { reEncrypted: 0, skipped: 0 },
            jobSecrets: { reEncrypted: 0, skipped: 0 },
          };
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
        reEncryptedSigningKeys: wrapped.signingKeys.reEncrypted,
        skippedSigningKeys: wrapped.signingKeys.skipped,
        reEncryptedDashboardKeys: wrapped.dashboardKeys.reEncrypted,
        skippedDashboardKeys: wrapped.dashboardKeys.skipped,
        reEncryptedEphemeralKeys: wrapped.ephemeralKeys.reEncrypted,
        skippedEphemeralKeys: wrapped.ephemeralKeys.skipped,
        reEncryptedSecretOutputs: wrapped.secretOutputs.reEncrypted,
        skippedSecretOutputs: wrapped.secretOutputs.skipped,
        reEncryptedJobSecrets: wrapped.jobSecrets.reEncrypted,
        skippedJobSecrets: wrapped.jobSecrets.skipped,
      },
    });
    return c.json(
      {
        reEncrypted: secretsResult.reEncrypted,
        reEncryptedConfigs: configsResult.reEncrypted,
        skippedConfigs: configsResult.skipped,
        reEncryptedBackends: backendsResult.reEncrypted,
        skippedBackends: backendsResult.skipped,
        reEncryptedSigningKeys: wrapped.signingKeys.reEncrypted,
        skippedSigningKeys: wrapped.signingKeys.skipped,
        reEncryptedDashboardKeys: wrapped.dashboardKeys.reEncrypted,
        skippedDashboardKeys: wrapped.dashboardKeys.skipped,
        reEncryptedEphemeralKeys: wrapped.ephemeralKeys.reEncrypted,
        skippedEphemeralKeys: wrapped.ephemeralKeys.skipped,
        reEncryptedSecretOutputs: wrapped.secretOutputs.reEncrypted,
        skippedSecretOutputs: wrapped.secretOutputs.skipped,
        reEncryptedJobSecrets: wrapped.jobSecrets.reEncrypted,
        skippedJobSecrets: wrapped.jobSecrets.skipped,
      },
      200,
    );
  });

  // ── Audit log ───────────────────────────────────────────────────

  app.get('/api/v1/admin/audit', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'audit.read');
    const tokenRoutingKey = c.get('routingKey');
    const requestedRoutingKey = c.req.query('routingKey') ?? undefined;
    // A routing-key-scoped token reads only its own routing key's rows: refuse
    // a different requested key, and force the filter so an unfiltered query
    // can't leak other routing keys' rows.
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
  });

  // ── Token management ────────────────────────────────────────────

  app.post('/api/v1/admin/tokens', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'token.manage');
    const body = await c.req.json();
    const parsed = createTokenSchema.parse(body);
    const result = await deps.tokenManager.generateToken(
      parsed.label,
      parsed.role,
      parsed.routingKey,
      parsed.expiresAt ? new Date(parsed.expiresAt) : undefined,
      parsed.subject,
    );
    return c.json({ token: result.token, id: result.id }, 201);
  });

  // Hashes are never returned.
  app.get('/api/v1/admin/tokens', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'token.manage');
    const tokens = await deps.tokenManager.listTokens();
    return c.json({ tokens }, 200);
  });

  app.delete('/api/v1/admin/tokens/:id', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'token.manage');
    await deps.tokenManager.revokeToken(c.req.param('id'));
    return c.json({ revoked: true }, 200);
  });

  // ── Agent token CRUD ──────────────────────────────────────────────

  app.post('/api/v1/agent-tokens', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
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
  });

  // Non-revoked tokens only.
  app.get('/api/v1/agent-tokens', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
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
  });

  app.delete('/api/v1/agent-tokens/:id', async (c) => {
    if (!deps.tokenStore) {
      return c.json({ error: 'Agent token management not available' }, 503);
    }
    if (!deps.agentRegistry) {
      // Without the kick path the DB row would flip but every in-flight WS
      // authenticated by this token would keep data-plane authority until it
      // disconnected, so refuse rather than report success.
      return c.json({ error: 'Agent registry not available' }, 503);
    }
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    deps.rbac.requirePermission(c.get('role'), 'token.manage');
    const id = c.req.param('id');
    const revoked = await deps.tokenStore.revoke(id);
    if (!revoked) {
      return c.json({ error: 'Agent token not found or already revoked' }, 404);
    }
    // Kick synchronously before responding so the CLI's feedback reflects what
    // actually happened on the wire.
    const kicked = deps.agentRegistry.disconnectByTokenId(id);
    // Each peer kicks its own in-flight WS; unset on standalone deployments.
    deps.broadcastAgentTokenRevoke?.(id);
    logger.info('Agent token revoked', { tokenId: id, kicked });
    return c.json({ kicked }, 200);
  });

  // ── Join token management ──────────────────────────────────────────

  // For cluster bootstrap.
  app.post('/api/v1/admin/join-tokens', async (c) => {
    if (!deps.joinTokenManager) {
      return c.json({ error: 'Join token management not available' }, 503);
    }
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

    const expiryMs = parsed.expiryMs ?? 3600_000;
    const expiresAt = new Date(Date.now() + expiryMs).toISOString();

    return c.json({ token, expiresAt }, 201);
  });

  if (deps.sourceStore) {
    app.route(
      '/api/v1/admin',
      createSourceRoutes({
        sourceStore: deps.sourceStore,
        resolveSourceWebhookUrl: deps.resolveSourceWebhookUrl,
        resolveGithubWebhookUrl: deps.resolveGithubWebhookUrl,
        resolveSourceIngressUrl: deps.resolveSourceIngressUrl,
      }),
    );
  }

  if (deps.db && deps.pool) {
    app.route(
      '/api/v1/admin',
      createDbRoutes({ db: deps.db, pool: deps.pool, databaseUrl: deps.databaseUrl }),
    );
  }

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

  // Backs the `kici-admin org-settings global-workflows` subcommands.
  if (deps.db) {
    app.route(
      '/api/v1/admin',
      createOrgSettingsRoutes({
        db: deps.db,
        rbac: deps.rbac,
        accessLog: deps.accessLog,
        globalWorkflowsEnabledDefault: deps.globalWorkflowsEnabledDefault ?? false,
        mode: deps.mode ?? 'platform',
      }),
    );
  }

  // Backs `kici-admin trust-policy {show,set,directory}`. PATCH refuses
  // server-side on a Platform-attached orchestrator, where the Platform owns the
  // policy and the next push would clobber a local write.
  // The audit sink is part of the mount condition: a trust-policy write is
  // always attributable, so without an access log there is NO trust-policy
  // route rather than an unauditable one. A wired orchestrator always has one
  // (`accessLogWriter` is non-optional on the subsystem bundle), so this only
  // bites a partially-constructed test harness.
  if (deps.db && deps.accessLog) {
    const accessLog = deps.accessLog;
    app.route(
      '/api/v1/admin',
      createTrustPolicyRoutes({
        store: new TrustPolicyStore(deps.db),
        directory: new TrustDirectoryStore(deps.db),
        rbac: deps.rbac,
        mode: deps.mode ?? 'platform',
        ...(deps.platformConnected && { platformConnected: deps.platformConnected }),
        accessLog,
      }),
    );
  }

  // Backs `kici-admin held-run {list,approve,reject}`, which refuse server-side
  // on a Platform-attached orchestrator, where the Platform's own held-run trust
  // gate is the authority.
  // The resume wiring is part of the mount condition: without it an approve
  // would flip the row and never dispatch the released job, which reads as
  // success and does nothing. The audit sink is in it as on the trust-policy
  // route: an unattributed local answer is worse than no answer at all.
  if (deps.db && deps.accessLog && deps.heldRunRelease) {
    app.route(
      '/api/v1/admin',
      createHeldRunRoutes({
        store: new HeldRunStore(deps.db),
        directory: new TrustDirectoryStore(deps.db),
        db: deps.db,
        rbac: deps.rbac,
        mode: deps.mode ?? 'platform',
        accessLog: deps.accessLog,
        release: deps.heldRunRelease,
      }),
    );
  }

  // Backs `kici-admin cluster-settings {show,set,reset}` (the fleet-wide
  // tunables on cluster_settings).
  if (deps.db) {
    app.route(
      '/api/v1/admin',
      createClusterSettingsRoutes({
        db: deps.db,
        rbac: deps.rbac,
        propagation: deps.clusterSettingsPropagation,
      }),
    );
  }

  // Backs `kici-admin cluster-name {get,set}`.
  if (deps.db) {
    app.route(
      '/api/v1/admin',
      createClusterNameRoutes({ db: deps.db, rbac: deps.rbac, accessLog: deps.accessLog }),
    );
  }

  // Provenance signing-key listing; backs `kici-admin signing-key list`.
  if (deps.db) {
    app.route('/api/v1/admin', createAdminSigningKeyRoutes({ db: deps.db, rbac: deps.rbac }));
  }

  // The org ids this orchestrator holds (`kici-admin org list`, the `Org:` line
  // of `kici-admin orchestrator status`).
  if (deps.db) {
    const db = deps.db;
    app.route(
      '/api/v1/admin',
      createAdminOrgRoutes({
        listOrgs: () => listHeldOrgIds(db),
        rbac: deps.rbac,
        ...(deps.getPlatformOrgId && { getPlatformOrgId: deps.getPlatformOrgId }),
      }),
    );
  }

  // Maintenance routes (queue clear, purge-stale, secrets purge); never on a
  // WS-only admin.
  if (deps.db) {
    app.route('/api/v1/admin', createMaintenanceRoutes({ db: deps.db }));
  }

  // Drain/resume/status for pre-upgrade quiescing.
  if (deps.drainController) {
    app.route(
      '/api/v1/admin',
      createOrchestratorDrainRoutes({ drainController: deps.drainController, rbac: deps.rbac }),
    );
  }

  // Live orphaned Firecracker VMs on this node or a --target peer
  // (`kici-admin scaler orphans`).
  if (deps.scalerOrphans) {
    app.route(
      '/api/v1/admin',
      createScalerOrphansRoutes({
        orphans: deps.scalerOrphans,
        rbac: deps.rbac,
        accessLog: deps.accessLog,
      }),
    );
  }

  // Reload the scaler config across the cluster (`kici-admin scaler reload`).
  if (deps.scalerReload) {
    app.route(
      '/api/v1/admin',
      createScalerReloadRoutes({
        scalerReload: deps.scalerReload,
        rbac: deps.rbac,
        accessLog: deps.accessLog,
      }),
    );
  }

  // Forget a departed peer (`kici-admin peer forget`).
  if (deps.peerForget) {
    app.route(
      '/api/v1/admin',
      createPeerForgetRoutes({
        peerForget: deps.peerForget,
        rbac: deps.rbac,
        accessLog: deps.accessLog,
      }),
    );
  }

  // Deferred-attestation retry; wired only on a coordinator with a Platform
  // connection.
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
      // Draining / re-arming the deferred-attestation outbox affects the whole
      // orchestrator, so require an unscoped token and the attestation.retry
      // permission (owner+admin, not auditor).
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
    });
  }

  // Context management (create/bind/set-policy/list/show/template).
  if (deps.db) {
    app.route('/api/v1/admin', createAdminContextRoutes({ db: deps.db, rbac: deps.rbac }));
  }

  // Queue and execution read routes.
  if (deps.db) {
    app.route('/api/v1/admin', createAdminQueueExecutionRoutes({ db: deps.db, rbac: deps.rbac }));
  }

  return app;
}
