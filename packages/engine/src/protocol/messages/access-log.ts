import { z } from 'zod';
import { ActorType, actorPrincipalSchema } from './actor.js';

/**
 * Access log enums + dashboard protocol schemas.
 *
 * The orchestrator `access_log` table captures every read AND
 * orchestrator-admin mutation attributable to an ActorPrincipal; these enums
 * are the single source of truth for its column values.
 *
 * Secret *mutations* go to secret_audit_log. access_log covers secret *reveals*
 * and all other reads/mutations surfaced via Platform proxy or orchestrator
 * admin HTTP.
 */

/** Where the access-log entry originated. */
export const AccessLogSource = z.enum(['platform_proxy', 'admin_http', 'admin_cli', 'agent']);
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
  'context',
  'registration',
  'backend',
  'diagnostics',
  'scaler',
  'fleet',
  'held_run',
  'access_log',
  'event_dlq',
  'org_settings',
  'cluster_meta',
  'attestation',
  'database',
]);
export type AccessLogTargetType = z.infer<typeof AccessLogTargetType>;

/**
 * Dotted-namespace action names; every handler that writes an access_log row
 * uses one, so a new handler adds an entry here.
 */
export const AccessLogAction = z.enum([
  'run.detail.read',
  'run.structured.read',
  'runs.list.read',
  'runs.filters.read',
  'sources.list.read',
  /**
   * Dashboard read of the admin-token inventory for the Platform's RBAC drift
   * report. Audited because knowing who holds admin tokens is privileged, even
   * though the response carries no credential material.
   */
  'admin_tokens.list.read',
  'run.payload.read',
  'run.orch_logs.read',
  'step.logs.read',
  'attestations.read',
  'artifacts.read',
  'run.cancel',
  'run.rerun',
  'run.manual_schedule',
  /**
   * Platform-relayed `kici run remote` trigger, emitted by the
   * `test.relay.trigger` handler with the developer's PAT identity as actor.
   */
  'run.trigger',
  'job.cancel',
  'event_log.list.read',
  'event_log.detail.read',
  'event_log.payload.read',
  'context.list.read',
  'context.get.read',
  'context.create',
  'context.update',
  'context.delete',
  'context_var.list.read',
  'context_var.set',
  'context_var.delete',
  'source_override.list.read',
  'source_override.set',
  'source_override.delete',
  'context_binding.list.read',
  'context_binding.set',
  'secret.list.read',
  'secret.set',
  'secret.delete',
  'secret.reveal',
  'secret_scope.create',
  'secret_scope.rename',
  'secret_scope.delete',
  'context.history.read',
  'held_run.list.read',
  'held_run.approve',
  'held_run.auto_approve',
  'held_run.reject',
  'held_run.request',
  'held_run.expire',
  'registration.list.read',
  'registration.disable',
  'registration.delete',
  'diagnostics.read',
  'scaler.capacity.read',
  'scaler.agents.read',
  'scaler.orphans.read',
  'fleet.read',
  'fleet.host.declare',
  'fleet.host.remove',
  /**
   * Bootstrap init-runner bring-up over SSH (`ctx.kici.bootstrap.ensureInitRunner`).
   * Actor is the ops agent, target the fresh host; recorded `denied` when the
   * agent lacks the `kici:capability:ssh-transport` capability.
   */
  'fleet.init_runner.bringup',
  /**
   * Pre-boot input shipped to a host's dropbear/initramfs SSH channel
   * (`ctx.kici.bootstrap.preBootSend`, e.g. a LUKS unlock passphrase). Same
   * actor/target/gate shape as `fleet.init_runner.bringup`.
   */
  'fleet.pre_boot.send',
  'backend.list.read',
  'backend.get.read',
  'backend.sync',
  'backend.sync.one',
  'backend.test',
  'global_workflows.get.read',
  'global_workflows.update',
  /**
   * Per-org dashboard-write policy flip (set or reset), one row per changed
   * operation from `PATCH /admin/org-settings/dashboard-writes`. `actor_meta`
   * carries `operation`, `prior_state`, `new_state` and, when applicable,
   * `reset`.
   */
  'org_settings.dashboard_write_policy.update',
  /**
   * Org trust-policy write via `PATCH /admin/trust-policy`
   * (`kici-admin trust-policy set`). Only an independent orchestrator accepts
   * it; a Platform-attached one refuses, because the Platform owns the policy
   * there. `actor_meta` carries the requested `patch` and the resulting
   * `policy`, so loosening `forkPolicy` to `allow` is attributable. Written in
   * the policy row's transaction.
   *
   * Past tense on purpose, unlike every sibling: `trust_policy.update` is the
   * Platform→orchestrator WebSocket push that delivers the policy
   * (`platform-orchestrator.ts`), and naming an audited local mutation
   * identically would confuse more than the tense break. Do NOT "fix" this to
   * `.update`.
   */
  'trust_policy.updated',
  /**
   * Approval-directory member registration or removal via `PATCH` / `DELETE
   * /admin/trust-policy/directory` (`kici-admin trust-policy directory-set` /
   * `directory-remove`). Only an independent orchestrator accepts it; a
   * Platform-attached one refuses, because the Platform owns the directory
   * there. `actor_meta` carries the `userId` acted on, plus the registration
   * for a write, so self-granting `write` CI trust is attributable. Written in
   * the directory row's transaction.
   *
   * Past tense for the same reason as `trust_policy.updated`: the
   * `trust_policy.update` wire frame also delivers the directory.
   */
  'trust_directory.updated',
  /**
   * Cluster-name rename via `PUT /admin/cluster-name` (`kici-admin
   * cluster-name set`). `actor_meta` carries `prior_value` and `new_value`;
   * `org_id` is null because cluster-name is orch-scoped.
   */
  'cluster_name.update',
  /**
   * Deferred-attestation outbox drain / re-arm via `POST
   * /admin/attestations/retry` (`kici-admin attestations retry`). `actor_meta`
   * carries `include_rejected`, `run_id`, and the
   * `minted`/`still_pending`/`rejected` counts. Always audited, because the
   * `include_rejected` re-arm clears a terminal `rejected_at` marker.
   */
  'attestation.retry',
  /**
   * Live orphaned Firecracker VMs stopped via `POST /admin/scaler/orphans/stop`
   * (`kici-admin scaler orphans --stop`). `target_id` is the node's instance
   * id; `actor_meta` carries `target`, `vm_ids` and the per-VM `results`.
   */
  'scaler.orphan.stop',
  /**
   * Scaler config re-read via `POST /admin/scaler/reload` (`kici-admin scaler
   * reload`) on the receiving orchestrator and, unless `single`, every
   * connected peer. `target_id` is the receiving instance id; `actor_meta`
   * carries `single` and the per-instance `results`.
   */
  'scaler.reload',
  /**
   * A departed peer dropped from the coordinators' live peer registries via
   * `POST /admin/peers/forget` (`kici-admin peer forget`). `target_id` is the
   * forgotten instance id; `actor_meta` carries the per-coordinator `results`.
   */
  'peer.forget',
  'access_log.list.read',
  /** Event DLQ admin actions (at-least-once event delivery). */
  'event_dlq.list.read',
  'event_dlq.retry',
  'event_dlq.discard',
  /** Cold-store archive emitted one chunk for a (table, tenant, day). */
  'archive_chunk',
  /** Cold-store purge deleted an expired chunk from S3 + PG bookkeeping. */
  'purge_chunk',
  /**
   * Direct-DB kici-admin mutations (source 'admin_cli'), audited like the
   * HTTP/WS admin path. The DDL is non-transactional, so the row is recorded
   * best-effort after the operation (outcome 'error' on failure).
   */
  'db.fresh',
  'db.migrate',
  'db.ensure',
  'db.create_role',
  'db.create_readonly_user',
  'db.reindex',
  'db.refresh_collation_version',
  'db.analyze',
]);
export type AccessLogAction = z.infer<typeof AccessLogAction>;

/**
 * Single row as surfaced to the dashboard / CLI. The orchestrator emits a
 * minimal row; the Platform adds displayName/email for `user` and
 * `platform_operator` actors by joining `actor_id` against the Keycloak-backed
 * `users` table before forwarding to the browser.
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
  /**
   * Agent provenance label from the dedicated `agent_label` column (not parsed
   * out of `actor_meta`). Null for human / API-key / system actors.
   */
  agentLabel: z.string().nullable().optional(),
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
  agentLabel: z.string().optional(),
  agentOnly: z.boolean().optional(),
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
  /** Exact-match filter on the agent provenance label (`agent_label` column). */
  agentLabel: z.string().max(255).optional(),
  /** When true, return only agent-attributed rows (`agent_label IS NOT NULL`). */
  agentOnly: z.boolean().optional(),
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
