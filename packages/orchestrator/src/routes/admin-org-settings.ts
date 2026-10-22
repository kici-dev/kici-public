/**
 * GET / PATCH `/api/v1/admin/org-settings/global-workflows`: lets `kici-admin`
 * read and write the per-org `org_settings` row without the Platform dashboard
 * proxy, so the CLI stays operable when the Platform is unavailable.
 *
 * Mutations require `secret.write` (granted to admin / owner), matching the
 * gating used by source admin.
 */
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  canonicalizeCapability,
  isKnownCapability,
  PLATFORM_CONNECTED_MODES,
  type OrchestratorMode,
  toIsoString,
} from '@kici-dev/engine';
import {
  invalidRepoPatternReason,
  repoPatternEntrySchema,
} from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type { RepoPatternEntry } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import {
  DashboardWriteOperation,
  dashboardWritePolicyUpdate,
  resolveFullPolicyView,
  resolveFullPolicyStateView,
} from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Database, OrgSettings } from '../db/types.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import {
  getDashboardWritePolicy,
  resetDashboardWritePolicy,
  setDashboardWritePolicy,
  HeldRunLockoutRefusedError,
  type PolicyChangeEvent,
} from '../policy/dashboard-write-policy.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

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
   * The dashboard-write policy needs it: disabling `held_runs.approve` /
   * `held_runs.reject` is coherent only where `kici-admin held-run` can still
   * answer a hold, which is independent mode alone.
   */
  mode: OrchestratorMode;
  /**
   * When wired, each `dashboard_write_policy` flip emits one `access_log` row
   * (`org_settings.dashboard_write_policy.update`) carrying the operation name
   * + prior/next state in `actor_meta`; reset calls also stamp `reset: true`.
   */
  accessLog?: AccessLogWriter;
}

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
    allowHttpNpmRegistries: z.boolean().optional(),
    allowUntrustedDockerfileBuilds: z.boolean().optional(),
    // For every nullable tunable from here through cacheUploadSettleTimeoutMs, null
    // clears the per-org override and falls back to the cluster-wide default; a
    // value sets a per-org override.
    userCacheQuotaBytes: z.number().int().positive().nullable().optional(),
    userCacheTtlMs: z.number().int().positive().nullable().optional(),
    artifactQuotaBytes: z.number().int().positive().nullable().optional(),
    artifactTtlMs: z.number().int().positive().nullable().optional(),
    // Per-artifact size cap (bytes) and per-run artifact count cap.
    artifactMaxBytes: z.number().int().positive().nullable().optional(),
    artifactMaxPerRun: z.number().int().positive().nullable().optional(),
    dispatchAckTimeoutMs: z.number().int().min(1000).nullable().optional(),
    // Webhook-ingest concurrency cap.
    ingestMaxConcurrency: z.number().int().min(1).nullable().optional(),
    // Scaler spawn deadline (ms).
    scalerSpawnTimeoutMs: z.number().int().min(1000).nullable().optional(),
    rerouteSpawnWindowMs: z.number().int().min(1000).nullable().optional(),
    rerouteAckTimeoutMs: z.number().int().min(1000).nullable().optional(),
    rerouteMaxHops: z.number().int().min(1).nullable().optional(),
    // A worker's spawn-retry budget for a rerouted job: attempts (>= 1) and the
    // wait after a failed attempt (ms, >= 0).
    rerouteSpawnMaxAttempts: z.number().int().min(1).nullable().optional(),
    rerouteSpawnRetryBackoffMs: z.number().int().min(0).nullable().optional(),
    // DB-backup freshness WARN threshold (hours).
    backupStalenessWarnHours: z.number().int().min(1).nullable().optional(),
    // Dispatch-queue job timeout (ms); cluster default is config.queueTimeoutMs.
    // 0 = indefinite (no expiry).
    queueTimeoutMs: z.number().int().min(0).nullable().optional(),
    // Bound (ms) on a build success's wait for its cache publish; 0 turns the
    // wait off.
    cacheUploadSettleTimeoutMs: z.number().int().min(0).nullable().optional(),
    // Approval policy: NOT NULL with DB defaults, so not nullable here.
    approvalExpirySeconds: z.number().int().min(1).optional(),
    allowSelfApproval: z.boolean().optional(),
    // Container-sandbox escape-hatch allow-list. null clears the override →
    // deny-all default; an array sets the allowed Linux capabilities (each
    // validated and stored canonicalized). The boolean toggles whether a
    // workflow may request `sandbox: { network: 'host' }`.
    sandboxAllowedCapabilities: z.array(z.string()).nullable().optional(),
    sandboxAllowHostNetwork: z.boolean().nullable().optional(),
  })
  .strict();

