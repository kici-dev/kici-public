/**
 * Per-action access-log policy + sampling helper.
 *
 * Single source of truth for the keep / sample / rate-limit decision of the
 * orchestrator's `access_log` writer. The policy table is exhaustive over
 * `AccessLogAction.options`, so a new enum value without an entry is a
 * compile-time error.
 *
 * Override layers (applied in `shouldRecordAccess`, in order):
 *
 * 1. `outcome !== 'allowed'` → always record (denied/error are full-fidelity).
 * 2. `actor.type === 'platform_operator'` → always record (compliance: any
 *    activity by a non-org member must be auditable in full).
 * 3. agent-attributed actor (`actor.agent` present) → always record: every
 *    action an agent takes must be fully auditable.
 * 4. The per-action `POLICY_BY_ACTION` decision.
 *
 * Browser-safe: this module MUST NOT import Node built-ins (`node:crypto`
 * etc.), because the dashboard imports the `@kici-dev/engine` barrel that
 * re-exports it. Sampling uses an inline FNV-1a 32-bit hash.
 */
import { z } from 'zod';
import { AccessLogAction, type AccessLogOutcome } from '../protocol/messages/access-log.js';
import { agentLabelOf, type ActorPrincipal } from '../protocol/messages/actor.js';

/** Discriminator for the per-action policy entry. */
export const AccessLogPolicyKind = z.enum(['always', 'sample', 'rate_limit']);
export type AccessLogPolicyKind = z.infer<typeof AccessLogPolicyKind>;

export type AccessLogPolicy =
  | { kind: 'always' }
  | { kind: 'sample'; allowedRate: number }
  | { kind: 'rate_limit'; perMinutePerActor: number };

/**
 * Rate-limit decision seam, so the engine stays dependency-free. The
 * orchestrator wires in a real `SamplingRateLimiter`.
 */
export interface AccessLogRateLimiter {
  permit(action: AccessLogAction, actorKey: string, perMinute: number): boolean;
}

/**
 * Per-action recording policy. The outcome, platform-operator and agent
 * overrides are applied separately in `shouldRecordAccess`.
 */
export const POLICY_BY_ACTION: Record<AccessLogAction, AccessLogPolicy> = {
  // High-volume tenant reads (sampled).
  'run.detail.read': { kind: 'sample', allowedRate: 0.05 },
  'run.structured.read': { kind: 'sample', allowedRate: 0.05 },
  'runs.list.read': { kind: 'sample', allowedRate: 0.05 },
  'runs.filters.read': { kind: 'sample', allowedRate: 0.05 },
  'sources.list.read': { kind: 'sample', allowedRate: 0.1 },
  'run.orch_logs.read': { kind: 'sample', allowedRate: 0.1 },
  'step.logs.read': { kind: 'sample', allowedRate: 0.1 },
  'attestations.read': { kind: 'always' },
  'artifacts.read': { kind: 'always' },
  'event_log.list.read': { kind: 'sample', allowedRate: 0.05 },
  'context.list.read': { kind: 'sample', allowedRate: 0.1 },
  'registration.list.read': { kind: 'sample', allowedRate: 0.1 },
  'global_workflows.get.read': { kind: 'sample', allowedRate: 0.1 },
  'context.get.read': { kind: 'sample', allowedRate: 0.2 },
  'context.history.read': { kind: 'sample', allowedRate: 0.2 },
  'held_run.list.read': { kind: 'sample', allowedRate: 0.2 },
  'context_binding.list.read': { kind: 'sample', allowedRate: 0.2 },
  'backend.list.read': { kind: 'sample', allowedRate: 0.2 },
  'backend.get.read': { kind: 'sample', allowedRate: 0.2 },

  // Internal-ops reads (rate-limited to one row per actor per minute).
  'diagnostics.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'scaler.capacity.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'scaler.agents.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'scaler.orphans.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'fleet.read': { kind: 'rate_limit', perMinutePerActor: 1 },

  // Sensitive reads + every mutation: always recorded.
  'run.payload.read': { kind: 'always' },
  'run.cancel': { kind: 'always' },
  'run.rerun': { kind: 'always' },
  'run.manual_schedule': { kind: 'always' },
  'run.trigger': { kind: 'always' },
  'job.cancel': { kind: 'always' },
  'event_log.detail.read': { kind: 'always' },
  'event_log.payload.read': { kind: 'always' },
  'context.create': { kind: 'always' },
  'context.update': { kind: 'always' },
  'context.delete': { kind: 'always' },
  'context_var.list.read': { kind: 'always' },
  'context_var.set': { kind: 'always' },
  'context_var.delete': { kind: 'always' },
  'source_override.list.read': { kind: 'always' },
  'source_override.set': { kind: 'always' },
  'source_override.delete': { kind: 'always' },
  'context_binding.set': { kind: 'always' },
  'secret.list.read': { kind: 'always' },
  'secret.set': { kind: 'always' },
  'secret.delete': { kind: 'always' },
  'secret.reveal': { kind: 'always' },
  'secret_scope.create': { kind: 'always' },
  'secret_scope.rename': { kind: 'always' },
  'secret_scope.delete': { kind: 'always' },
  'held_run.approve': { kind: 'always' },
  'held_run.auto_approve': { kind: 'always' },
  'held_run.reject': { kind: 'always' },
  'held_run.request': { kind: 'always' },
  'held_run.expire': { kind: 'always' },
  'registration.disable': { kind: 'always' },
  'registration.delete': { kind: 'always' },
  'backend.sync': { kind: 'always' },
  'backend.sync.one': { kind: 'always' },
  'backend.test': { kind: 'always' },
  'fleet.host.declare': { kind: 'always' },
  'fleet.host.remove': { kind: 'always' },
  'fleet.init_runner.bringup': { kind: 'always' },
  'fleet.pre_boot.send': { kind: 'always' },
  'global_workflows.update': { kind: 'always' },
  'org_settings.dashboard_write_policy.update': { kind: 'always' },
  'trust_policy.updated': { kind: 'always' },
  'trust_directory.updated': { kind: 'always' },
  'cluster_name.update': { kind: 'always' },
  'attestation.retry': { kind: 'always' },
  'scaler.orphan.stop': { kind: 'always' },
  'scaler.reload': { kind: 'always' },
  'peer.forget': { kind: 'always' },
  // Direct-DB kici-admin mutations (source 'admin_cli') — always recorded.
  'db.fresh': { kind: 'always' },
  'db.migrate': { kind: 'always' },
  'db.ensure': { kind: 'always' },
  'db.create_role': { kind: 'always' },
  'db.create_readonly_user': { kind: 'always' },
  'db.reindex': { kind: 'always' },
  'db.refresh_collation_version': { kind: 'always' },
  'db.analyze': { kind: 'always' },
  'access_log.list.read': { kind: 'always' },
  // Never sampled: reading who holds admin tokens is a low-volume, privileged
  // read, and a sampled row would leave gaps in the very trail an operator
  // consults after a token is misused.
  'admin_tokens.list.read': { kind: 'always' },
  'event_dlq.list.read': { kind: 'sample', allowedRate: 0.2 },
  'event_dlq.retry': { kind: 'always' },
  'event_dlq.discard': { kind: 'always' },
  archive_chunk: { kind: 'always' },
  purge_chunk: { kind: 'always' },
};

