/**
 * Admin API routes for secret backend management.
 *
 * Provides CRUD, connectivity testing, and sync endpoints for managing
 * secret backends (PG, Vault) through the admin API. Backend credentials
 * are stored encrypted at rest and never exposed in API responses.
 *
 * All routes are mounted under /api/v1/admin/backends and protected by
 * the admin auth middleware in admin.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { BackendDescriptor, AddBackendParams, BackendSyncManager } from '@kici-dev/engine';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';

const logger = createLogger({ prefix: 'admin-backends' });

type AdminBackendsEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

// ── Zod schemas for request validation ──────────────────────────────

const backendTypeSchema = z.enum(['pg', 'vault']);

const addBackendSchema = z.object({
  name: z.string().min(1).max(255),
  backendType: backendTypeSchema,
  config: z.record(z.string(), z.unknown()),
  scopeFilter: z.string().optional(),
  syncIntervalMs: z.number().positive().optional(),
});

interface BackendRouteDeps {
  registry: BackendRegistry;
  healthChecker: BackendHealthChecker;
  syncManager?: BackendSyncManager;
}

/**
 * Create admin API routes for secret backend management.
 *
 * @param deps - Backend route dependencies (registry, health checker, sync manager)
 * @returns Hono app with backend routes
 */
export function createBackendRoutes(deps: BackendRouteDeps): Hono<AdminBackendsEnv> {
  const app = new Hono<AdminBackendsEnv>();

  // Secret-backend management is orchestrator-wide; routing-key tokens
  // are refused at the router level.
  app.use('/backends', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });
  app.use('/backends/*', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // ── Static POST routes (must be before parameterized :name routes) ──

  // POST /backends -- add a new backend
  app.post('/backends', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = addBackendSchema.parse(body);

      const params: AddBackendParams = {
        name: parsed.name,
        backendType: parsed.backendType,
        config: parsed.config,
        scopeFilter: parsed.scopeFilter,
        syncIntervalMs: parsed.syncIntervalMs,
      };

      const descriptor = await deps.registry.addBackend(params);
      logger.info('Backend added', { name: descriptor.name, type: descriptor.backendType });

      return c.json(descriptorToJson(descriptor), 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /backends/test -- test connection without persisting
  app.post('/backends/test', async (c) => {
    try {
      const body = await c.req.json();
      const parsed = addBackendSchema.parse(body);

      const params: AddBackendParams = {
        name: parsed.name,
        backendType: parsed.backendType,
        config: parsed.config,
        scopeFilter: parsed.scopeFilter,
        syncIntervalMs: parsed.syncIntervalMs,
      };

      const result = await deps.healthChecker.testConnection(params);
      logger.info('Backend connection test', {
        name: parsed.name,
        ok: result.ok,
        latencyMs: result.latencyMs,
      });

      return c.json(result);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /backends/sync -- sync all backends
  app.post('/backends/sync', async (c) => {
    try {
      if (!deps.syncManager) {
        return c.json({ error: 'Sync manager not available' }, 503);
      }

      const results = await deps.syncManager.syncAllBackends();
      logger.info('All backends synced', { count: results.length });

      return c.json({ results });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Parameterized routes ──────────────────────────────────────────

  // DELETE /backends/:name -- remove a backend
  app.delete('/backends/:name', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));

      // Get scope count before removal for response
      const backend = await deps.registry.getBackend(name);
      if (!backend) {
        return c.json({ error: 'Backend not found' }, 404);
      }

      const removed = await deps.registry.removeBackend(name);
      if (!removed) {
        return c.json({ error: 'Backend not found' }, 404);
      }

      logger.info('Backend removed', { name, scopeCount: backend.scopeCount });
      return c.json({ removed: true, scopeCount: backend.scopeCount });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /backends -- list all backends
  app.get('/backends', async (c) => {
    try {
      const backends = await deps.registry.listBackends();
      return c.json({ backends: backends.map(descriptorToJson) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // GET /backends/:name -- get a single backend
  app.get('/backends/:name', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));
      const backend = await deps.registry.getBackend(name);
      if (!backend) {
        return c.json({ error: 'Backend not found' }, 404);
      }
      return c.json(descriptorToJson(backend));
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /backends/:name/test -- test a named registered backend
  app.post('/backends/:name/test', async (c) => {
    try {
      const name = decodeURIComponent(c.req.param('name'));

      const backend = await deps.registry.getBackend(name);
      if (!backend) {
        return c.json({ error: 'Backend not found' }, 404);
      }

      const config = await deps.registry.getBackendConfig(name);
      if (!config) {
        return c.json({ error: 'Backend config not found' }, 404);
      }

      const params: AddBackendParams = {
        name: backend.name,
        backendType: backend.backendType,
        config,
        scopeFilter: backend.scopeFilter,
        syncIntervalMs: backend.syncIntervalMs,
      };

      const result = await deps.healthChecker.testConnection(params);
      logger.info('Named backend connection test', {
        name,
        ok: result.ok,
        latencyMs: result.latencyMs,
      });

      return c.json(result);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // POST /backends/:name/sync -- sync a single backend
  app.post('/backends/:name/sync', async (c) => {
    try {
      if (!deps.syncManager) {
        return c.json({ error: 'Sync manager not available' }, 503);
      }

      const name = decodeURIComponent(c.req.param('name'));

      const backend = await deps.registry.getBackend(name);
      if (!backend) {
        return c.json({ error: 'Backend not found' }, 404);
      }

      const result = await deps.syncManager.syncBackend(name);
      logger.info('Backend synced', { name, scopeCount: result.scopeCount });

      return c.json({ synced: true, scopeCount: result.scopeCount });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

/**
 * Convert a BackendDescriptor to a JSON-safe object.
 */
function descriptorToJson(d: BackendDescriptor): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    backendType: d.backendType,
    scopeFilter: d.scopeFilter,
    syncIntervalMs: d.syncIntervalMs,
    enabled: d.enabled,
    healthStatus: d.healthStatus,
    scopeCount: d.scopeCount,
    lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
    lastSyncError: d.lastSyncError,
    lastHealthCheckAt: d.lastHealthCheckAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function handleError(c: any, err: unknown) {
  return handleAdminError(c, err, logger);
}
