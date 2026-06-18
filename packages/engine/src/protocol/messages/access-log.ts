import { z } from 'zod';
import { ActorType, actorPrincipalSchema } from './actor.js';

/**
 * Access log enums + dashboard protocol schemas.
 *
 * The orchestrator `access_log` table captures every read AND
 * orchestrator-admin mutation attributable to an ActorPrincipal. These enums
 * are the single source of truth for the column values; SQL, CLI filters,
 * dashboard UI, and tests all import from here.
 *
 * secret_audit_log stays as-is for secret *mutations* (create/update/delete).
 * access_log covers secret *reveals* (read-side attribution) and all other
 * reads/mutations surfaced via Platform proxy or orchestrator admin HTTP.
 */

/** Where the access-log entry was originated from. */
export const AccessLogSource = z.enum(['platform_proxy', 'admin_http', 'admin_cli']);
export type AccessLogSource = z.infer<typeof AccessLogSource>;

/** Outcome of the attempted action. */
export const AccessLogOutcome = z.enum(['allowed', 'denied', 'error']);
export type AccessLogOutcome = z.infer<typeof AccessLogOutcome>;

/** Target object category. */
export const AccessLogTargetType = z.enum([
  'run',
  'job',
  'step',
  'payload',
  'event_log',
  'event_log_payload',
  'secret_scope',
  'environment',
  'registration',
  'backend',
  'diagnostics',
  'scaler',
  'held_run',
  'access_log',
  'event_dlq',
  'org_settings',
  'cluster_meta',
]);
export type AccessLogTargetType = z.infer<typeof AccessLogTargetType>;

/**
 * Dotted-namespace action names. Every handler that writes an access_log
 * row uses one of these values; a new handler means adding a new entry here.
 */
export const AccessLogAction = z.enum([
  'run.detail.read',
  'runs.list.read',
  'runs.filters.read',
  'sources.list.read',
  'run.payload.read',
  'run.orch_logs.read',
  'step.logs.read',
  'attestations.read',
  'run.cancel',
  'run.rerun',
  'run.manual_schedule',
  /**
   * Platform-relayed `kici run remote` trigger. Emitted by the orchestrator's
   * `test.relay.trigger` handler with the developer's PAT identity as actor,
   * so a remote run is attributable to who launched it.
   */
  'run.trigger',
  'job.cancel',
  'event_log.list.read',
  'event_log.detail.read',
  'event_log.payload.read',
  'environment.list.read',
  'environment.get.read',
  'environment.create',
  'environment.update',
  'environment.delete',
  'env_var.list.read',
  'env_var.set',
  'env_var.delete',
  'source_override.list.read',
  'source_override.set',
  'source_override.delete',
  'env_binding.list.read',
  'env_binding.set',
  'secret.list.read',
  'secret.set',
  'secret.delete',
  'secret.reveal',
  'secret_scope.create',
  'secret_scope.rename',
  'secret_scope.delete',
  'environment.history.read',
  'held_run.list.read',
  'held_run.approve',
  'held_run.reject',
  'held_run.request',
  'held_run.expire',
  'registration.list.read',
  'registration.disable',
  'registration.delete',
  'diagnostics.read',
  'scaler.capacity.read',
  'scaler.agents.read',
  'backend.list.read',
  'backend.get.read',
  'backend.sync',
  'backend.sync.one',
  'backend.test',
  'global_workflows.get.read',
  'global_workflows.update',
  /**
   * Per-org dashboard-write policy flip (set or reset). Emitted once per
   * changed operation by the orch admin `PATCH
   * /admin/org-settings/dashboard-writes` route. The `actor_meta` columns
   * `operation`, `prior_state`, `new_state`, and `reset` (when applicable)
   * identify which switch moved.
   */
  'org_settings.dashboard_write_policy.update',
  /**
   * Cluster-name rename via the orch admin `PUT /admin/cluster-name`
   * route (driven by `kici-admin cluster-name set`). The `actor_meta`
   * columns carry `prior_value` and `new_value`. Cluster-name is
   * orch-scoped, so `org_id` is null on these rows.
   */
  'cluster_name.update',
  'access_log.list.read',
  /** Event DLQ admin actions (Phase 5 — at-least-once event delivery). */
  'event_dlq.list.read',
  'event_dlq.retry',
  'event_dlq.discard',
  /** Cold-store archive emitted one chunk for a (table, tenant, day). */
  'archive_chunk',
  /** Cold-store purge deleted an expired chunk from S3 + PG bookkeeping. */
  'purge_chunk',
]);
export type AccessLogAction = z.infer<typeof AccessLogAction>;

/**
 * Single row as surfaced to the dashboard / CLI. Includes optional
 * displayName/email for `user` and `platform_operator` actors — those are
 * resolved Platform-side by joining `actor_id` against the Keycloak-backed
 * `users` table. The orchestrator never returns them; it emits a minimal
 * row and Platform enriches before forwarding to the browser.
 */
export const accessLogItemSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  routingKey: z.string().nullable(),
  actorType: ActorType,
  actorId: z.string(),
  actorMeta: z.record(z.string(), z.unknown()).nullable(),
  /** Resolved by Platform when actor_type is user / platform_operator. */
  actorEmail: z.string().nullable().optional(),
  actorDisplayName: z.string().nullable().optional(),
  action: AccessLogAction,
  targetType: AccessLogTargetType.nullable(),
  targetId: z.string().nullable(),
  requestId: z.string().nullable(),
  source: AccessLogSource,
  outcome: AccessLogOutcome,
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type AccessLogItem = z.infer<typeof accessLogItemSchema>;

/** Shared filter shape reused by Platform proxy + orchestrator HTTP + CLI. */
export const accessLogFilterSchema = z.object({
  actorType: ActorType.optional(),
  actorId: z.string().optional(),
  action: AccessLogAction.optional(),
  source: AccessLogSource.optional(),
  outcome: AccessLogOutcome.optional(),
  targetType: AccessLogTargetType.optional(),
  targetId: z.string().optional(),
  fromTimestamp: z.string().optional(),
  toTimestamp: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});
export type AccessLogFilter = z.infer<typeof accessLogFilterSchema>;

// --- Platform -> Orchestrator: list access log ---

export const dashboardAccessLogListRequestSchema = z.object({
  type: z.literal('dashboard.access-log.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  actorType: ActorType.optional(),
  actorId: z.string().optional(),
  action: AccessLogAction.optional(),
  source: AccessLogSource.optional(),
  outcome: AccessLogOutcome.optional(),
  targetType: AccessLogTargetType.optional(),
  targetId: z.string().optional(),
  fromTimestamp: z.string().optional(),
  toTimestamp: z.string().optional(),
  /** Full-text search over `error_message` (trigram-indexed via migration 009). */
  q: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});
export type DashboardAccessLogListRequest = z.infer<typeof dashboardAccessLogListRequestSchema>;

// --- Orchestrator -> Platform: response ---

export const dashboardAccessLogListResponseSchema = z.object({
  type: z.literal('dashboard.access-log.list.response'),
  requestId: z.string(),
  items: z.array(accessLogItemSchema).optional(),
  nextCursor: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type DashboardAccessLogListResponse = z.infer<typeof dashboardAccessLogListResponseSchema>;
