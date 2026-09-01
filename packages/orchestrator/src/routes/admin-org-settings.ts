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
import { canonicalizeCapability, isKnownCapability } from '@kici-dev/engine';
import {
  invalidRepoPatternReason,
  repoPatternEntrySchema,
} from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type { RepoPatternEntry } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import {
  DashboardWriteOperation,
  dashboardWritePolicyMapSchema,
  resolveFullPolicyView,
  resolveFullPolicyStateView,
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
   * Applies when `cluster_settings.global_workflows_enabled` is NULL —
   * `config.globalWorkflowsEnabled`.
   */
  globalWorkflowsEnabledDefault: boolean;
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

/**
 * A repo-pattern list that additionally refuses negation forms. The entry
 * schema itself stays permissive so rows already stored in `org_settings` keep
 * parsing on read paths; the refusal applies only where an operator writes.
 */
const validatedPatternList = z.array(repoPatternEntrySchema).superRefine((entries, ctx) => {
  for (const [i, entry] of entries.entries()) {
    const reason = invalidRepoPatternReason(entry.pattern);
    if (reason) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'pattern'],
        message: `'${entry.pattern}': ${reason}`,
      });
    }
  }
});

const updateSchema = z
  .object({
    customerId: z.string().min(1),
    allowedRepos: validatedPatternList.nullable().optional(),
    deniedRepos: validatedPatternList.nullable().optional(),
    elevatedRepos: validatedPatternList.nullable().optional(),
    allowHttpNpmRegistries: z.boolean().optional(),
    allowUntrustedDockerfileBuilds: z.boolean().optional(),
    // null clears the per-org override and falls back to the cluster-wide
    // default; a positive integer sets a per-org value.
    userCacheQuotaBytes: z.number().int().positive().nullable().optional(),
    userCacheTtlMs: z.number().int().positive().nullable().optional(),
    artifactQuotaBytes: z.number().int().positive().nullable().optional(),
    artifactTtlMs: z.number().int().positive().nullable().optional(),
    // Per-org per-artifact size cap (bytes) + per-run artifact count cap. null
    // clears the override → cluster-wide default; a positive integer sets it.
    artifactMaxBytes: z.number().int().positive().nullable().optional(),
    artifactMaxPerRun: z.number().int().positive().nullable().optional(),
    dispatchAckTimeoutMs: z.number().int().min(1000).nullable().optional(),
    // Per-org webhook-ingest concurrency cap. null clears the override (fall back
    // to the cluster-wide default); a positive integer sets a per-org value.
    ingestMaxConcurrency: z.number().int().min(1).nullable().optional(),
    // Per-org scaler spawn deadline (ms). null clears the override → cluster
    // default; a value >= 1000 sets a per-org override.
    scalerSpawnTimeoutMs: z.number().int().min(1000).nullable().optional(),
    // Reroute tunables. null clears the per-org override (fall back to the
    // cluster-wide config default); a positive value sets a per-org override.
    rerouteSpawnWindowMs: z.number().int().min(1000).nullable().optional(),
    rerouteAckTimeoutMs: z.number().int().min(1000).nullable().optional(),
    rerouteMaxHops: z.number().int().min(1).nullable().optional(),
    // Per-org DB-backup freshness WARN threshold (hours). null clears the
    // override (fall back to the cluster-wide config default).
    backupStalenessWarnHours: z.number().int().min(1).nullable().optional(),
    // Per-org dispatch-queue job timeout (ms). null clears the override → cluster
    // default (config.queueTimeoutMs). 0 = indefinite (no expiry).
    queueTimeoutMs: z.number().int().min(0).nullable().optional(),
    // Approval policy. Both have NOT NULL defaults in the DB, so they are not
    // nullable here — a value always replaces the current one.
    approvalExpirySeconds: z.number().int().min(1).optional(),
    allowSelfApproval: z.boolean().optional(),
    // Container-sandbox escape-hatch allow-list. null clears the override →
    // deny-all default; an array sets the allowed Linux capabilities (each
    // validated as a real capability and stored canonicalized). A boolean toggles
    // whether a workflow may request `sandbox: { network: 'host' }`.
    sandboxAllowedCapabilities: z.array(z.string()).nullable().optional(),
    sandboxAllowHostNetwork: z.boolean().nullable().optional(),
  })
  .strict();

