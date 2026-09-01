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
import { CACHE_MAX_ENTRIES_CEILING } from '../cluster/cluster-settings-reader.js';
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
  /** @deprecated Read and written; no runtime read consumes it. Removed at v1.0.0. */
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
  unroutableGraceMs: 'unroutable_grace_ms',
  ingestOverflowClaimTimeoutMs: 'ingest_overflow_claim_timeout_ms',
  lockfileCacheMax: 'lockfile_cache_max',
  lockfileCacheMaxBytes: 'lockfile_cache_max_bytes',
  lockfileCacheTtlMs: 'lockfile_cache_ttl_ms',
  contentCacheMax: 'content_cache_max',
  contentCacheMaxBytes: 'content_cache_max_bytes',
  contentCacheTtlMs: 'content_cache_ttl_ms',
  globalEvalRoundTimeoutMs: 'global_eval_round_timeout_ms',
  globalEvalCandidateTimeoutMs: 'global_eval_candidate_timeout_ms',
  globalEvalCacheMax: 'global_eval_cache_max',
  globalEvalWaitTimeoutMs: 'global_eval_wait_timeout_ms',
  scalerReapIntervalMs: 'scaler_reap_interval_ms',
  scalerReapStrandedTimeoutMs: 'scaler_reap_stranded_timeout_ms',
  scalerReapReattemptIntervalMs: 'scaler_reap_reattempt_interval_ms',
  scalerClaimRetentionMs: 'scaler_claim_retention_ms',
  scalerProvisionBackoffBaseMs: 'scaler_provision_backoff_base_ms',
  scalerProvisionBackoffMaxMs: 'scaler_provision_backoff_max_ms',
  scalerProvisionMaxConsecutiveFailures: 'scaler_provision_max_consecutive_failures',
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

/**
 * Boolean-valued cluster knobs. A third map rather than a widened
 * {@link COLUMNS}: the numeric projection and merge stay `number | null` end to
 * end, and a boolean `false` must never be confused with an unset `null` the
 * way a falsy number would be.
 */
const BOOLEAN_COLUMNS = {
  globalWorkflowsEnabled: 'global_workflows_enabled',
} as const;

type CamelBooleanKnob = keyof typeof BOOLEAN_COLUMNS;

