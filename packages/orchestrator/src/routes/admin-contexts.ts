/**
 * Admin API routes for context management.
 *
 *   POST   /api/v1/admin/contexts                                    — create (upsert)
 *   POST   /api/v1/admin/contexts/:name/bind                         — bind a scope pattern
 *   PATCH  /api/v1/admin/contexts/:name/policy                       — update policy fields
 *   GET    /api/v1/admin/contexts?orgId=<id>                         — list contexts
 *   GET    /api/v1/admin/contexts/:name?orgId=<id>                   — show env + vars + bindings
 *   DELETE /api/v1/admin/contexts/:name?orgId=<id>                   — delete env (cascades bindings/variables/overrides; pending held runs block with 409)
 *   POST   /api/v1/admin/contexts/templates                          — create/update a template
 *   GET    /api/v1/admin/contexts/:name/variables?orgId=<id>         — list org-level variables
 *   PUT    /api/v1/admin/contexts/:name/variables/:key?orgId=<id>    — upsert variable
 *   DELETE /api/v1/admin/contexts/:name/variables/:key?orgId=<id>    — delete variable
 *
 * Backs the `kici-admin context` dual-mode CLI. Offline (direct-DB) mode
 * bypasses this router entirely — the CLI calls `*Direct` helpers from
 * @kici-dev/shared. This HTTP surface exists so tooling with only an admin
 * token (no DB reach) can do the same operations.
 *
 * All routes are protected by the admin auth middleware mounted in admin.ts
 * (at `/api/v1/admin/*`). That middleware sets `role` + `userId` on the
 * context, which we use for RBAC gating here.
 */
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ContextDeleteErrorCode } from '@kici-dev/engine';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { ContextStore, ContextDeleteBlockedError } from '../contexts/context-store.js';
import { BindingStore } from '../contexts/binding-store.js';
import { VariableStore } from '../contexts/variable-store.js';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-contexts' });

export interface AdminContextRoutesDeps {
  db: Kysely<any>;
  rbac: RbacEnforcer;
}

/** Hono env type for admin-contexts routes with context variables. */
type AdminEnvEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

// ── Zod schemas for request validation ─────────────────────────────

const createContextSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  globPattern: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  branchRestrictions: z.array(z.string()).optional(),
  requiredReviewers: z.array(z.string()).nullable().optional(),
  waitTimerSeconds: z.number().int().min(0).nullable().optional(),
  holdExpirySeconds: z.number().int().positive().nullable().optional(),
  minimumTrust: z.string().nullable().optional(),
  /** Gate that lets CLI-initiated test runs resolve secrets through this env. */
  allowLocalExecution: z.boolean().optional(),
});

const bindSchema = z.object({
  orgId: z.string().min(1),
  scopePattern: z.string().min(1),
  // Host selector (exact/glob/regex over a fan-out child's agentId/host/labels).
  // '**' (the default) matches every host.
  hostPattern: z.string().min(1).default('**'),
});

const setPolicySchema = z.object({
  orgId: z.string().min(1),
  contextName: z.string().min(1),
  branchRestrictions: z.array(z.string()).optional(),
  requiredReviewers: z.array(z.string()).nullable().optional(),
  waitTimerSeconds: z.number().int().min(0).nullable().optional(),
  holdExpirySeconds: z.number().int().positive().nullable().optional(),
  minimumTrust: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  allowLocalExecution: z.boolean().optional(),
});

