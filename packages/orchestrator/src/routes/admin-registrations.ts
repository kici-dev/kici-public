/**
 * Admin API routes for workflow registration management.
 *
 * Provides endpoints for listing, inspecting, refreshing, and deleting
 * workflow registrations. All routes are protected by Bearer token
 * authentication via the existing admin auth middleware pattern.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-registrations' });

/**
 * Dependencies for admin registration routes.
 */
export interface AdminRegistrationRoutesDeps {
  registrationStore: RegistrationStore;
  registrationIndex: RegistrationIndex;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
}

/** Hono env type for admin registration routes with context variables. */
type AdminRegEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

// -- Zod schemas for request validation --

const refreshSchema = z.object({
  routingKey: z.string().min(1),
  repoIdentifier: z.string().min(1),
});

const registerManualSchema = z.object({
  lockFileContents: z.string().min(1),
  repoIdentifier: z.string().min(1),
  routingKey: z.string().min(1),
  customerId: z.string().min(1),
  providerContext: z.record(z.string(), z.unknown()).default({}),
  commitSha: z.string().optional(),
});

/**
 * Create admin API routes for workflow registration management.
 *
 * @param deps - Admin registration route dependencies
 * @returns Hono app with registration routes mounted at /api/v1/admin/registrations
 */
export function createAdminRegistrationRoutes(
  deps: AdminRegistrationRoutesDeps,
): Hono<AdminRegEnv> {
  const app = new Hono<AdminRegEnv>();

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
  app.use('/api/v1/admin/registrations', authMiddleware);
  app.use('/api/v1/admin/registrations/*', authMiddleware);

  // ---- Registration endpoints ----

  // List all registrations with optional filters
  app.get('/api/v1/admin/registrations', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.read');

      const customerId = c.req.query('customerId') ?? c.req.query('org');
      const queryRoutingKey = c.req.query('routingKey');
      const tokenRoutingKey = c.get('routingKey');
      // Routing-key-scoped tokens see only their own routing key:
      // refuse a mismatching explicit filter, or force the filter
      // when none was provided.
      if (tokenRoutingKey) {
        if (queryRoutingKey && queryRoutingKey !== tokenRoutingKey) {
          const denied = enforceRoutingKeyScope(c, queryRoutingKey);
          if (denied) return denied;
        }
      }
      const routingKey = tokenRoutingKey ?? queryRoutingKey;
      const repoIdentifier = c.req.query('repoIdentifier');
      const triggerType = c.req.query('triggerType');
      const eventName = c.req.query('event');

      // When customerId or event filters are present, use getAll() and apply
      // all filters in-memory (cross-source webhook lookup path). Otherwise,
      // honor the existing index-backed routingKey/repo fast paths.
      let registrations;
      if (customerId || eventName) {
        registrations = await deps.registrationStore.getAll();
      } else if (routingKey && repoIdentifier) {
        registrations = await deps.registrationStore.getByRoutingKeyAndRepo(
          routingKey,
          repoIdentifier,
        );
      } else if (routingKey) {
        registrations = await deps.registrationStore.getByRoutingKey(routingKey);
      } else {
        registrations = await deps.registrationStore.getAll();
      }

      if (customerId) {
        registrations = registrations.filter((r) => r.customerId === customerId);
      }
      if (routingKey && (customerId || eventName)) {
        registrations = registrations.filter((r) => r.routing_key === routingKey);
      }
      // Defence-in-depth: a routing-key-scoped token must never observe
      // rows outside its scope, regardless of the filter shape above.
      if (tokenRoutingKey) {
        registrations = registrations.filter((r) => r.routing_key === tokenRoutingKey);
      }
      if (repoIdentifier && (customerId || eventName)) {
        registrations = registrations.filter((r) => r.repo_identifier === repoIdentifier);
      }
      if (triggerType) {
        registrations = registrations.filter((r) => r.trigger_types.includes(triggerType));
      }
      if (eventName) {
        registrations = registrations.filter((r) => {
          const triggers =
            (
              r.lock_entry as {
                triggers?: ReadonlyArray<{ _type: string; events?: readonly string[] }>;
              }
            )?.triggers ?? [];
          return triggers.some(
            (t) => t._type === 'webhook' && (t.events ?? []).includes(eventName),
          );
        });
      }

      return c.json({ registrations, total: registrations.length }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Get single registration by ID
  app.get('/api/v1/admin/registrations/:id', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.read');

      const registration = await deps.registrationStore.getById(c.req.param('id'));
      if (!registration) {
        return c.json({ error: 'Registration not found' }, 404);
      }

      const denied = enforceRoutingKeyScope(c, registration.routing_key);
      if (denied) return denied;

      return c.json({ registration }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Manually upsert workflow_registrations from a lock file (for break-glass /
  // E2E seeding). Transactional via RegistrationStore.replaceAll + bumpVersion.
  app.post('/api/v1/admin/registrations/register-manual', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.update');

      const body = await c.req.json();
      const parsed = registerManualSchema.parse(body);

      const denied = enforceRoutingKeyScope(c, parsed.routingKey);
      if (denied) return denied;

      let lockFile: { workflows: unknown[] };
      try {
        lockFile = JSON.parse(parsed.lockFileContents);
      } catch (err) {
        return c.json(
          {
            error: `lockFileContents is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }
      if (!Array.isArray((lockFile as { workflows?: unknown }).workflows)) {
        return c.json({ error: 'lock file missing workflows[] array' }, 400);
      }

      await deps.registrationStore.replaceAll(
        parsed.repoIdentifier,
        (lockFile.workflows ?? []) as Parameters<typeof deps.registrationStore.replaceAll>[1],
        parsed.routingKey,
        parsed.providerContext,
        {
          customerId: parsed.customerId,
          commitSha: parsed.commitSha,
        },
      );
      const registryVersion = await deps.registrationStore.bumpVersion();
      await deps.registrationIndex.refreshIfNeeded(registryVersion);

      const workflowCount = (lockFile.workflows ?? []).length;
      logger.info('Manual workflow registration', {
        repoIdentifier: parsed.repoIdentifier,
        routingKey: parsed.routingKey,
        customerId: parsed.customerId,
        workflowCount,
        registryVersion,
      });

      return c.json({ workflowCount, registryVersion }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Force re-register from lock file (bumps registry version)
  app.post('/api/v1/admin/registrations/refresh', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.update');

      const body = await c.req.json();
      const parsed = refreshSchema.parse(body);

      const denied = enforceRoutingKeyScope(c, parsed.routingKey);
      if (denied) return denied;

      // Bump registry version to force all peers to reload
      const registryVersion = await deps.registrationStore.bumpVersion();
      await deps.registrationIndex.refreshIfNeeded(registryVersion);

      logger.info('Registration refresh triggered', {
        routingKey: parsed.routingKey,
        repoIdentifier: parsed.repoIdentifier,
        registryVersion,
      });

      return c.json({ registryVersion }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // Delete a registration by ID
  app.delete('/api/v1/admin/registrations/:id', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'context.delete');

      const id = c.req.param('id');
      // Look up the row's routing key first so a scoped token cannot
      // delete a registration outside its scope. Returning 404 (rather
      // than 403) for missing rows preserves the prior contract.
      const existing = await deps.registrationStore.getById(id);
      if (!existing) {
        return c.json({ error: 'Registration not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, existing.routing_key);
      if (denied) return denied;

      const deleted = await deps.registrationStore.deleteById(id);
      if (!deleted) {
        return c.json({ error: 'Registration not found' }, 404);
      }

      // Bump registry version to notify peers
      const registryVersion = await deps.registrationStore.bumpVersion();
      await deps.registrationIndex.refreshIfNeeded(registryVersion);

      logger.info('Registration deleted', { id, registryVersion });

      return c.json({ deleted: true, registryVersion }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

function handleError(c: any, err: unknown) {
  return handleAdminError(c, err, logger);
}