// Per-knob minimum floors mirroring the config.ts field constraints.
const updateSchema = z.object({
  maxGithubPayloadBytes: z.number().int().min(1024).nullable().optional(),
  eventLogMaxPayloadBytes: z.number().int().min(1024).nullable().optional(),
  lockFileMaxBytes: z.number().int().min(1024).nullable().optional(),
  webhookDedupTtlMs: z.number().int().min(1000).nullable().optional(),
  /** @deprecated Still accepted and stored; no runtime read consumes it. Removed at v1.0.0. */
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
  /** 0 disables unroutable fast-fail, so the floor is 0, not 1000. */
  unroutableGraceMs: z.number().int().min(0).nullable().optional(),
  /**
   * Floor of 60s: reclaiming a claim sooner than a pipeline can plausibly
   * finish makes the drain pass re-run work that is still in flight.
   */
  ingestOverflowClaimTimeoutMs: z.number().int().min(60_000).nullable().optional(),
  /**
   * Lock-file and Tier-1 content cache sizing. Structural to the underlying
   * LRU, which is built once at boot, so a change lands at the next restart.
   *
   * The two entry counts are capped at {@link CACHE_MAX_ENTRIES_CEILING}: the
   * LRU allocates its index arrays eagerly from `max`, so an unbounded value
   * crashes `bootstrapOrchestrator` before the admin API listens — taking away
   * the only route back to the stored value. This rejection is the good error
   * message; `clampCacheMaxEntries` at the read site is the actual guarantee,
   * since a bad value may already be stored.
   */
  lockfileCacheMax: z.number().int().min(1).max(CACHE_MAX_ENTRIES_CEILING).nullable().optional(),
  lockfileCacheMaxBytes: z.number().int().min(1024).nullable().optional(),
  lockfileCacheTtlMs: z.number().int().min(1000).nullable().optional(),
  contentCacheMax: z.number().int().min(1).max(CACHE_MAX_ENTRIES_CEILING).nullable().optional(),
  contentCacheMaxBytes: z.number().int().min(1024).nullable().optional(),
  contentCacheTtlMs: z.number().int().min(1000).nullable().optional(),
  /**
   * Tier-2 global eval round budgets. Both are read per round and shipped to
   * the agent in the round's job config, so a change lands on the next push.
   */
  globalEvalRoundTimeoutMs: z.number().int().min(1000).nullable().optional(),
  globalEvalCandidateTimeoutMs: z.number().int().min(1000).nullable().optional(),
  /**
   * Round-result cache size. Capped at {@link CACHE_MAX_ENTRIES_CEILING} for the
   * same boot-safety reason as the two cache knobs above — the LRU allocates
   * eagerly from `max`, and this one is built during bootstrap too.
   */
  globalEvalCacheMax: z.number().int().min(1).max(CACHE_MAX_ENTRIES_CEILING).nullable().optional(),
  /**
   * Orchestrator-side ceiling on waiting for a round to settle. Set it above
   * `globalEvalRoundTimeoutMs`: the agent's own budget starts only once the
   * round job is running, so a ceiling below it would fire on every round that
   * merely waited for an agent.
   */
  globalEvalWaitTimeoutMs: z.number().int().min(1000).nullable().optional(),
  /**
   * Event-scaler provision reaper. All four are read per sweep, so a change
   * lands on the next tick with no restart — the interval itself reschedules
   * the timer at the end of the sweep that observed it.
   *
   * Floor of 5s on the interval: the sweep does a table scan plus a delete, so
   * a sub-second value would hammer the database for a backstop whose whole
   * point is to run rarely.
   */
  scalerReapIntervalMs: z.number().int().min(5000).nullable().optional(),
  /**
   * Set the stranded window well above the peer heartbeat period. "Registered
   * nowhere in the cluster" is partly heartbeat-derived, so a short window can
   * read a peer that has not yet reported its agents as a strand and tear down
   * a live provision. The floor is one minute, not a safe setting.
   */
  scalerReapStrandedTimeoutMs: z.number().int().min(60_000).nullable().optional(),
  scalerReapReattemptIntervalMs: z.number().int().min(60_000).nullable().optional(),
  /**
   * Retention for expired provisioning claims. Floor of 0: an expired claim can
   * never be redeemed, so purging it the moment it expires is a legitimate
   * setting — it only costs a late redeemer the "expired" diagnostic.
   */
  scalerClaimRetentionMs: z.number().int().min(0).nullable().optional(),
  /**
   * External-provision backoff. All three are read per spawn request, so a
   * change lands on the next request with no restart.
   *
   * Floor of 1s on the base: the point of the deferral is to stop hammering a
   * provider that is already refusing work, and a sub-second first step defers
   * nothing in practice. The ceiling carries the same floor, so no setting can
   * cap a deferral below one second. Their ORDERING is checked in the PATCH
   * handler instead, against the effective pair — the patch overlaid on the
   * stored row. A patch that lowers only the ceiling carries no base for a
   * schema-level check to compare it against, and that is the case an operator
   * actually reaches.
   */
  scalerProvisionBackoffBaseMs: z.number().int().min(1000).nullable().optional(),
  scalerProvisionBackoffMaxMs: z.number().int().min(1000).nullable().optional(),
  /**
   * Floor of 1: the count is "how many consecutive failures before the refusal
   * names repeated failure", and 0 would mean a scaler that has never failed is
   * already past its limit.
   */
  scalerProvisionMaxConsecutiveFailures: z.number().int().min(1).nullable().optional(),
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
  /**
   * Fleet-wide master switch for global workflows. null clears the override →
   * the orchestrator's configured default (`KICI_GLOBAL_WORKFLOWS_ENABLED`).
   */
  globalWorkflowsEnabled: z.boolean().nullable().optional(),
});

