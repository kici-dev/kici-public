/**
 * Per-action access-log policy + sampling helper.
 *
 * Single source of truth for the keep / sample / rate-limit decision used by
 * the orchestrator's `access_log` writer. The policy table is exhaustive
 * over `AccessLogAction.options` so a new enum value without a policy entry
 * is a compile-time error.
 *
 * Override layers (applied in `shouldRecordAccess`, in order):
 *
 * 1. `outcome !== 'allowed'` → always record (denied/error are full-fidelity).
 * 2. `actor.type === 'platform_operator'` → always record (compliance: any
 *    activity by a non-org member must be auditable in full).
 * 3. agent-attributed actor (`actor.agent` present) → always record. The
 *    agent-provenance guarantee is that every action an agent takes is fully
 *    auditable; a sampled subset would break it.
 * 4. The per-action `POLICY_BY_ACTION` decision (`always` / `sample` /
 *    `rate_limit`).
 *
 * Browser-safe: this module MUST NOT import any Node built-ins (`node:crypto`
 * etc.). It is re-exported via the `@kici-dev/engine` barrel which the
 * dashboard imports. Sampling uses a tiny inline FNV-1a 32-bit hash.
 */
import { z } from 'zod';
import { AccessLogAction, type AccessLogOutcome } from '../protocol/messages/access-log.js';
import { type ActorPrincipal } from '../protocol/messages/actor.js';

/** Discriminator for the per-action policy entry. */
export const AccessLogPolicyKind = z.enum(['always', 'sample', 'rate_limit']);
export type AccessLogPolicyKind = z.infer<typeof AccessLogPolicyKind>;

export type AccessLogPolicy =
  | { kind: 'always' }
  | { kind: 'sample'; allowedRate: number }
  | { kind: 'rate_limit'; perMinutePerActor: number };

/**
 * Minimal interface for the rate-limit decision so the engine stays
 * dependency-free. Orchestrator wires in a real `SamplingRateLimiter`.
 */
export interface AccessLogRateLimiter {
  permit(action: AccessLogAction, actorKey: string, perMinute: number): boolean;
}

/**
 * Policy table mirroring research-doc §2 verdicts (with the user's
 * §7 platform-operator override applied separately in `shouldRecordAccess`).
 *
 * Exhaustive over `AccessLogAction.options` — TypeScript catches additions.
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
  'event_log.list.read': { kind: 'sample', allowedRate: 0.05 },
  'environment.list.read': { kind: 'sample', allowedRate: 0.1 },
  'registration.list.read': { kind: 'sample', allowedRate: 0.1 },
  'global_workflows.get.read': { kind: 'sample', allowedRate: 0.1 },
  'environment.get.read': { kind: 'sample', allowedRate: 0.2 },
  'environment.history.read': { kind: 'sample', allowedRate: 0.2 },
  'held_run.list.read': { kind: 'sample', allowedRate: 0.2 },
  'env_binding.list.read': { kind: 'sample', allowedRate: 0.2 },
  'backend.list.read': { kind: 'sample', allowedRate: 0.2 },
  'backend.get.read': { kind: 'sample', allowedRate: 0.2 },

  // Internal-ops reads (rate-limited to one row per actor per minute).
  'diagnostics.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'scaler.capacity.read': { kind: 'rate_limit', perMinutePerActor: 1 },
  'scaler.agents.read': { kind: 'rate_limit', perMinutePerActor: 1 },
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
  'environment.create': { kind: 'always' },
  'environment.update': { kind: 'always' },
  'environment.delete': { kind: 'always' },
  'env_var.list.read': { kind: 'always' },
  'env_var.set': { kind: 'always' },
  'env_var.delete': { kind: 'always' },
  'source_override.list.read': { kind: 'always' },
  'source_override.set': { kind: 'always' },
  'source_override.delete': { kind: 'always' },
  'env_binding.set': { kind: 'always' },
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
  'cluster_name.update': { kind: 'always' },
  'access_log.list.read': { kind: 'always' },
  'event_dlq.list.read': { kind: 'sample', allowedRate: 0.2 },
  'event_dlq.retry': { kind: 'always' },
  'event_dlq.discard': { kind: 'always' },
  archive_chunk: { kind: 'always' },
  purge_chunk: { kind: 'always' },
};

/**
 * Tiny FNV-1a 32-bit hash. Used for stable hash-based sampling so a single
 * actor's request stream lands in the same sampling bucket repeatedly.
 *
 * Pure JS, no Node built-ins (engine barrel must stay browser-safe).
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // 32-bit FNV prime multiplication via Math.imul for correct overflow.
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
 * @param action     The action being attempted.
 * @param outcome    `allowed` / `denied` / `error`.
 * @param actor      The principal performing the action.
 * @param requestId  The orchestrator request id (used for stable sampling).
 * @param limiter    Rate-limiter instance (only consulted for `rate_limit`
 *                   actions; tests can pass a stub).
 *
 * Returns `true` to write the row, `false` to drop.
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

  // Override 2: platform_operator activity always recorded
  // (research §7 — operator break-glass is non-tenant-attributable).
  if (actor.type === 'platform_operator') return true;

  // Override 3: agent-attributed actions always recorded — the agent-provenance
  // guarantee (every action an agent takes is fully auditable) requires the
  // complete trail, never a sampled subset.
  if (actor.type === 'user' && actor.agent) return true;

  const policy = POLICY_BY_ACTION[action];
  switch (policy.kind) {
    case 'always':
      return true;
    case 'sample': {
      // Stable hash on actor key + requestId so a single user's poll trace
      // stays coherent (either every poll lands in the sample, or none does
      // for that requestId-paired sequence).
      const seed = `${actorKey(actor)}|${requestId ?? ''}`;
      const h = fnv1a32(seed);
      // h ∈ [0, 2^32). Compare normalised to [0, 1).
      return h / 0x100000000 < policy.allowedRate;
    }
    case 'rate_limit':
      return limiter.permit(action, actorKey(actor), policy.perMinutePerActor);
  }
}

/**
 * Decide whether to write a `secret_audit_log` row for `resolve` /
 * `resolve_named`. Volume class is per-job (every step's secret resolution),
 * so the sample rate is much lower than `access_log`.
 *
 * The secret-resolver's `AuditEntry` doesn't carry an `ActorPrincipal` —
 * we synthesise a stable key from `runId` / `jobId` so a single job's
 * trace either lands wholesale in the sample or doesn't.
 *
 * @param entry      The audit entry being written (action, outcome, runId,
 *                   jobId, userId, role).
 * @param requestId  Optional sampler salt (defaults to the entry's runId
 *                   /jobId composite); kept for symmetry with
 *                   `shouldRecordAccess`.
 */
export interface SecretResolveSampleInput {
  outcome: 'allowed' | 'denied';
  runId: string | null;
  jobId: string | null;
  userId: string | null;
  role: string | null;
}

export function shouldRecordSecretResolve(entry: SecretResolveSampleInput): boolean {
  // Override 1: denied / error always recorded.
  // (`secret_audit_log.outcome` is `'allowed' | 'denied'` — there's no
  // `'error'` variant; both denied paths are forensic-class.)
  if (entry.outcome !== 'allowed') return true;

  // Override 2: secret resolves never run as platform_operator (the
  // resolver runs in the job execution path). For symmetry we still
  // synthesise a system actor key from runId/jobId so the sampling
  // decision is stable for a given job's trace.
  const key = `system:${entry.runId ?? entry.jobId ?? entry.userId ?? 'unknown'}`;
  const h = fnv1a32(key);
  // 1% sample rate per research §2 row 156–157.
  return h / 0x100000000 < 0.01;
}