interface ProjectedSettings {
  customerId: string;
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  allowHttpNpmRegistries: boolean;
  allowUntrustedDockerfileBuilds: boolean;
  // For every nullable per-org tunable below, null = cluster-wide default.
  userCacheQuotaBytes: number | null;
  /** User-cache entry TTL (ms). */
  userCacheTtlMs: number | null;
  artifactQuotaBytes: number | null;
  /** Artifact TTL (ms). */
  artifactTtlMs: number | null;
  /** Per-artifact size cap (bytes). */
  artifactMaxBytes: number | null;
  /** Per-run artifact count cap. */
  artifactMaxPerRun: number | null;
  /** Dispatch-acknowledgment deadline (ms). */
  dispatchAckTimeoutMs: number | null;
  ingestMaxConcurrency: number | null;
  /** Scaler spawn deadline (ms). */
  scalerSpawnTimeoutMs: number | null;
  /** Reroute spawn window (ms). */
  rerouteSpawnWindowMs: number | null;
  /** Reroute ACK timeout (ms). */
  rerouteAckTimeoutMs: number | null;
  rerouteMaxHops: number | null;
  /** Spawn attempts a worker makes for a rerouted job. */
  rerouteSpawnMaxAttempts: number | null;
  /** Wait (ms) after a rerouted job's failed spawn. */
  rerouteSpawnRetryBackoffMs: number | null;
  /** Backup-freshness WARN threshold (hours). */
  backupStalenessWarnHours: number | null;
  /** Dispatch-queue job timeout (ms). */
  queueTimeoutMs: number | null;
  /** Build-cache publish settle bound (ms). */
  cacheUploadSettleTimeoutMs: number | null;
  /** Held-approval expiry (seconds). */
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
 * The effective fleet-wide master switch, read directly rather than through
 * `ClusterSettingsReader`, whose 10s cache would make `org-settings
 * global-workflows show` disagree with a `cluster-settings set` the operator
 * just ran. On this low-traffic admin path read-your-writes is worth more than
 * the cache. `admin-cluster-settings.ts` reads the same row the same way.
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
      rerouteSpawnMaxAttempts: null,
      rerouteSpawnRetryBackoffMs: null,
      backupStalenessWarnHours: null,
      queueTimeoutMs: null,
      cacheUploadSettleTimeoutMs: null,
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
    rerouteSpawnMaxAttempts: row.reroute_spawn_max_attempts,
    rerouteSpawnRetryBackoffMs: bigintToNumber(row.reroute_spawn_retry_backoff_ms),
    backupStalenessWarnHours: row.backup_staleness_warn_hours,
    queueTimeoutMs: bigintToNumber(row.queue_timeout_ms),
    cacheUploadSettleTimeoutMs: bigintToNumber(row.cache_upload_settle_timeout_ms),
    approvalExpirySeconds: row.approval_expiry_seconds,
    allowSelfApproval: row.allow_self_approval,
    sandboxAllowedCapabilities: row.sandbox_allowed_capabilities ?? [],
    sandboxAllowHostNetwork: row.sandbox_allow_host_network ?? false,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function serializeJsonbList(list: RepoPatternEntry[] | null | undefined): string | null {
  if (list === null || list === undefined) return null;
  return JSON.stringify(list);
}

export function createOrgSettingsRoutes(deps: OrgSettingsRouteDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  // Org-settings is per-customer (orgId), not per-routing-key; routing-key
  // tokens are refused outright.
  app.use('/org-settings/*', requireUnscoped);

  // GET /api/v1/admin/org-settings/global-workflows?customerId=acmeOrg00001
  app.get('/org-settings/global-workflows', async (c) => {
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
  });

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
      let rerouteSpawnMaxAttempts: number | null = existing?.reroute_spawn_max_attempts ?? null;
      let rerouteSpawnRetryBackoffMs: number | null = bigintToNumber(
        existing?.reroute_spawn_retry_backoff_ms ?? null,
      );
      let backupStalenessWarnHours: number | null = existing?.backup_staleness_warn_hours ?? null;
      let queueTimeoutMs: number | null = bigintToNumber(existing?.queue_timeout_ms ?? null);
      let cacheUploadSettleTimeoutMs: number | null = bigintToNumber(
        existing?.cache_upload_settle_timeout_ms ?? null,
      );
      // NOT NULL columns: fall back to the DB defaults when no row exists yet.
      let approvalExpirySeconds: number = existing?.approval_expiry_seconds ?? 86400;
      let allowSelfApproval: boolean = existing?.allow_self_approval ?? true;
      let sandboxAllowedCapabilities: string[] | null =
        existing?.sandbox_allowed_capabilities ?? null;
      let sandboxAllowHostNetwork: boolean | null = existing?.sandbox_allow_host_network ?? null;

      if (body.allowedRepos !== undefined) allowedRepos = body.allowedRepos;
      if (body.deniedRepos !== undefined) deniedRepos = body.deniedRepos;
      if (body.allowHttpNpmRegistries !== undefined)
        allowHttpNpmRegistries = body.allowHttpNpmRegistries;
      if (body.allowUntrustedDockerfileBuilds !== undefined)
        allowUntrustedDockerfileBuilds = body.allowUntrustedDockerfileBuilds;
      // null clears the override; undefined leaves it as-is.
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
      if (body.rerouteSpawnMaxAttempts !== undefined)
        rerouteSpawnMaxAttempts = body.rerouteSpawnMaxAttempts;
      if (body.rerouteSpawnRetryBackoffMs !== undefined)
        rerouteSpawnRetryBackoffMs = body.rerouteSpawnRetryBackoffMs;
      if (body.backupStalenessWarnHours !== undefined)
        backupStalenessWarnHours = body.backupStalenessWarnHours;
      if (body.queueTimeoutMs !== undefined) queueTimeoutMs = body.queueTimeoutMs;
      if (body.cacheUploadSettleTimeoutMs !== undefined)
        cacheUploadSettleTimeoutMs = body.cacheUploadSettleTimeoutMs;
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

      await deps.db
        .insertInto('org_settings')
        .values({
          customer_id: body.customerId,
          global_workflow_allowed_repos: allowedJson,
          global_workflow_denied_repos: deniedJson,
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
          reroute_spawn_max_attempts: rerouteSpawnMaxAttempts,
          reroute_spawn_retry_backoff_ms: rerouteSpawnRetryBackoffMs,
          backup_staleness_warn_hours: backupStalenessWarnHours,
          queue_timeout_ms: queueTimeoutMs,
          cache_upload_settle_timeout_ms: cacheUploadSettleTimeoutMs,
          approval_expiry_seconds: approvalExpirySeconds,
          allow_self_approval: allowSelfApproval,
          sandbox_allowed_capabilities: sandboxAllowedCapabilities,
          sandbox_allow_host_network: sandboxAllowHostNetwork,
        })
        .onConflict((oc) =>
          oc.column('customer_id').doUpdateSet({
            global_workflow_allowed_repos: allowedJson,
            global_workflow_denied_repos: deniedJson,
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
            reroute_spawn_max_attempts: rerouteSpawnMaxAttempts,
            reroute_spawn_retry_backoff_ms: rerouteSpawnRetryBackoffMs,
            backup_staleness_warn_hours: backupStalenessWarnHours,
            queue_timeout_ms: queueTimeoutMs,
            cache_upload_settle_timeout_ms: cacheUploadSettleTimeoutMs,
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
    updates: dashboardWritePolicyUpdate.optional(),
    reset: z.boolean().optional(),
  });

  // GET /api/v1/admin/org-settings/dashboard-writes?customerId=<id>
  app.get('/org-settings/dashboard-writes', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.read');
    const customerId = c.req.query('customerId');
    if (!customerId) return c.json({ error: 'customerId query param required' }, 400);
    const stored = await getDashboardWritePolicy(deps.db, customerId);
    return c.json({
      customerId,
      stored,
      effective: resolveFullPolicyView(stored),
      states: resolveFullPolicyStateView(stored),
      // Lets the CLI tell a held-run disable that routes the operation to
      // `kici-admin` from one that leaves no answering surface at all; the
      // policy map is mode-blind, so the render cannot infer it.
      platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
    });
  });

  // PATCH /api/v1/admin/org-settings/dashboard-writes
  //   body: { customerId, updates?: { [op]: posture }, reset?: true }
  //   updates: merge-shape; an absent key means the op's default posture.
  //   reset: every operation back to its default posture.
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
        ? await resetDashboardWritePolicy(deps.db, body.customerId, {
            actor,
            mode: deps.mode,
            onChange,
          })
        : await setDashboardWritePolicy(deps.db, body.customerId, body.updates ?? {}, {
            actor,
            mode: deps.mode,
            onChange,
          });
      return c.json({
        customerId: body.customerId,
        stored,
        effective: resolveFullPolicyView(stored),
        states: resolveFullPolicyStateView(stored),
        platformManaged: PLATFORM_CONNECTED_MODES.includes(deps.mode),
      });
    } catch (err) {
      // A refused lockout is a client-side conflict, not a server fault:
      // surfaced verbatim for the CLI and never logged at error level.
      if (err instanceof HeldRunLockoutRefusedError) {
        return c.json({ error: err.message, operations: err.operations }, 409);
      }
      // A refused posture or a malformed body is a client error, not a server fault.
      if (err instanceof z.ZodError) return handleAdminError(c, err, logger);
      logger.error('Failed to update dashboard-write policy', { error: toErrorMessage(err) });
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}

// Re-exported so tests can type-narrow against the operation enum.
export { DashboardWriteOperation };