type ProjectedClusterSettings = Record<CamelKnob, number | null> &
  Record<CamelStringKnob, string | null> &
  Record<CamelBooleanKnob, boolean | null>;

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
  for (const [camel, snake] of Object.entries(BOOLEAN_COLUMNS) as [CamelBooleanKnob, string][]) {
    const v = row?.[snake];
    out[camel] = typeof v === 'boolean' ? v : null;
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
      const merged: Record<string, number | string | boolean | null> = {};
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
      for (const [camel, snake] of Object.entries(BOOLEAN_COLUMNS) as [
        CamelBooleanKnob,
        string,
      ][]) {
        const rawCur = existingRow?.[snake];
        const cur = typeof rawCur === 'boolean' ? rawCur : null;
        const provided = body[camel];
        const next = provided !== undefined ? provided : cur;
        merged[snake] = next;
        if (provided !== undefined && next !== cur) changed = true;
      }
      // The orchestrator's wait ceiling must exceed the agent's round budget:
      // the agent's budget starts only once the round job is RUNNING, so a
      // ceiling at or below it fires on every round that merely waited for a
      // free agent — every round fails, silently and permanently. Checked on
      // the EFFECTIVE values (patch overlaid on the stored row), so setting
      // either one alone is covered.
      //
      // A null on either side means "the orchestrator's configured default
      // applies", and this route does not know that number, so the pair is
      // only comparable when both are set. That is the case an operator
      // actually reaches by tuning one of them.
      const roundBudget = merged[COLUMNS.globalEvalRoundTimeoutMs];
      const waitCeiling = merged[COLUMNS.globalEvalWaitTimeoutMs];
      if (
        typeof roundBudget === 'number' &&
        typeof waitCeiling === 'number' &&
        waitCeiling <= roundBudget
      ) {
        return c.json(
          {
            error:
              `globalEvalWaitTimeoutMs (${waitCeiling}) must be greater than ` +
              `globalEvalRoundTimeoutMs (${roundBudget}): the agent's round budget ` +
              'starts only once the round job is running, so a lower ceiling fails every round',
          },
          400,
        );
      }

      // The adjacent axis, on the same terms. A per-candidate budget at or above
      // the whole round's lets ONE candidate consume the entire round, after
      // which every sibling is padded indeterminate and suppressed — and the
      // group is decided, so nothing retries it. Same null semantics as above.
      const candidateBudget = merged[COLUMNS.globalEvalCandidateTimeoutMs];
      if (
        typeof roundBudget === 'number' &&
        typeof candidateBudget === 'number' &&
        candidateBudget >= roundBudget
      ) {
        return c.json(
          {
            error:
              `globalEvalCandidateTimeoutMs (${candidateBudget}) must be less than ` +
              `globalEvalRoundTimeoutMs (${roundBudget}): a per-candidate budget that ` +
              'can consume the whole round suppresses every sibling workflow in it',
          },
          400,
        );
      }

      // Third ordering constraint, on the same terms as the two above. The
      // external-provision backoff is `min(base * 2^(n-1), ceiling)`, so a
      // ceiling below the base collapses it to a constant from the very first
      // failure — the growth the two knobs exist to express never happens, and
      // nothing at runtime reports that it did not. Same null semantics: the
      // pair is only comparable when both are set.
      const backoffBase = merged[COLUMNS.scalerProvisionBackoffBaseMs];
      const backoffCeiling = merged[COLUMNS.scalerProvisionBackoffMaxMs];
      if (
        typeof backoffBase === 'number' &&
        typeof backoffCeiling === 'number' &&
        backoffCeiling < backoffBase
      ) {
        return c.json(
          {
            error:
              `scalerProvisionBackoffMaxMs (${backoffCeiling}) must be at least ` +
              `scalerProvisionBackoffBaseMs (${backoffBase}): a ceiling below the base ` +
              'collapses the backoff to a constant from the first failure',
          },
          400,
        );
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
