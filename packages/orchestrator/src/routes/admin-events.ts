/**
 * Admin API CRUD for generic webhook sources (create, list, get, update,
 * delete, enable, disable) and cross-repo trust relationships. Every route
 * requires Bearer token auth, the admin auth middleware pattern from admin.ts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type pg from 'pg';
import type { GenericSourceManager } from '../webhook/generic-sources.js';
import type { TrustStore } from '../events/trust-store.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { UniversalGitConfigSchema } from '../providers/universal-git/config.js';
import { LocalSourceConfigSchema } from '../providers/local/local-source-config.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';
import type { AppConfig } from '../config.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import { registerProviderBundleForSource } from '../webhook/register-source-bundle.js';
import { createBearerAuthMiddleware } from './admin-auth.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-events' });

interface AdminEventRouteDeps {
  sourceManager: GenericSourceManager;
  trustStore: TrustStore;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /**
   * POST /generic-sources registers a local / universal-git bundle here right
   * after the row lands, so the next webhook resolves the right normalizer
   * without an orchestrator restart.
   */
  providerRegistry: ProviderRegistry;
  /** Passed through to `registerProviderBundleForSource` (universal-git bundle
   *  build reads cluster config; local bundles read the row's own git_config). */
  config: AppConfig;
  /** Required for universal-git source registration — `null` is allowed;
   *  rows with `git_config` are skipped + metric-bumped in that case. */
  secretResolver: SecretResolver | null;
  /** Fleet-wide settings reader; threads the live lock-file cap into newly-registered universal-git sources. */
  clusterSettings?: ClusterSettingsReader;
  /**
   * The Platform org id this orchestrator authenticated as; `undefined` in
   * independent mode or before authentication.
   *
   * A generic source mints `generic:<orgId>:<id>`, and the Platform refuses a
   * key naming another org, so a mismatched source would silently never
   * deliver and its webhook URL (composed from the Platform org id) would 404.
   * The create handler refuses the mismatch up front.
   */
  getPlatformOrgId?: () => string | undefined;
  /**
   * When set, mounts `POST /api/v1/admin/events/emit` (INSERT into `kici_events`
   * + `pg_notify` over HTTP). Mirrors `emitKiciEventDirect` in `@kici-dev/shared`
   * (direct-DB CLI mode).
   */
  pool?: pg.Pool;
}

const createSourceSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1).max(255),
  verificationMethod: z.enum(['hmac_sha256', 'bearer_token', 'ip_allowlist', 'none']).optional(),
  verificationConfig: z.record(z.string(), z.unknown()).optional(),
  eventTypeHeader: z.string().optional(),
  eventTypePath: z.string().optional(),
  idempotencyKeyHeader: z.string().optional(),
  idempotencyKeyPath: z.string().optional(),
  dedupWindowSeconds: z.number().int().positive().optional(),
  maxPayloadBytes: z.number().int().positive().optional(),
  allowedEvents: z.array(z.string()).optional(),
  stripHeaders: z.array(z.string()).optional(),
  rateLimitRpm: z.number().int().positive().optional(),
  providerType: z.enum(['generic', 'local']).optional(),
  /** Universal-git config. When set, source is cloneable + lock-file-aware. */
  gitConfig: UniversalGitConfigSchema.optional(),
  /** `{ repoBasePath, cloneUrlBase? }`, set with providerType='local'; stored in git_config. */
  localConfig: LocalSourceConfigSchema.optional(),
});

const updateSourceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  verificationMethod: z.enum(['hmac_sha256', 'bearer_token', 'ip_allowlist', 'none']).optional(),
  verificationConfig: z.record(z.string(), z.unknown()).optional(),
  eventTypeHeader: z.string().optional(),
  eventTypePath: z.string().optional(),
  idempotencyKeyHeader: z.string().optional(),
  idempotencyKeyPath: z.string().optional(),
  dedupWindowSeconds: z.number().int().positive().optional(),
  maxPayloadBytes: z.number().int().positive().optional(),
  allowedEvents: z.array(z.string()).optional(),
  stripHeaders: z.array(z.string()).optional(),
  rateLimitRpm: z.number().int().positive().optional(),
  providerType: z.enum(['generic', 'local']).optional(),
  /** `null` explicitly clears the config; omit the field to leave it untouched. */
  gitConfig: UniversalGitConfigSchema.nullable().optional(),
  /** `null` clears it; omit to leave untouched. */
  localConfig: LocalSourceConfigSchema.nullable().optional(),
});

