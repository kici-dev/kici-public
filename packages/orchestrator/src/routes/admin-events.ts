/**
 * Admin API routes for generic webhook sources and trust management.
 *
 * Provides CRUD endpoints for managing generic webhook sources (create, list,
 * get, update, delete, enable, disable) and cross-repo trust relationships.
 *
 * All routes are protected by Bearer token authentication via the existing
 * admin auth middleware pattern from admin.ts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type pg from 'pg';
import type { GenericSourceManager } from '../webhook/generic-sources.js';
import type { TrustStore } from '../events/trust-store.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { UniversalGitConfigSchema } from '../providers/universal-git/config.js';
import { LocalSourceConfigSchema } from '../providers/local/local-source-config.js';
import { enforceRoutingKeyScope, requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { AppConfig } from '../config.js';
import type { ProviderRegistry } from '../provider-registry.js';
import type { SecretResolver } from '../secrets/secret-resolver.js';
import { registerProviderBundleForSource } from '../webhook/register-source-bundle.js';

const logger = createLogger({ prefix: 'admin-events' });

/**
 * Dependencies for admin event routes.
 */
interface AdminEventRouteDeps {
  sourceManager: GenericSourceManager;
  trustStore: TrustStore;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /**
   * The in-process bundle registry. The POST /generic-sources handler
   * registers a local / universal-git bundle into this registry
   * immediately after the source row lands in the DB, so the next
   * webhook against that source resolves the right normalizer without
   * waiting for an orchestrator restart.
   */
  providerRegistry: ProviderRegistry;
  /** Passed through to `registerProviderBundleForSource` (universal-git bundle
   *  build reads cluster config; local bundles read the row's own git_config). */
  config: AppConfig;
  /** Required for universal-git source registration — `null` is allowed;
   *  rows with `git_config` are skipped + metric-bumped in that case. */
  secretResolver: SecretResolver | null;
  /**
   * Optional — when provided, the `POST /api/v1/admin/events/emit` route is
   * mounted so operators can INSERT into `kici_events` + `pg_notify` via HTTP.
   * Mirrors `emitKiciEventDirect` in `@kici-dev/shared` (direct-DB CLI mode).
   */
  pool?: pg.Pool;
}

/** Hono env type for admin event routes with context variables. */
type AdminEventEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

// -- Zod schemas for request validation --

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
  /** Local filesystem source config (`{ repoBasePath, cloneUrlBase? }`).
   *  Set together with providerType='local'. Stored in the same git_config column. */
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
  /** Local filesystem source config. `null` clears it; omit to leave untouched. */
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
 * Payload for `POST /api/v1/admin/events/emit`. Mirrors `EmitKiciEventOpts`
 * in `@kici-dev/shared/db-admin.ts` (the direct-DB helper). The payload is a
 * plain JSON object — arrays and primitives are rejected because the
 * `kici_events.payload` column is defined as `jsonb` with an object shape
 * throughout the codebase.
 */
const emitEventSchema = z.object({
  eventName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sourceRoutingKey: z.string().optional(),
  sourceRepo: z.string().optional(),
});

/**
 * Create admin API routes for generic webhook sources and trust management.
 *
 * @param deps - Admin event route dependencies
 * @returns Hono app with admin event routes mounted at /api/v1/admin/*
 */