interface ProjectedSettings {
  customerId: string;
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  elevatedRepos: RepoPatternEntry[] | null;
  allowHttpNpmRegistries: boolean;
  allowUntrustedDockerfileBuilds: boolean;
  /** Per-org user-cache byte quota; null = cluster-wide default. */
  userCacheQuotaBytes: number | null;
  /** Per-org user-cache entry TTL (ms); null = cluster-wide default. */
  userCacheTtlMs: number | null;
  /** Per-org artifact byte quota; null = cluster-wide default. */
  artifactQuotaBytes: number | null;
  /** Per-org artifact TTL (ms); null = cluster-wide default. */
  artifactTtlMs: number | null;
  /** Per-org per-artifact size cap (bytes); null = cluster-wide default. */
  artifactMaxBytes: number | null;
  /** Per-org per-run artifact count cap; null = cluster-wide default. */
  artifactMaxPerRun: number | null;
  /** Per-org dispatch-acknowledgment deadline (ms); null = cluster-wide default. */
  dispatchAckTimeoutMs: number | null;
  /** Per-org webhook-ingest concurrency cap; null = cluster-wide default. */
  ingestMaxConcurrency: number | null;
  /** Per-org scaler spawn deadline (ms); null = cluster-wide default. */
  scalerSpawnTimeoutMs: number | null;
  /** Per-org reroute spawn window (ms); null = cluster-wide default. */
  rerouteSpawnWindowMs: number | null;
  /** Per-org reroute ACK timeout (ms); null = cluster-wide default. */
  rerouteAckTimeoutMs: number | null;
  /** Per-org reroute max hops; null = cluster-wide default. */
  rerouteMaxHops: number | null;
  /** Per-org backup-freshness WARN threshold (hours); null = cluster default. */
  backupStalenessWarnHours: number | null;
  /** Per-org dispatch-queue job timeout (ms); null = cluster default. */
  queueTimeoutMs: number | null;
  /** Per-org held-approval expiry (seconds). */
  approvalExpirySeconds: number;
  /** Whether a run's triggerer may self-approve its held elements. */
  allowSelfApproval: boolean;
  /** Container-sandbox capabilities a workflow may request; [] = deny all. */
  sandboxAllowedCapabilities: string[];
  /** Whether a workflow may request host networking; false = deny. */
  sandboxAllowHostNetwork: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Coerce a pg BIGINT (string | null) into a JS number | null. */
function bigintToNumber(v: string | null): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/**
 * The effective fleet-wide master switch.
 *
 * Read directly rather than through `ClusterSettingsReader`, whose 10s cache
 * would make `org-settings global-workflows show` disagree with a
 * `cluster-settings set` the operator just ran. This is a low-traffic admin
 * path, so the uncached read costs nothing and read-your-writes is worth more.
 * `admin-cluster-settings.ts` reads the same row the same way.
 */
async function readEffectiveEnabled(db: Kysely<Database>, fallback: boolean): Promise<boolean> {
  const row = await db
    .selectFrom('cluster_settings')
    .select('global_workflows_enabled')
    .where('id', '=', 'default')
    .executeTakeFirst();
  const value = row?.global_workflows_enabled;
  return typeof value === 'boolean' ? value : fallback;
}

function projectRow(
  customerId: string,
  row: OrgSettings | undefined,
  enabled: boolean,
): ProjectedSettings {
  if (!row) {
    return {
      customerId,
      enabled,
      allowedRepos: null,
      deniedRepos: null,
      elevatedRepos: null,
      allowHttpNpmRegistries: false,
      allowUntrustedDockerfileBuilds: false,
      userCacheQuotaBytes: null,
      userCacheTtlMs: null,
      artifactQuotaBytes: null,
      artifactTtlMs: null,
      artifactMaxBytes: null,
      artifactMaxPerRun: null,
      dispatchAckTimeoutMs: null,
      ingestMaxConcurrency: null,
      scalerSpawnTimeoutMs: null,
      rerouteSpawnWindowMs: null,
      rerouteAckTimeoutMs: null,
      rerouteMaxHops: null,
      backupStalenessWarnHours: null,
      queueTimeoutMs: null,
      // Mirror the DB column defaults so a customer with no row reads the
      // same effective policy a fresh row would carry.
      approvalExpirySeconds: 86400,
      allowSelfApproval: true,
      sandboxAllowedCapabilities: [],
      sandboxAllowHostNetwork: false,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    customerId,
    enabled,
    allowedRepos: row.global_workflow_allowed_repos,
    deniedRepos: row.global_workflow_denied_repos,
    elevatedRepos: row.global_workflow_elevated_repos,
    allowHttpNpmRegistries: row.allow_http_npm_registries,
    allowUntrustedDockerfileBuilds: row.allow_untrusted_dockerfile_builds,
    userCacheQuotaBytes: bigintToNumber(row.user_cache_quota_bytes),
    userCacheTtlMs: bigintToNumber(row.user_cache_ttl_ms),
    artifactQuotaBytes: bigintToNumber(row.artifact_quota_bytes),
    artifactTtlMs: bigintToNumber(row.artifact_ttl_ms),
    artifactMaxBytes: bigintToNumber(row.artifact_max_bytes),
    artifactMaxPerRun: bigintToNumber(row.artifact_max_per_run),
    dispatchAckTimeoutMs: bigintToNumber(row.dispatch_ack_timeout_ms),
    ingestMaxConcurrency: bigintToNumber(row.ingest_max_concurrency),
    scalerSpawnTimeoutMs: bigintToNumber(row.scaler_spawn_timeout_ms),
    rerouteSpawnWindowMs: bigintToNumber(row.reroute_spawn_window_ms),
    rerouteAckTimeoutMs: bigintToNumber(row.reroute_ack_timeout_ms),
    rerouteMaxHops: row.reroute_max_hops,
    backupStalenessWarnHours: row.backup_staleness_warn_hours,
    queueTimeoutMs: bigintToNumber(row.queue_timeout_ms),
    approvalExpirySeconds: row.approval_expiry_seconds,
    allowSelfApproval: row.allow_self_approval,
    sandboxAllowedCapabilities: row.sandbox_allowed_capabilities ?? [],
    sandboxAllowHostNetwork: row.sandbox_allow_host_network ?? false,
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
      const enabled = await readEffectiveEnabled(deps.db, deps.globalWorkflowsEnabledDefault);
      return c.json({ settings: projectRow(customerId, row, enabled) });
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

      let allowedRepos: RepoPatternEntry[] | null = existing?.global_workflow_allowed_repos ?? null;
      let deniedRepos: RepoPatternEntry[] | null = existing?.global_workflow_denied_repos ?? null;
      let elevatedRepos: RepoPatternEntry[] | null =
        existing?.global_workflow_elevated_repos ?? null;
      let allowHttpNpmRegistries = existing?.allow_http_npm_registries ?? false;
      let allowUntrustedDockerfileBuilds = existing?.allow_untrusted_dockerfile_builds ?? false;
      // BIGINT columns: existing comes back as string | null from pg.
      let userCacheQuotaBytes: number | null = bigintToNumber(
        existing?.user_cache_quota_bytes ?? null,
      );
      let userCacheTtlMs: number | null = bigintToNumber(existing?.user_cache_ttl_ms ?? null);
      let artifactQuotaBytes: number | null = bigintToNumber(
        existing?.artifact_quota_bytes ?? null,
      );
      let artifactTtlMs: number | null = bigintToNumber(existing?.artifact_ttl_ms ?? null);
      let artifactMaxBytes: number | null = bigintToNumber(existing?.artifact_max_bytes ?? null);
      let artifactMaxPerRun: number | null = bigintToNumber(existing?.artifact_max_per_run ?? null);
      let dispatchAckTimeoutMs: number | null = bigintToNumber(
        existing?.dispatch_ack_timeout_ms ?? null,
      );
      let ingestMaxConcurrency: number | null = bigintToNumber(
        existing?.ingest_max_concurrency ?? null,
      );
      let scalerSpawnTimeoutMs: number | null = bigintToNumber(
        existing?.scaler_spawn_timeout_ms ?? null,
      );
      let rerouteSpawnWindowMs: number | null = bigintToNumber(
        existing?.reroute_spawn_window_ms ?? null,
      );
      let rerouteAckTimeoutMs: number | null = bigintToNumber(
        existing?.reroute_ack_timeout_ms ?? null,
      );
      let rerouteMaxHops: number | null = existing?.reroute_max_hops ?? null;
      let backupStalenessWarnHours: number | null = existing?.backup_staleness_warn_hours ?? null;
      let queueTimeoutMs: number | null = bigintToNumber(existing?.queue_timeout_ms ?? null);
      // NOT NULL columns: fall back to the DB defaults when no row exists yet.
      let approvalExpirySeconds: number = existing?.approval_expiry_seconds ?? 86400;
      let allowSelfApproval: boolean = existing?.allow_self_approval ?? true;
      let sandboxAllowedCapabilities: string[] | null =
        existing?.sandbox_allowed_capabilities ?? null;
      let sandboxAllowHostNetwork: boolean | null = existing?.sandbox_allow_host_network ?? null;

      if (body.allowedRepos !== undefined) allowedRepos = body.allowedRepos;
      if (body.deniedRepos !== undefined) deniedRepos = body.deniedRepos;
      if (body.elevatedRepos !== undefined) elevatedRepos = body.elevatedRepos;
      if (body.allowHttpNpmRegistries !== undefined)
        allowHttpNpmRegistries = body.allowHttpNpmRegistries;
      if (body.allowUntrustedDockerfileBuilds !== undefined)
        allowUntrustedDockerfileBuilds = body.allowUntrustedDockerfileBuilds;
      // null is a meaningful value here (clear the override → fall back to the
      // cluster-wide default), so distinguish it from undefined (leave as-is).
      if (body.userCacheQuotaBytes !== undefined) userCacheQuotaBytes = body.userCacheQuotaBytes;
      if (body.userCacheTtlMs !== undefined) userCacheTtlMs = body.userCacheTtlMs;
      if (body.artifactQuotaBytes !== undefined) artifactQuotaBytes = body.artifactQuotaBytes;
      if (body.artifactTtlMs !== undefined) artifactTtlMs = body.artifactTtlMs;
      if (body.artifactMaxBytes !== undefined) artifactMaxBytes = body.artifactMaxBytes;
      if (body.artifactMaxPerRun !== undefined) artifactMaxPerRun = body.artifactMaxPerRun;
      if (body.dispatchAckTimeoutMs !== undefined) dispatchAckTimeoutMs = body.dispatchAckTimeoutMs;
      if (body.ingestMaxConcurrency !== undefined) ingestMaxConcurrency = body.ingestMaxConcurrency;
      if (body.scalerSpawnTimeoutMs !== undefined) scalerSpawnTimeoutMs = body.scalerSpawnTimeoutMs;
      if (body.rerouteSpawnWindowMs !== undefined) rerouteSpawnWindowMs = body.rerouteSpawnWindowMs;
      if (body.rerouteAckTimeoutMs !== undefined) rerouteAckTimeoutMs = body.rerouteAckTimeoutMs;
      if (body.rerouteMaxHops !== undefined) rerouteMaxHops = body.rerouteMaxHops;
      if (body.backupStalenessWarnHours !== undefined)
        backupStalenessWarnHours = body.backupStalenessWarnHours;
      if (body.queueTimeoutMs !== undefined) queueTimeoutMs = body.queueTimeoutMs;
      if (body.approvalExpirySeconds !== undefined)
        approvalExpirySeconds = body.approvalExpirySeconds;
      if (body.allowSelfApproval !== undefined) allowSelfApproval = body.allowSelfApproval;
      if (body.sandboxAllowHostNetwork !== undefined)
        sandboxAllowHostNetwork = body.sandboxAllowHostNetwork;
      if (body.sandboxAllowedCapabilities !== undefined) {
        if (body.sandboxAllowedCapabilities === null) {
          sandboxAllowedCapabilities = null;
        } else {
          // Reject an operator typo loudly (an allow-listed garbage cap would
          // silently never match) and store the canonical bare uppercase form
          // so the reader/resolver compare canonical-to-canonical.
          const bad = body.sandboxAllowedCapabilities.find((cap) => !isKnownCapability(cap));
          if (bad !== undefined) {
            return c.json({ error: `unknown Linux capability '${bad}'` }, 400);
          }
          sandboxAllowedCapabilities = body.sandboxAllowedCapabilities.map(canonicalizeCapability);
        }
      }

      const allowedJson = serializeJsonbList(allowedRepos);
      const deniedJson = serializeJsonbList(deniedRepos);
      const elevatedJson = serializeJsonbList(elevatedRepos);

      await deps.db
        .insertInto('org_settings')
        .values({
          customer_id: body.customerId,
          global_workflow_allowed_repos: allowedJson,
          global_workflow_denied_repos: deniedJson,
          global_workflow_elevated_repos: elevatedJson,
          allow_http_npm_registries: allowHttpNpmRegistries,
          allow_untrusted_dockerfile_builds: allowUntrustedDockerfileBuilds,
          user_cache_quota_bytes: userCacheQuotaBytes,
          user_cache_ttl_ms: userCacheTtlMs,
          artifact_quota_bytes: artifactQuotaBytes,
          artifact_ttl_ms: artifactTtlMs,
          artifact_max_bytes: artifactMaxBytes,
          artifact_max_per_run: artifactMaxPerRun,
          dispatch_ack_timeout_ms: dispatchAckTimeoutMs,
          ingest_max_concurrency: ingestMaxConcurrency,
          scaler_spawn_timeout_ms: scalerSpawnTimeoutMs,
          reroute_spawn_window_ms: rerouteSpawnWindowMs,
          reroute_ack_timeout_ms: rerouteAckTimeoutMs,
          reroute_max_hops: rerouteMaxHops,
          backup_staleness_warn_hours: backupStalenessWarnHours,
          queue_timeout_ms: queueTimeoutMs,
          approval_expiry_seconds: approvalExpirySeconds,
          allow_self_approval: allowSelfApproval,
          sandbox_allowed_capabilities: sandboxAllowedCapabilities,
          sandbox_allow_host_network: sandboxAllowHostNetwork,
        })
        .onConflict((oc) =>
          oc.column('customer_id').doUpdateSet({
            global_workflow_allowed_repos: allowedJson,
            global_workflow_denied_repos: deniedJson,
            global_workflow_elevated_repos: elevatedJson,
            allow_http_npm_registries: allowHttpNpmRegistries,
            allow_untrusted_dockerfile_builds: allowUntrustedDockerfileBuilds,
            user_cache_quota_bytes: userCacheQuotaBytes,
            user_cache_ttl_ms: userCacheTtlMs,
            artifact_quota_bytes: artifactQuotaBytes,
            artifact_ttl_ms: artifactTtlMs,
            artifact_max_bytes: artifactMaxBytes,
            artifact_max_per_run: artifactMaxPerRun,
            dispatch_ack_timeout_ms: dispatchAckTimeoutMs,
            ingest_max_concurrency: ingestMaxConcurrency,
            scaler_spawn_timeout_ms: scalerSpawnTimeoutMs,
            reroute_spawn_window_ms: rerouteSpawnWindowMs,
            reroute_ack_timeout_ms: rerouteAckTimeoutMs,
            reroute_max_hops: rerouteMaxHops,
            backup_staleness_warn_hours: backupStalenessWarnHours,
            queue_timeout_ms: queueTimeoutMs,
            approval_expiry_seconds: approvalExpirySeconds,
            allow_self_approval: allowSelfApproval,
            sandbox_allowed_capabilities: sandboxAllowedCapabilities,
            sandbox_allow_host_network: sandboxAllowHostNetwork,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();

      const updated = await deps.db
        .selectFrom('org_settings')
        .selectAll()
        .where('customer_id', '=', body.customerId)
        .executeTakeFirst();
      const enabled = await readEffectiveEnabled(deps.db, deps.globalWorkflowsEnabledDefault);
      return c.json({ settings: projectRow(body.customerId, updated, enabled) });
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
        states: resolveFullPolicyStateView(stored),
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
        states: resolveFullPolicyStateView(stored),
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