const createTrustSchema = z.object({
  sourceRepo: z.string().min(1),
  sourceRoutingKey: z.string().min(1),
  targetRepo: z.string().min(1),
  targetRoutingKey: z.string().min(1),
  allowedEvents: z.array(z.string()).optional(),
});

/**
 * Body of `POST /api/v1/admin/events/emit`; mirrors `EmitKiciEventOpts` in
 * `@kici-dev/shared/db-admin.ts`. Arrays and primitives are rejected: the
 * codebase treats `kici_events.payload` (`jsonb`) as an object everywhere.
 */
const emitEventSchema = z.object({
  eventName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sourceRoutingKey: z.string().optional(),
  sourceRepo: z.string().optional(),
});

/** Routes mounted at /api/v1/admin/*. */
export function createAdminEventRoutes(deps: AdminEventRouteDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin-events',
  });
  app.use('/api/v1/admin/generic-sources', authMiddleware);
  app.use('/api/v1/admin/generic-sources/*', authMiddleware);
  app.use('/api/v1/admin/trust', authMiddleware);
  app.use('/api/v1/admin/trust/*', authMiddleware);

  // The new source mints a fresh `generic:<orgId>:<id>` routing key the caller
  // cannot pre-claim, so routing-key-scoped tokens are refused.
  app.post('/api/v1/admin/generic-sources', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.create');
    const body = await c.req.json();
    const parsed = createSourceSchema.parse(body);

    // Refuse, never silently rewrite: re-keying a source changes its public
    // webhook URL, which is the operator's call.
    const platformOrgId = deps.getPlatformOrgId?.();
    if (platformOrgId !== undefined && parsed.orgId !== platformOrgId) {
      return c.json(
        {
          error:
            `orgId "${parsed.orgId}" does not match this orchestrator's Platform ` +
            `organization "${platformOrgId}". A generic source's routing key embeds ` +
            `the organization, and the Platform rejects a key naming another one — ` +
            `the source would register, be rejected, and never deliver. ` +
            `Re-run with --org ${platformOrgId}.`,
        },
        400,
      );
    }

    const source = await deps.sourceManager.create(parsed);
    // Without this, until a restart a local source would 404 (registry miss)
    // and a universal-git source would take the plain-generic payload-only path.
    registerProviderBundleForSource(source, {
      providerRegistry: deps.providerRegistry,
      config: deps.config,
      secretResolver: deps.secretResolver,
      clusterSettings: deps.clusterSettings,
    });
    return c.json({ source }, 201);
  });

  // Routing-key-scoped tokens see only their own source within the org.
  app.get('/api/v1/admin/generic-sources', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.read');
    const orgId = c.req.query('orgId');
    if (!orgId) {
      return c.json({ error: 'Missing orgId query parameter' }, 400);
    }
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const all = await deps.sourceManager.list(orgId, includeDeleted);
    const tokenRoutingKey = c.get('routingKey');
    const sources = tokenRoutingKey ? all.filter((s) => s.routing_key === tokenRoutingKey) : all;
    return c.json({ sources }, 200);
  });

  app.get('/api/v1/admin/generic-sources/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.read');
    const source = await deps.sourceManager.getById(c.req.param('id'));
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, source.routing_key);
    if (denied) return denied;
    return c.json({ source }, 200);
  });

  app.patch('/api/v1/admin/generic-sources/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');
    const existing = await deps.sourceManager.getById(c.req.param('id'));
    if (!existing) {
      return c.json({ error: 'Source not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, existing.routing_key);
    if (denied) return denied;
    const body = await c.req.json();
    const parsed = updateSourceSchema.parse(body);
    const source = await deps.sourceManager.update(c.req.param('id'), parsed);
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
    // Refresh this peer's registry; unregister first handles a provider_type
    // flip back to plain 'generic'. Other peers follow via the migration-019
    // pg_notify + GenericSourcesChangeListener.
    deps.providerRegistry.unregister(source.routing_key);
    registerProviderBundleForSource(source, {
      providerRegistry: deps.providerRegistry,
      config: deps.config,
      secretResolver: deps.secretResolver,
      clusterSettings: deps.clusterSettings,
    });
    return c.json({ source }, 200);
  });

  // Delete source (soft delete by default, hard delete with ?hard=true)
  app.delete('/api/v1/admin/generic-sources/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.delete');
    const id = c.req.param('id');
    const hard = c.req.query('hard') === 'true';

    const source = await deps.sourceManager.getById(id);
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, source.routing_key);
    if (denied) return denied;

    if (hard) {
      await deps.sourceManager.hardDelete(id);
    } else {
      await deps.sourceManager.softDelete(id);
    }

    // Local only; the migration-019 pg_notify propagates it to other peers.
    deps.providerRegistry.unregister(source.routing_key);

    return c.json({ deleted: true, hard }, 200);
  });

  app.post('/api/v1/admin/generic-sources/:id/enable', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');
    const id = c.req.param('id');
    const source = await deps.sourceManager.getById(id);
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, source.routing_key);
    if (denied) return denied;
    await deps.sourceManager.enable(id);
    // So a webhook right after the 200 reaches the right normalizer here.
    registerProviderBundleForSource(source, {
      providerRegistry: deps.providerRegistry,
      config: deps.config,
      secretResolver: deps.secretResolver,
      clusterSettings: deps.clusterSettings,
    });
    return c.json({ enabled: true }, 200);
  });

  app.post('/api/v1/admin/generic-sources/:id/disable', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');
    const id = c.req.param('id');
    const source = await deps.sourceManager.getById(id);
    if (!source) {
      return c.json({ error: 'Source not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, source.routing_key);
    if (denied) return denied;
    await deps.sourceManager.disable(id);
    // Dispatch checks `enabled=true` anyway, but a stale bundle would cost
    // memory and miss would-be-fallback semantics.
    deps.providerRegistry.unregister(source.routing_key);
    return c.json({ enabled: false }, 200);
  });

  // Routing-key-scoped tokens may create only trusts whose `sourceRoutingKey`
  // matches their scope ("let repo X consume events from my routing key").
  app.post('/api/v1/admin/trust', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.create');
    const body = await c.req.json();
    const parsed = createTrustSchema.parse(body);
    const denied = enforceRoutingKeyScope(c, parsed.sourceRoutingKey);
    if (denied) return denied;
    const id = await deps.trustStore.addTrust(
      { repo: parsed.sourceRepo, routingKey: parsed.sourceRoutingKey },
      { repo: parsed.targetRepo, routingKey: parsed.targetRoutingKey },
      parsed.allowedEvents,
    );
    return c.json({ id }, 201);
  });

  app.get('/api/v1/admin/trust', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.read');
    const routingKey = c.req.query('routingKey');
    if (!routingKey) {
      return c.json({ error: 'Missing routingKey query parameter' }, 400);
    }
    const denied = enforceRoutingKeyScope(c, routingKey);
    if (denied) return denied;
    const entries = await deps.trustStore.listTrust(routingKey);
    return c.json({ entries }, 200);
  });

  app.delete('/api/v1/admin/trust/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.delete');
    const id = c.req.param('id');
    const existing = await deps.trustStore.getById(id);
    if (!existing) {
      return c.json({ error: 'Trust entry not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, existing.sourceRoutingKey);
    if (denied) return denied;
    await deps.trustStore.removeTrust(id);
    return c.json({ deleted: true }, 200);
  });

  // Mirrors `emitKiciEventDirect` in `@kici-dev/shared/db-admin.ts`; the
  // `pg_notify('kici_event_channel', <id>)` lets the EventRouter pick the event
  // up immediately. Requires `context.create`: an emit is a mutation that fans
  // out into workflow dispatch.
  if (deps.pool) {
    app.use('/api/v1/admin/events/emit', authMiddleware);
    app.post('/api/v1/admin/events/emit', async (c) => {
      deps.rbac.requirePermission(c.get('role'), 'context.create');
      const body = await c.req.json();
      const parsed = emitEventSchema.parse(body);
      const denied = enforceRoutingKeyScope(c, parsed.sourceRoutingKey ?? null);
      if (denied) return denied;
      const result = await deps.pool!.query<{ id: string }>(
        `INSERT INTO kici_events (
            event_name, payload, source_routing_key, source_repo,
            chain_depth, expires_at
          )
          VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '1 hour')
          RETURNING id`,
        [
          parsed.eventName,
          JSON.stringify(parsed.payload),
          parsed.sourceRoutingKey ?? '',
          parsed.sourceRepo ?? '',
        ],
      );
      const eventId = result.rows[0].id;
      await deps.pool!.query(`SELECT pg_notify('kici_event_channel', $1)`, [eventId]);
      return c.json({ eventId }, 201);
    });
  }

  return app;
}
