/**
 * Admin API routes for cluster-global (fleet-wide) orchestrator tunables.
 *
 * Exposes GET / PATCH `/api/v1/admin/cluster-settings` so `kici-admin
 * cluster-settings` can read and write the single `cluster_settings` row
 * (id='default') without going through the Platform dashboard proxy — the CLI
 * stays operable even when Platform is unavailable.
 *
 * These knobs are fleet-wide, not per-tenant, so the route is deliberately NOT
 * under `/orgs/:customerId/*`. Mutations require the `secret.write` RBAC
 * capability (already granted to admin / owner roles), matching the gating
 * posture used by `admin-org-settings.ts`.
 */
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-cluster-settings' });

interface ClusterSettingsRouteDeps {
  db: Kysely<Database>;
  rbac: RbacEnforcer;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

/**
 * camelCase (wire) ↔ snake_case (column) map. Single source of truth for the
 * Zod schema, GET projection, and PATCH upsert so they can never drift.
 */
const COLUMNS = {
  maxGithubPayloadBytes: 'max_github_payload_bytes',
  eventLogMaxPayloadBytes: 'event_log_max_payload_bytes',
  lockFileMaxBytes: 'lock_file_max_bytes',
  webhookDedupTtlMs: 'webhook_dedup_ttl_ms',
  contributorCacheTtlMs: 'contributor_cache_ttl_ms',
  eventRouterEventTtlSeconds: 'event_router_event_ttl_seconds',
  eventRouterMaxDispatchAttempts: 'event_router_max_dispatch_attempts',
  queueMaxDepth: 'queue_max_depth',
  rerouteFlapGraceMs: 'reroute_flap_grace_ms',
  maxFanoutHosts: 'max_fanout_hosts',
  eventRouterRateLimitPerWorkflowPerMinute: 'event_router_rate_limit_per_workflow_per_minute',
  cacheMaxTarballBytes: 'cache_max_tarball_bytes',
  cacheTtlDays: 'cache_ttl_days',
  checkRunTrackingTtlDays: 'check_run_tracking_ttl_days',
  concurrencyWaitTimeoutMs: 'concurrency_wait_timeout_ms',
  agentTokenTtlMs: 'agent_token_ttl_ms',
  ownershipDbCheckTimeoutMs: 'ownership_db_check_timeout_ms',
} as const;

type CamelKnob = keyof typeof COLUMNS;

/**
 * Text-valued cluster knobs. Kept in a separate map from {@link COLUMNS} so the
 * numeric projection / merge stay `number | null` end to end — the two families
 * are validated, projected, and merged side by side rather than by widening the
 * numeric types.
 */
const STRING_COLUMNS = {
  dashboardVerifiedIssuer: 'dashboard_verified_issuer',
} as const;

type CamelStringKnob = keyof typeof STRING_COLUMNS;

// Per-knob minimum floors mirroring the config.ts field constraints.
const updateSchema = z.object({
  maxGithubPayloadBytes: z.number().int().min(1024).nullable().optional(),
  eventLogMaxPayloadBytes: z.number().int().min(1024).nullable().optional(),
  lockFileMaxBytes: z.number().int().min(1024).nullable().optional(),
  webhookDedupTtlMs: z.number().int().min(1000).nullable().optional(),
  contributorCacheTtlMs: z.number().int().min(1000).nullable().optional(),
  eventRouterEventTtlSeconds: z.number().int().min(1).nullable().optional(),
  eventRouterMaxDispatchAttempts: z.number().int().min(1).nullable().optional(),
  queueMaxDepth: z.number().int().min(1).nullable().optional(),
  rerouteFlapGraceMs: z.number().int().min(1000).nullable().optional(),
  maxFanoutHosts: z.number().int().min(1).nullable().optional(),
  eventRouterRateLimitPerWorkflowPerMinute: z.number().int().min(1).nullable().optional(),
  cacheMaxTarballBytes: z.number().int().min(1024).nullable().optional(),
  cacheTtlDays: z.number().int().min(1).nullable().optional(),
  /** 0 disables the check-run tracking retention sweep, so the floor is 0, not 1. */
  checkRunTrackingTtlDays: z.number().int().min(0).nullable().optional(),
  concurrencyWaitTimeoutMs: z.number().int().min(1000).nullable().optional(),
  agentTokenTtlMs: z.number().int().min(1000).nullable().optional(),
  ownershipDbCheckTimeoutMs: z.number().int().min(100).nullable().optional(),
  /**
   * Verified-tier origin for browser-sealed dashboard writes. Must be an
   * absolute http(s) origin (the dashboard fetches `<issuer>/.well-known/jwks.json`
   * from it and shows it to the operator); null clears the override.
   */
  dashboardVerifiedIssuer: z
    .string()
    .trim()
    .refine((v) => /^https?:\/\/[^\s]+$/.test(v), {
      message: 'dashboardVerifiedIssuer must be an absolute http(s) URL',
    })
    .nullable()
    .optional(),
});

type ProjectedClusterSettings = Record<CamelKnob, number | null> &
  Record<CamelStringKnob, string | null>;

/** Coerce a pg BIGINT/INTEGER (string | number | null) into a JS number | null. */
function toNumber(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function projectRow(row: Record<string, unknown> | undefined): ProjectedClusterSettings {
  const out = {} as ProjectedClusterSettings;
  for (const [camel, snake] of Object.entries(COLUMNS) as [CamelKnob, string][]) {
    out[camel] = toNumber(row?.[snake] as string | number | null | undefined);
  }
  for (const [camel, snake] of Object.entries(STRING_COLUMNS) as [CamelStringKnob, string][]) {
    const v = row?.[snake];
    out[camel] = typeof v === 'string' && v.length > 0 ? v : null;
  }
  return out;
}

export function createClusterSettingsRoutes(deps: ClusterSettingsRouteDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // Fleet-wide, not per-routing-key; routing-key tokens are refused outright.
  app.use('/cluster-settings', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // GET /api/v1/admin/cluster-settings
  app.get('/cluster-settings', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const row = await deps.db
        .selectFrom('cluster_settings')
        .selectAll()
        .where('id', '=', 'default')
        .executeTakeFirst();
      return c.json({ settings: projectRow(row) });
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // PATCH /api/v1/admin/cluster-settings
  app.patch('/cluster-settings', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.write');
      const body = updateSchema.parse(await c.req.json());

      const existing = await deps.db
        .selectFrom('cluster_settings')
        .selectAll()
        .where('id', '=', 'default')
        .executeTakeFirst();

      // Overlay each provided field on the existing value; undefined = leave
      // as-is, an explicit null clears the override → cluster default. Track
      // whether any knob actually changes so the monotonic `version` (advertised
      // to DB-less workers so they pull the new settings) bumps only on a real
      // change and never on a no-op PATCH.
      const existingRow = existing as Record<string, unknown> | undefined;
      const merged: Record<string, number | string | null> = {};
      let changed = false;
      for (const [camel, snake] of Object.entries(COLUMNS) as [CamelKnob, string][]) {
        const cur = toNumber(existingRow?.[snake] as string | number | null | undefined);
        const provided = body[camel];
        const next = provided !== undefined ? provided : cur;
        merged[snake] = next;
        if (provided !== undefined && next !== cur) changed = true;
      }
      for (const [camel, snake] of Object.entries(STRING_COLUMNS) as [CamelStringKnob, string][]) {
        const rawCur = existingRow?.[snake];
        const cur = typeof rawCur === 'string' && rawCur.length > 0 ? rawCur : null;
        const provided = body[camel];
        const next = provided !== undefined ? (provided === null ? null : provided) : cur;
        merged[snake] = next;
        if (provided !== undefined && next !== cur) changed = true;
      }
      const currentVersion = Number(
        (existingRow?.version as string | number | null | undefined) ?? 0,
      );
      const nextVersion = changed ? currentVersion + 1 : currentVersion;

      await deps.db
        .insertInto('cluster_settings')
        .values({ id: 'default', ...merged, version: nextVersion } as never)
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            ...merged,
            version: nextVersion,
            updated_at: sql<Date>`now()`,
          } as never),
        )
        .execute();

      const updated = await deps.db
        .selectFrom('cluster_settings')
        .selectAll()
        .where('id', '=', 'default')
        .executeTakeFirst();
      return c.json({ settings: projectRow(updated) });
    } catch (err) {
      logger.error('Failed to update cluster settings', { error: toErrorMessage(err) });
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
