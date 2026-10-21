/**
 * Admin routes to list, inspect, refresh, disable and delete workflow
 * registrations, all behind the shared admin Bearer auth middleware.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  COMPILE_SCHEMA_VERSION,
  createLogger,
  depCacheKeyOf,
  lockCompileSchema,
} from '@kici-dev/shared';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import type { ContextStore } from '../contexts/context-store.js';
import { toContext } from '../contexts/context-store.js';
import { assertWorkflowsSatisfiable } from '../contexts/protection/satisfiability.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';
import { createBearerAuthMiddleware } from './admin-auth.js';
import { type AdminEnv, createAdminApp } from './admin-env.js';
import {
  formatStaleLockWarning,
  staleCompileSchemaEntries,
} from '../registration/compile-schema-staleness.js';

/**
 * A registration row plus the compile schema its lock declares and the one this
 * release's agents implement, so a client can flag a lock the agents reject.
 */
function withCompileSchema<T extends { lock_entry: unknown }>(
  row: T,
): T & { compileSchemaVersion: number | null; agentCompileSchemaVersion: number } {
  return {
    ...row,
    compileSchemaVersion: lockCompileSchema(
      row.lock_entry as { compileSchemaVersion?: unknown } | null,
    ),
    agentCompileSchemaVersion: COMPILE_SCHEMA_VERSION,
  };
}

const logger = createLogger({ prefix: 'admin-registrations' });

export interface AdminRegistrationRoutesDeps {
  registrationStore: RegistrationStore;
  registrationIndex: RegistrationIndex;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /**
   * When present, a manual registration is rejected up front if a job binds a
   * provably-unsatisfiable environment list (missing/disabled env, or
   * mutually-exclusive fixed branch/trigger/repo restrictions).
   */
  contextStore?: Pick<ContextStore, 'matchContext'>;
}

const refreshSchema = z.object({
  routingKey: z.string().min(1),
  repoIdentifier: z.string().min(1),
});

const disableSchema = z.object({
  disabled: z.boolean(),
});

const registerManualSchema = z.object({
  lockFileContents: z.string().min(1),
  repoIdentifier: z.string().min(1),
  routingKey: z.string().min(1),
  customerId: z.string().min(1),
  providerContext: z.record(z.string(), z.unknown()).default({}),
  commitSha: z.string().optional(),
});