/**
 * FNV-1a 32-bit hash for stable sampling: one actor's request stream lands in
 * the same bucket every time. Pure JS, so the engine barrel stays
 * browser-safe.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Math.imul gives correct 32-bit overflow.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/** Build a stable cache / sampler key from the actor's flattened identity. */
function actorKey(actor: ActorPrincipal): string {
  switch (actor.type) {
    case 'user':
      return `user:${actor.sub}`;
    case 'api_key':
      return `api_key:${actor.keyId}`;
    case 'service_account':
      return `service_account:${actor.id}`;
    case 'platform_operator':
      return `platform_operator:${actor.sub}`;
    case 'system':
      return `system:${actor.component}`;
  }
}

/**
 * Decide whether to write an `access_log` row for the given action.
 *
 * @param requestId  The orchestrator request id (salts stable sampling).
 * @param limiter    Consulted only for `rate_limit` actions.
 * @returns `true` to write the row, `false` to drop it.
 */
export function shouldRecordAccess(
  action: AccessLogAction,
  outcome: AccessLogOutcome,
  actor: ActorPrincipal,
  requestId: string | null,
  limiter: AccessLogRateLimiter,
): boolean {
  // Override 1: denied/error always recorded (forensic value).
  if (outcome !== 'allowed') return true;

  // Override 2: operator break-glass is non-tenant-attributable.
  if (actor.type === 'platform_operator') return true;

  // Override 3: agent actions need the complete trail, never a sample.
  // `agentLabelOf` covers both `user` PATs and `api_key` org keys.
  if (agentLabelOf(actor) !== null) return true;

  const policy = POLICY_BY_ACTION[action];
  switch (policy.kind) {
    case 'always':
      return true;
    case 'sample': {
      // Hashing actor key + requestId keeps one user's poll trace coherent:
      // every poll of that sequence lands in the sample, or none does.
      const seed = `${actorKey(actor)}|${requestId ?? ''}`;
      const h = fnv1a32(seed);
      // h ∈ [0, 2^32), normalised to [0, 1).
      return h / 0x100000000 < policy.allowedRate;
    }
    case 'rate_limit':
      return limiter.permit(action, actorKey(actor), policy.perMinutePerActor);
  }
}

/** The `secret_audit_log` entry fields the resolve sampler reads. */
export interface SecretResolveSampleInput {
  outcome: 'allowed' | 'denied';
  runId: string | null;
  jobId: string | null;
  userId: string | null;
  role: string | null;
}

/**
 * Decide whether to write a `secret_audit_log` row for `resolve` /
 * `resolve_named`. Volume is per-job (every step resolves secrets), so the
 * sample rate is much lower than `access_log`.
 *
 * `AuditEntry` carries no `ActorPrincipal`, so the sampler keys on `runId`,
 * then `jobId`, then `userId`: a single job's trace lands in the sample
 * wholesale or not at all.
 */
export function shouldRecordSecretResolve(entry: SecretResolveSampleInput): boolean {
  // Denied is always recorded (`secret_audit_log.outcome` has no `'error'`).
  if (entry.outcome !== 'allowed') return true;

  // Secret resolves never run as platform_operator (the resolver runs in the
  // job execution path), so no operator override applies.
  const key = `system:${entry.runId ?? entry.jobId ?? entry.userId ?? 'unknown'}`;
  const h = fnv1a32(key);
  // 1% sample rate.
  return h / 0x100000000 < 0.01;
}