const createTemplateSchema = z.object({
  orgId: z.string().min(1),
  templateName: z.string().min(1),
  type: z.string().optional(),
  branchRestrictions: z.array(z.string()).optional(),
  requiredReviewers: z.array(z.string()).nullable().optional(),
  waitTimerSeconds: z.number().int().min(0).nullable().optional(),
  holdExpirySeconds: z.number().int().positive().nullable().optional(),
  minimumTrust: z.string().nullable().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

const setVariableSchema = z.object({
  value: z.string(),
  locked: z.boolean().optional(),
});

/**
 * Create admin API routes for context management.
 *
 * @param deps - db (Kysely) + rbac enforcer
 * @returns Hono app mounted at /api/v1/admin
 */
export function createAdminContextRoutes(deps: AdminContextRoutesDeps): Hono<AdminEnvEnv> {
  const app = new Hono<AdminEnvEnv>();
  const envStore = new ContextStore(deps.db as Kysely<any>);
  const bindingStore = new BindingStore(deps.db as Kysely<any>);
  const variableStore = new VariableStore(deps.db as Kysely<any>);

  // Contexts are org-scoped, not routing-key-scoped — refuse any
  // request from a token that is restricted to a single routing key.
  app.use('/contexts', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });
  app.use('/contexts/*', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // ── POST /contexts ─ create (upsert) ─────────────────────────
  app.post('/contexts', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = createContextSchema.parse(await c.req.json());

      const existing = await envStore.getByName(body.orgId, body.name);
      if (existing) {
        const updated = await envStore.update(body.orgId, existing.id, {
          type: body.type as 'fixed' | 'glob' | undefined,
          globPattern: body.globPattern,
          enabled: body.enabled,
          branchRestrictions: body.branchRestrictions,
          requiredReviewers: body.requiredReviewers ?? undefined,
          waitTimerSeconds: body.waitTimerSeconds ?? undefined,
          holdExpirySeconds: body.holdExpirySeconds ?? undefined,
          minimumTrust: body.minimumTrust as 'known' | 'trusted' | null | undefined,
          allowLocalExecution: body.allowLocalExecution,
        });
        logger.info('context updated', { orgId: body.orgId, name: body.name });
        return c.json({ envId: updated?.id ?? existing.id, created: false });
      }

      const created = await envStore.create(body.orgId, {
        name: body.name,
        type: (body.type as 'fixed' | 'glob') ?? 'fixed',
        globPattern: body.globPattern,
        enabled: body.enabled ?? true,
        branchRestrictions: body.branchRestrictions,
        requiredReviewers: body.requiredReviewers ?? undefined,
        waitTimerSeconds: body.waitTimerSeconds ?? undefined,
        holdExpirySeconds: body.holdExpirySeconds ?? undefined,
        minimumTrust: body.minimumTrust as 'known' | 'trusted' | null | undefined,
        allowLocalExecution: body.allowLocalExecution,
      });
      logger.info('context created', { orgId: body.orgId, name: body.name });
      return c.json({ envId: created.id, created: true }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /contexts/:name/bind ────────────────────────────────
  app.post('/contexts/:name/bind', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = bindSchema.parse(await c.req.json());
      const name = c.req.param('name');
      const env = await envStore.getByName(body.orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${body.orgId}, name=${name})` }, 404);
      }

      // Check if binding already exists to report create vs noop honestly.
      const existing = await deps.db
        .selectFrom('context_bindings')
        .select('scope_pattern')
        .where('org_id', '=', body.orgId)
        .where('context_id', '=', env.id)
        .where('scope_pattern', '=', body.scopePattern)
        .where('host_pattern', '=', body.hostPattern)
        .executeTakeFirst();

      if (existing) {
        return c.json({ created: false });
      }

      await deps.db
        .insertInto('context_bindings')
        .values({
          org_id: body.orgId,
          context_id: env.id,
          scope_pattern: body.scopePattern,
          host_pattern: body.hostPattern,
        })
        .execute();
      logger.info('context binding created', {
        orgId: body.orgId,
        name,
        scopePattern: body.scopePattern,
        hostPattern: body.hostPattern,
      });
      return c.json({ created: true }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── PATCH /contexts/:name/policy ─────────────────────────────
  app.patch('/contexts/:name/policy', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = setPolicySchema.parse(await c.req.json());
      const name = c.req.param('name');
      const env = await envStore.getByName(body.orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${body.orgId}, name=${name})` }, 404);
      }
      const updates: Parameters<ContextStore['update']>[2] = {};
      if (body.branchRestrictions !== undefined)
        updates.branchRestrictions = body.branchRestrictions;
      if (body.requiredReviewers !== undefined) updates.requiredReviewers = body.requiredReviewers;
      if (body.waitTimerSeconds !== undefined) updates.waitTimerSeconds = body.waitTimerSeconds;
      if (body.holdExpirySeconds !== undefined) updates.holdExpirySeconds = body.holdExpirySeconds;
      if (body.minimumTrust !== undefined)
        updates.minimumTrust = body.minimumTrust as 'known' | 'trusted' | null;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.allowLocalExecution !== undefined)
        updates.allowLocalExecution = body.allowLocalExecution;
      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'at least one policy field is required' }, 400);
      }
      await envStore.update(body.orgId, env.id, updates);
      logger.info('context policy updated', {
        orgId: body.orgId,
        name,
        fields: Object.keys(updates),
      });
      return c.json({ updated: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /contexts ─ list ────────────────────────────────────
  app.get('/contexts', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const rows = await envStore.list(orgId);

      if (c.req.query('includeSecrets') !== 'true' || rows.length === 0) {
        return c.json({ contexts: rows });
      }

      const envIds = rows.map((r) => r.id);
      const bindingRows = await deps.db
        .selectFrom('context_bindings as eb')
        .innerJoin('scoped_secrets as ss', (join) =>
          join.onRef('ss.scope', '=', 'eb.scope_pattern').onRef('ss.org_id', '=', 'eb.org_id'),
        )
        .select(['eb.context_id as context_id', 'ss.key as key'])
        .where('eb.org_id', '=', orgId)
        .where('eb.context_id', 'in', envIds)
        .where('ss.key', '!=', '__empty__')
        .distinct()
        .execute();

      const keysByEnv = new Map<string, Set<string>>();
      for (const b of bindingRows as Array<{ context_id: string; key: string }>) {
        let s = keysByEnv.get(b.context_id);
        if (!s) {
          s = new Set();
          keysByEnv.set(b.context_id, s);
        }
        s.add(b.key);
      }

      const enriched = rows.map((r) => ({
        ...r,
        secret_keys: Array.from(keysByEnv.get(r.id) ?? []).sort(),
      }));
      return c.json({ contexts: enriched });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /contexts/:name ─ show ──────────────────────────────
  app.get('/contexts/:name', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      const name = c.req.param('name');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const env = await envStore.getByName(orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${orgId}, name=${name})` }, 404);
      }
      const variables = await variableStore.listVars(orgId, env.id);
      const bindings = await bindingStore.list(orgId, env.id);
      return c.json({
        context: env,
        variables: variables.map((v) => ({
          key: v.key,
          value: v.value,
          locked: v.locked,
          updated_at: v.updated_at,
        })),
        bindings: bindings.map((b) => ({
          scope_pattern: b.scope_pattern,
          host_pattern: b.host_pattern,
          created_at: b.created_at,
        })),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── DELETE /contexts/:name ─ delete context ──────────────
  app.delete('/contexts/:name', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const orgId = c.req.query('orgId');
      if (!orgId) return c.json({ error: 'orgId query parameter is required' }, 400);
      const name = c.req.param('name');
      const env = await envStore.getByName(orgId, name);
      if (!env) return c.json({ error: 'Context not found' }, 404);
      try {
        await envStore.delete(orgId, env.id);
      } catch (err) {
        if (err instanceof ContextDeleteBlockedError) {
          return c.json(
            { error: err.message, errorCode: ContextDeleteErrorCode.enum.pending_held_runs },
            409,
          );
        }
        throw err;
      }
      logger.info('context deleted', { orgId, name });
      return c.json({ deleted: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /contexts/templates ─ create/update template + vars ─
  app.post('/contexts/templates', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = createTemplateSchema.parse(await c.req.json());

      // Upsert the template-type context.
      const existing = await envStore.getByName(body.orgId, body.templateName);
      let envId: string;
      let created: boolean;
      if (existing) {
        // Do NOT pass `type` to update — updating an env's type can be disruptive.
        await envStore.update(body.orgId, existing.id, {
          branchRestrictions: body.branchRestrictions,
          requiredReviewers: body.requiredReviewers ?? undefined,
          waitTimerSeconds: body.waitTimerSeconds ?? undefined,
          holdExpirySeconds: body.holdExpirySeconds ?? undefined,
          minimumTrust: body.minimumTrust as 'known' | 'trusted' | null | undefined,
        });
        envId = existing.id;
        created = false;
      } else {
        // NOTE: The DB CHECK constraint currently only allows 'fixed' | 'glob'.
        // Callers that need real "template" semantics should use the direct-DB
        // helper which bypasses the CHECK. For HTTP callers, we coerce to
        // 'fixed' to avoid a 500 — the semantics are equivalent for seeding.
        const rawType = body.type ?? 'template';
        const safeType: 'fixed' | 'glob' = rawType === 'glob' ? 'glob' : 'fixed';
        const row = await envStore.create(body.orgId, {
          name: body.templateName,
          type: safeType,
          enabled: true,
          branchRestrictions: body.branchRestrictions,
          requiredReviewers: body.requiredReviewers ?? undefined,
          waitTimerSeconds: body.waitTimerSeconds ?? undefined,
          holdExpirySeconds: body.holdExpirySeconds ?? undefined,
          minimumTrust: body.minimumTrust as 'known' | 'trusted' | null | undefined,
        });
        envId = row.id;
        created = true;
      }

      // Seed variables (if any).
      let variablesSet = 0;
      if (body.variables) {
        for (const [key, value] of Object.entries(body.variables)) {
          await variableStore.setVar(body.orgId, envId, key, value, false);
          variablesSet += 1;
        }
      }

      // Touch updated_at when template seed was a no-op but variables changed
      // (avoids a silent no-change response).
      if (!created && variablesSet > 0) {
        await deps.db
          .updateTable('contexts')
          .set({ updated_at: sql`now()` })
          .where('org_id', '=', body.orgId)
          .where('id', '=', envId)
          .execute();
      }

      logger.info('context template upserted', {
        orgId: body.orgId,
        templateName: body.templateName,
        created,
        variablesSet,
      });
      return c.json({ envId, created, variablesSet }, created ? 201 : 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /contexts/:name/variables ─ list org-level variables ─
  app.get('/contexts/:name/variables', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const orgId = c.req.query('orgId');
      const name = c.req.param('name');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const env = await envStore.getByName(orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${orgId}, name=${name})` }, 404);
      }
      const variables = await variableStore.listVars(orgId, env.id);
      return c.json({
        variables: variables.map((v) => ({
          key: v.key,
          value: v.value,
          locked: v.locked,
          updated_at: v.updated_at,
        })),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── PUT /contexts/:name/variables/:key ─ upsert variable ─────
  app.put('/contexts/:name/variables/:key', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = setVariableSchema.parse(await c.req.json());
      const orgId = c.req.query('orgId');
      const name = c.req.param('name');
      const key = c.req.param('key');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const env = await envStore.getByName(orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${orgId}, name=${name})` }, 404);
      }
      await variableStore.setVar(orgId, env.id, key, body.value, body.locked ?? false);
      logger.info('context variable set', { orgId, context: name, key });
      return c.json({ set: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── DELETE /contexts/:name/variables/:key ─ delete variable ──
  app.delete('/contexts/:name/variables/:key', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.delete');
      const orgId = c.req.query('orgId');
      const name = c.req.param('name');
      const key = c.req.param('key');
      if (!orgId) return c.json({ error: 'orgId required' }, 400);
      const env = await envStore.getByName(orgId, name);
      if (!env) {
        return c.json({ error: `context not found (org=${orgId}, name=${name})` }, 404);
      }
      await variableStore.deleteVar(orgId, env.id, key);
      logger.info('context variable deleted', { orgId, context: name, key });
      return c.json({ deleted: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

function handleError(c: any, err: unknown) {
  logger.error('admin-contexts route failed', { error: toErrorMessage(err) });
  return handleAdminError(c, err, logger);
}