/** Routes mounted at /api/v1/admin/registrations. */
export function createAdminRegistrationRoutes(deps: AdminRegistrationRoutesDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin-registrations',
  });
  app.use('/api/v1/admin/registrations', authMiddleware);
  app.use('/api/v1/admin/registrations/*', authMiddleware);

  app.get('/api/v1/admin/registrations', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.read');

    const customerId = c.req.query('customerId') ?? c.req.query('org');
    const queryRoutingKey = c.req.query('routingKey');
    const tokenRoutingKey = c.get('routingKey');
    // A routing-key-scoped token sees only its own key: refuse a mismatching
    // explicit filter, or force the filter when none was given.
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

    // customerId or event filters: getAll() and filter in memory (cross-source
    // webhook lookup path). Otherwise the index-backed routingKey/repo fast paths.
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
    // Defence-in-depth: a scoped token never observes rows outside its scope,
    // whatever the filter shape above.
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
        return triggers.some((t) => t._type === 'webhook' && (t.events ?? []).includes(eventName));
      });
    }

    return c.json(
      { registrations: registrations.map(withCompileSchema), total: registrations.length },
      200,
    );
  });

  app.get('/api/v1/admin/registrations/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.read');

    const registration = await deps.registrationStore.getById(c.req.param('id'));
    if (!registration) {
      return c.json({ error: 'Registration not found' }, 404);
    }

    const denied = enforceRoutingKeyScope(c, registration.routing_key);
    if (denied) return denied;

    return c.json({ registration: withCompileSchema(registration) }, 200);
  });

  // Upsert workflow_registrations from a lock file (break-glass / test seeding).
  // Never removes a registration the lock does not name — removal is
  // `registration delete`. Transactional via
  // RegistrationStore.replaceAll({ prune: false }) + bumpVersion.
  app.post('/api/v1/admin/registrations/register-manual', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');

    const body = await c.req.json();
    const parsed = registerManualSchema.parse(body);

    const denied = enforceRoutingKeyScope(c, parsed.routingKey);
    if (denied) return denied;

    let lockFile: { workflows: unknown[]; lockfileHash?: unknown; siblingsDigest?: unknown };
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

    // Reject a provably-unsatisfiable environment binding before it ever dispatches.
    if (deps.contextStore) {
      const envStore = deps.contextStore;
      try {
        await assertWorkflowsSatisfiable(
          lockFile.workflows as Parameters<typeof assertWorkflowsSatisfiable>[0],
          async (name) => {
            const row = await envStore.matchContext(parsed.customerId, name);
            return row ? toContext(row) : null;
          },
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    await deps.registrationStore.replaceAll(
      parsed.repoIdentifier,
      (lockFile.workflows ?? []) as Parameters<typeof deps.registrationStore.replaceAll>[1],
      parsed.routingKey,
      parsed.providerContext,
      {
        customerId: parsed.customerId,
        commitSha: parsed.commitSha,
        depCacheKey: depCacheKeyOf(lockFile),
        prune: false,
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

    // Every run of a stale lock fails on this release's agents: say so now.
    const warnings = staleCompileSchemaEntries(
      (lockFile.workflows as Array<{ name?: unknown }>).map((w) => ({
        repoIdentifier: parsed.repoIdentifier,
        workflowName: typeof w?.name === 'string' ? w.name : '(unnamed)',
        lockEntry: w,
      })),
    ).map((e) => formatStaleLockWarning(e));

    return c.json({ workflowCount, registryVersion, warnings }, 200);
  });

  // Force re-register from lock file (bumps registry version)
  app.post('/api/v1/admin/registrations/refresh', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');

    const body = await c.req.json();
    const parsed = refreshSchema.parse(body);

    const denied = enforceRoutingKeyScope(c, parsed.routingKey);
    if (denied) return denied;

    // Forces every peer to reload.
    const registryVersion = await deps.registrationStore.bumpVersion();
    await deps.registrationIndex.refreshIfNeeded(registryVersion);

    logger.info('Registration refresh triggered', {
      routingKey: parsed.routingKey,
      repoIdentifier: parsed.repoIdentifier,
      registryVersion,
    });

    return c.json({ registryVersion }, 200);
  });

  // Disable (or, with `disabled: false`, re-enable) by ID. A disabled
  // registration stays registered, but none of its triggers dispatch.
  app.patch('/api/v1/admin/registrations/:id/disable', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.update');

    const id = c.req.param('id');
    const parsed = disableSchema.parse(await c.req.json());
    // Routing key first, so a scoped token cannot toggle outside its scope (as DELETE).
    const existing = await deps.registrationStore.getById(id);
    if (!existing) {
      return c.json({ error: 'Registration not found' }, 404);
    }
    const denied = enforceRoutingKeyScope(c, existing.routing_key);
    if (denied) return denied;

    const updated = await deps.registrationStore.setDisabled(id, parsed.disabled);
    if (!updated) {
      return c.json({ error: 'Registration not found' }, 404);
    }

    // Every peer reloads the disabled flag.
    const registryVersion = await deps.registrationStore.bumpVersion();
    await deps.registrationIndex.refreshIfNeeded(registryVersion);

    logger.info('Registration disabled flag set', {
      id,
      disabled: parsed.disabled,
      registryVersion,
    });

    return c.json({ disabled: parsed.disabled, registryVersion }, 200);
  });

  app.delete('/api/v1/admin/registrations/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'context.delete');

    const id = c.req.param('id');
    // Routing key first, so a scoped token cannot delete outside its scope. A
    // missing row stays 404 (not 403), preserving the existing contract.
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

    const registryVersion = await deps.registrationStore.bumpVersion();
    await deps.registrationIndex.refreshIfNeeded(registryVersion);

    logger.info('Registration deleted', { id, registryVersion });

    return c.json({ deleted: true, registryVersion }, 200);
  });

  return app;
}