export function createAdminEventRoutes(deps: AdminEventRouteDeps): Hono<AdminEventEnv> {
  const app = new Hono<AdminEventEnv>();

  // -- Bearer token auth middleware --
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
  app.use('/api/v1/admin/generic-sources', authMiddleware);
  app.use('/api/v1/admin/generic-sources/*', authMiddleware);
  app.use('/api/v1/admin/trust', authMiddleware);
  app.use('/api/v1/admin/trust/*', authMiddleware);

  // ---- Generic Source CRUD ----

  // Create a new generic webhook source. The new source mints a fresh
  // `generic:<orgId>:<id>` routing key the caller cannot pre-claim, so
  // routing-key-scoped tokens are refused.
  app.post('/api/v1/admin/generic-sources', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      deps.rbac.requirePermission(c.get('role'), 'context.create');
      const body = await c.req.json();
      const parsed = createSourceSchema.parse(body);
      const source = await deps.sourceManager.create(parsed);
      // Register the per-routing-key provider bundle so the next webhook
      // against this source resolves the right normalizer. Without this,
      // a local-typed source would 404 (registry lookup miss) or a
      // universal-git source would fall through the plain-generic
      // payload-only path until an orchestrator restart picked up the row.
      registerProviderBundleForSource(source, {
        providerRegistry: deps.providerRegistry,
        config: deps.config,
        secretResolver: deps.secretResolver,
      });
      return c.json({ source }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List sources for an org. Routing-key-scoped tokens see only their
  // own source within the requested org.
  app.get('/api/v1/admin/generic-sources', async (c) => {
    try {
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
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Get source details
  app.get('/api/v1/admin/generic-sources/:id', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.read');
      const source = await deps.sourceManager.getById(c.req.param('id'));
      if (!source) {
        return c.json({ error: 'Source not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, source.routing_key);
      if (denied) return denied;
      return c.json({ source }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Update source config
  app.patch('/api/v1/admin/generic-sources/:id', async (c) => {
    try {
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
      // Live registry refresh on the issuing peer: clear any prior
      // bundle (handles provider_type changes that flip a row from
      // 'local' / universal-git back to plain 'generic'), then
      // re-apply the helper. Other peers pick up the same change via
      // the migration-019 pg_notify + GenericSourcesChangeListener.
      deps.providerRegistry.unregister(source.routing_key);
      registerProviderBundleForSource(source, {
        providerRegistry: deps.providerRegistry,
        config: deps.config,
        secretResolver: deps.secretResolver,
      });
      return c.json({ source }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Delete source (soft delete by default, hard delete with ?hard=true)
  app.delete('/api/v1/admin/generic-sources/:id', async (c) => {
    try {
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

      // Unregister the per-routing-key bundle locally. The pg_notify
      // round-trip from migration 019 propagates the same change to
      // every other peer's listener.
      deps.providerRegistry.unregister(source.routing_key);

      return c.json({ deleted: true, hard }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Enable source
  app.post('/api/v1/admin/generic-sources/:id/enable', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.update');
      const id = c.req.param('id');
      const source = await deps.sourceManager.getById(id);
      if (!source) {
        return c.json({ error: 'Source not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, source.routing_key);
      if (denied) return denied;
      await deps.sourceManager.enable(id);
      // Re-register the bundle locally so a webhook fired immediately
      // after the 200 reaches the right normalizer on this peer.
      registerProviderBundleForSource(source, {
        providerRegistry: deps.providerRegistry,
        config: deps.config,
        secretResolver: deps.secretResolver,
      });
      return c.json({ enabled: true }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Disable source
  app.post('/api/v1/admin/generic-sources/:id/disable', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.update');
      const id = c.req.param('id');
      const source = await deps.sourceManager.getById(id);
      if (!source) {
        return c.json({ error: 'Source not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, source.routing_key);
      if (denied) return denied;
      await deps.sourceManager.disable(id);
      // Drop the per-routing-key bundle locally — webhook dispatch
      // checks `enabled=true` server-side anyway, but leaving a stale
      // bundle in the registry would still cost memory + miss
      // would-be-fallback semantics.
      deps.providerRegistry.unregister(source.routing_key);
      return c.json({ enabled: false }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ---- Trust CRUD ----

  // Create trust relationship. Routing-key-scoped tokens may only
  // create trusts whose `sourceRoutingKey` matches their scope (the
  // typical operator workflow: "let repo X consume events from my
  // routing key").
  app.post('/api/v1/admin/trust', async (c) => {
    try {
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
    } catch (err) {
      return handleError(c, err);
    }
  });

  // List trust relationships for a routing key
  app.get('/api/v1/admin/trust', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.read');
      const routingKey = c.req.query('routingKey');
      if (!routingKey) {
        return c.json({ error: 'Missing routingKey query parameter' }, 400);
      }
      const denied = enforceRoutingKeyScope(c, routingKey);
      if (denied) return denied;
      const entries = await deps.trustStore.listTrust(routingKey);
      return c.json({ entries }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Remove trust relationship
  app.delete('/api/v1/admin/trust/:id', async (c) => {
    try {
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
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ---- Event emission (phase 28.10 plan 03 artifact) ----
  //
  // Mirrors `emitKiciEventDirect` in `@kici-dev/shared/db-admin.ts`. INSERTs
  // a row into `kici_events` and fires `pg_notify('kici_event_channel', <id>)`
  // so the orchestrator EventRouter picks the event up immediately. Matched
  // write-grade RBAC permission is `context.create` — emitting an event is a
  // mutation that fans out into the workflow dispatch pipeline.
  if (deps.pool) {
    app.use('/api/v1/admin/events/emit', authMiddleware);
    app.post('/api/v1/admin/events/emit', async (c) => {
      try {
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
      } catch (err) {
        return handleError(c, err);
      }
    });
  }

  return app;
}

function handleError(c: any, err: unknown) {
  return handleAdminError(c, err, logger);
}
