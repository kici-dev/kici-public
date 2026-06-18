/**
 * Admin API routes for org-level global workflow settings.
 *
 * Exposes GET / PATCH `/api/v1/admin/org-settings/global-workflows` so
 * `kici-admin` can read and write the per-org row in `org_settings`
 * without going through the Platform dashboard proxy — the CLI stays
 * operable even when Platform is unavailable.
 *
 * Mutations require the `secret.write` RBAC capability (already granted to
 * admin / owner roles), matching the gating posture used by source admin.
 */
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { repoPatternEntrySchema } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type { RepoPatternEntry } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import {
  DashboardWriteOperation,
  dashboardWritePolicyMapSchema,
  resolveFullPolicyView,
} from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Database, OrgSettings } from '../db/types.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import {
  getDashboardWritePolicy,
  resetDashboardWritePolicy,
  setDashboardWritePolicy,
  type PolicyChangeEvent,
} from '../policy/dashboard-write-policy.js';
import type { AccessLogWriter } from '../audit/access-log.js';

const logger = createLogger({ prefix: 'admin-org-settings' });

interface OrgSettingsRouteDeps {
  db: Kysely<Database>;
  rbac: RbacEnforcer;
  /**
   * Optional — when wired, each `dashboard_write_policy` flip emits one
   * `access_log` row (`org_settings.dashboard_write_policy.update`)
   * carrying the operation name + prior/next state in `actor_meta`.
   * Reset calls additionally stamp `reset: true`.
   */
  accessLog?: AccessLogWriter;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

const updateSchema = z.object({
  customerId: z.string().min(1),
  enabled: z.boolean().optional(),
  allowedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  deniedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  elevatedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  allowHttpNpmRegistries: z.boolean().optional(),
  // null clears the per-org override and falls back to the cluster-wide
  // default; a positive integer sets a per-org value.
  userCacheQuotaBytes: z.number().int().positive().nullable().optional(),
  userCacheTtlMs: z.number().int().positive().nullable().optional(),
  dispatchAckTimeoutMs: z.number().int().min(1000).nullable().optional(),
  // Approval policy. Both have NOT NULL defaults in the DB, so they are not
  // nullable here — a value always replaces the current one.
  approvalExpirySeconds: z.number().int().min(1).optional(),
  allowSelfApproval: z.boolean().optional(),
});

interface ProjectedSettings {
  customerId: string;
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  elevatedRepos: RepoPatternEntry[] | null;
  allowHttpNpmRegistries: boolean;
  /** Per-org user-cache byte quota; null = cluster-wide default. */
  userCacheQuotaBytes: number | null;
  /** Per-org user-cache entry TTL (ms); null = cluster-wide default. */
  userCacheTtlMs: number | null;
  /** Per-org dispatch-acknowledgment deadline (ms); null = cluster-wide default. */
  dispatchAckTimeoutMs: number | null;
  /** Per-org held-approval expiry (seconds). */
  approvalExpirySeconds: number;
  /** Whether a run's triggerer may self-approve its held elements. */
  allowSelfApproval: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Coerce a pg BIGINT (string | null) into a JS number | null. */
function bigintToNumber(v: string | null): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function projectRow(customerId: string, row: OrgSettings | undefined): ProjectedSettings {
  if (!row) {
    return {
      customerId,
      enabled: false,
      allowedRepos: null,
      deniedRepos: null,
      elevatedRepos: null,
      allowHttpNpmRegistries: false,
      userCacheQuotaBytes: null,
      userCacheTtlMs: null,
      dispatchAckTimeoutMs: null,
      // Mirror the DB column defaults so a customer with no row reads the
      // same effective policy a fresh row would carry.
      approvalExpirySeconds: 86400,
      allowSelfApproval: true,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    customerId,
    enabled: row.global_workflows_enabled,
    allowedRepos: row.global_workflow_allowed_repos,
    deniedRepos: row.global_workflow_denied_repos,
    elevatedRepos: row.global_workflow_elevated_repos,
    allowHttpNpmRegistries: row.allow_http_npm_registries,
    userCacheQuotaBytes: bigintToNumber(row.user_cache_quota_bytes),
    userCacheTtlMs: bigintToNumber(row.user_cache_ttl_ms),
    dispatchAckTimeoutMs: bigintToNumber(row.dispatch_ack_timeout_ms),
    approvalExpirySeconds: row.approval_expiry_seconds,
    allowSelfApproval: row.allow_self_approval,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function serializeJsonbList(list: RepoPatternEntry[] | null | undefined): string | null {
  if (list === null || list === undefined) return null;
  return JSON.stringify(list);
}

export function createOrgSettingsRoutes(deps: OrgSettingsRouteDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // Org-settings is per-customer (orgId), not per-routing-key; routing-key
  // tokens are refused outright.
  app.use('/org-settings/*', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // GET /api/v1/admin/org-settings/global-workflows?customerId=kiciStg00001
  app.get('/org-settings/global-workflows', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const customerId = c.req.query('customerId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
      const row = await deps.db
        .selectFrom('org_settings')
        .selectAll()
        .where('customer_id', '=', customerId)
        .executeTakeFirst();
      return c.json({ settings: projectRow(customerId, row) });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // PATCH /api/v1/admin/org-settings/global-workflows
  app.patch('/org-settings/global-workflows', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = updateSchema.parse(await c.req.json());

      const existing = await deps.db
        .selectFrom('org_settings')
        .selectAll()
        .where('customer_id', '=', body.customerId)
        .executeTakeFirst();

      let enabled = existing?.global_workflows_enabled ?? false;
      let allowedRepos: RepoPatternEntry[] | null = existing?.global_workflow_allowed_repos ?? null;
      let deniedRepos: RepoPatternEntry[] | null = existing?.global_workflow_denied_repos ?? null;
      let elevatedRepos: RepoPatternEntry[] | null =
        existing?.global_workflow_elevated_repos ?? null;
      let allowHttpNpmRegistries = existing?.allow_http_npm_registries ?? false;
      // BIGINT columns: existing comes back as string | null from pg.
      let userCacheQuotaBytes: number | null = bigintToNumber(
        existing?.user_cache_quota_bytes ?? null,
      );
      let userCacheTtlMs: number | null = bigintToNumber(existing?.user_cache_ttl_ms ?? null);
      let dispatchAckTimeoutMs: number | null = bigintToNumber(
        existing?.dispatch_ack_timeout_ms ?? null,
      );
      // NOT NULL columns: fall back to the DB defaults when no row exists yet.
      let approvalExpirySeconds: number = existing?.approval_expiry_seconds ?? 86400;
      let allowSelfApproval: boolean = existing?.allow_self_approval ?? true;

      if (body.enabled !== undefined) enabled = body.enabled;
      if (body.allowedRepos !== undefined) allowedRepos = body.allowedRepos;
      if (body.deniedRepos !== undefined) deniedRepos = body.deniedRepos;
      if (body.elevatedRepos !== undefined) elevatedRepos = body.elevatedRepos;
      if (body.allowHttpNpmRegistries !== undefined)
        allowHttpNpmRegistries = body.allowHttpNpmRegistries;
      // null is a meaningful value here (clear the override → fall back to the
      // cluster-wide default), so distinguish it from undefined (leave as-is).
      if (body.userCacheQuotaBytes !== undefined) userCacheQuotaBytes = body.userCacheQuotaBytes;
      if (body.userCacheTtlMs !== undefined) userCacheTtlMs = body.userCacheTtlMs;
      if (body.dispatchAckTimeoutMs !== undefined) dispatchAckTimeoutMs = body.dispatchAckTimeoutMs;
      if (body.approvalExpirySeconds !== undefined)
        approvalExpirySeconds = body.approvalExpirySeconds;
      if (body.allowSelfApproval !== undefined) allowSelfApproval = body.allowSelfApproval;

      const allowedJson = serializeJsonbList(allowedRepos);
      const deniedJson = serializeJsonbList(deniedRepos);
      const elevatedJson = serializeJsonbList(elevatedRepos);

      await deps.db
        .insertInto('org_settings')
        .values({
          customer_id: body.customerId,
          global_workflows_enabled: enabled,
          global_workflow_allowed_repos: allowedJson,
          global_workflow_denied_repos: deniedJson,
          global_workflow_elevated_repos: elevatedJson,
          allow_http_npm_registries: allowHttpNpmRegistries,
          user_cache_quota_bytes: userCacheQuotaBytes,
          user_cache_ttl_ms: userCacheTtlMs,
          dispatch_ack_timeout_ms: dispatchAckTimeoutMs,
          approval_expiry_seconds: approvalExpirySeconds,
          allow_self_approval: allowSelfApproval,
        })
        .onConflict((oc) =>
          oc.column('customer_id').doUpdateSet({
            global_workflows_enabled: enabled,
            global_workflow_allowed_repos: allowedJson,
            global_workflow_denied_repos: deniedJson,
            global_workflow_elevated_repos: elevatedJson,
            allow_http_npm_registries: allowHttpNpmRegistries,
            user_cache_quota_bytes: userCacheQuotaBytes,
            user_cache_ttl_ms: userCacheTtlMs,
            dispatch_ack_timeout_ms: dispatchAckTimeoutMs,
            approval_expiry_seconds: approvalExpirySeconds,
            allow_self_approval: allowSelfApproval,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();

      const updated = await deps.db
        .selectFrom('org_settings')
        .selectAll()
        .where('customer_id', '=', body.customerId)
        .executeTakeFirst();
      return c.json({ settings: projectRow(body.customerId, updated) });
    } catch (err) {
      logger.error('Failed to update global-workflow settings', { error: toErrorMessage(err) });
      return handleAdminError(c, err, logger);
    }
  });

  const dashboardWritesUpdateSchema = z.object({
    customerId: z.string().min(1),
    updates: dashboardWritePolicyMapSchema.optional(),
    reset: z.boolean().optional(),
  });

  // GET /api/v1/admin/org-settings/dashboard-writes?customerId=<id>
  app.get('/org-settings/dashboard-writes', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const customerId = c.req.query('customerId');
      if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
      const stored = await getDashboardWritePolicy(deps.db, customerId);
      return c.json({
        customerId,
        stored,
        effective: resolveFullPolicyView(stored),
      });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // PATCH /api/v1/admin/org-settings/dashboard-writes
  //   body: { customerId, updates?: {[op]: boolean}, reset?: true }
  //   updates: merge-shape; permissive default lives in the absence of a key.
  //   reset: clears every disabled flag back to permissive.
  app.patch('/org-settings/dashboard-writes', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = dashboardWritesUpdateSchema.parse(await c.req.json());
      if (body.reset && body.updates && Object.keys(body.updates).length > 0) {
        return c.json({ error: 'Provide either updates or reset, not both.' }, 400);
      }
      const actor = {
        type: 'service_account' as const,
        id: c.get('userId') as string,
      };
      const onChange = async (event: PolicyChangeEvent): Promise<void> => {
        await deps.accessLog?.record({
          orgId: event.customerId,
          routingKey: null,
          actor: event.actor,
          action: 'org_settings.dashboard_write_policy.update',
          target: { type: 'org_settings', id: event.customerId },
          requestId: null,
          source: 'admin_http',
          outcome: 'allowed',
          meta: {
            operation: event.op,
            prior_state: event.prior,
            new_state: event.next,
            ...(body.reset ? { reset: true } : {}),
          },
        });
      };
      const stored = body.reset
        ? await resetDashboardWritePolicy(deps.db, body.customerId, { actor, onChange })
        : await setDashboardWritePolicy(deps.db, body.customerId, body.updates ?? {}, {
            actor,
            onChange,
          });
      return c.json({
        customerId: body.customerId,
        stored,
        effective: resolveFullPolicyView(stored),
      });
    } catch (err) {
      logger.error('Failed to update dashboard-write policy', { error: toErrorMessage(err) });
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}

// Re-export to allow callers (tests) to type-narrow against the operation enum.
export { DashboardWriteOperation };
