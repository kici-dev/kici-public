/**
 * RBAC (Role-Based Access Control) enforcer for secrets management admin API.
 *
 * Provides a fixed 3-role permission model:
 * - owner: all permissions (manages tokens, rotates keys)
 * - admin: context + secret + audit management
 * - auditor: read-only access to contexts and audit logs (no secret values)
 */

/**
 * Fixed roles for the secrets management admin API.
 */
export type Role = 'owner' | 'admin' | 'auditor';

/**
 * Permissions for the secrets management admin API.
 */
export type Permission =
  | 'context.create'
  | 'context.read'
  | 'context.update'
  | 'context.delete'
  | 'secret.read'
  | 'secret.write'
  | 'secret.delete'
  | 'secret.reveal'
  | 'audit.read'
  | 'token.manage'
  | 'key.rotate'
  | 'run.read'
  | 'run.cancel'
  | 'event_log.read'
  | 'event_log.read_payload'
  | 'access_log.read'
  | 'scheduled_job.trigger'
  | 'attestation.retry'
  | 'event_dlq.read'
  | 'event_dlq.manage'
  | 'orchestrator.drain'
  /** Read the org-wide CI trust policy that gates fork / unknown / workflow-change PRs. */
  | 'ci_trust.read'
  /** Modify org-wide trust policies (independent mode only — Platform-attached PATCH refuses). */
  | 'ci_trust.admin'
  /** List the live Firecracker VMs on a node and how each is tracked. */
  | 'scaler.read'
  /** Stop live Firecracker VMs the node's orchestrator does not track. */
  | 'scaler.manage'
  /** Drop a departed peer from the coordinators' live peer registries. */
  | 'peer.manage';

/**
 * Role-to-permission mapping.
 * owner gets everything, admin gets context/secret/audit + attestation.retry +
 * orchestrator.drain, auditor gets context.read + audit.read + run.read
 * (read-only — no attestation.retry and no orchestrator.drain, so a read-only
 * role can never drain the coordinator or re-arm the deferred-attestation
 * outbox).
 *
 * `ci_trust.read` / `ci_trust.admin` are held by owner + admin only. The trust
 * policy decides whether a fork PR runs at all, so it is not a read-only-role
 * surface; the auditor sees trust-policy changes through `access_log.read`
 * instead, which records every `trust_policy.updated` mutation.
 *
 * `scaler.read` (owner, admin, auditor) lists a node's live Firecracker VMs;
 * `scaler.manage` (owner, admin) stops the ones its orchestrator does not
 * track, so a read-only role can inspect a host but never kill a VM on it.
 * `peer.manage` (owner, admin) drops a departed peer from the live peer
 * registries; the auditor never changes cluster membership.
 */
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    'context.create',
    'context.read',
    'context.update',
    'context.delete',
    'secret.read',
    'secret.write',
    'secret.delete',
    'secret.reveal',
    'audit.read',
    'token.manage',
    'key.rotate',
    'run.read',
    'run.cancel',
    'event_log.read',
    'event_log.read_payload',
    'access_log.read',
    'scheduled_job.trigger',
    'attestation.retry',
    'event_dlq.read',
    'event_dlq.manage',
    'orchestrator.drain',
    'ci_trust.read',
    'ci_trust.admin',
    'scaler.read',
    'scaler.manage',
    'peer.manage',
  ]),
  admin: new Set<Permission>([
    'context.create',
    'context.read',
    'context.update',
    'context.delete',
    'secret.read',
    'secret.write',
    'secret.delete',
    'secret.reveal',
    'audit.read',
    'run.read',
    'run.cancel',
    'event_log.read',
    'event_log.read_payload',
    'access_log.read',
    'scheduled_job.trigger',
    'attestation.retry',
    'event_dlq.read',
    'event_dlq.manage',
    'orchestrator.drain',
    'ci_trust.read',
    'ci_trust.admin',
    'scaler.read',
    'scaler.manage',
    'peer.manage',
  ]),
  auditor: new Set<Permission>([
    'context.read',
    'audit.read',
    'run.read',
    'event_log.read',
    'access_log.read',
    'event_dlq.read',
    'scaler.read',
  ]),
};

/**
 * Error thrown when a role lacks the required permission.
 */
export class PermissionDeniedError extends Error {
  constructor(
    public readonly role: Role,
    public readonly permission: Permission,
  ) {
    super(`Role "${role}" does not have permission "${permission}"`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * RBAC enforcer for the secrets management admin API.
 *
 * Checks role-based permissions using a static permission mapping.
 * No database or external state -- purely in-memory evaluation.
 */
export class RbacEnforcer {
  /**
   * Check whether a role has a specific permission.
   */
  hasPermission(role: Role, permission: Permission): boolean {
    const perms = ROLE_PERMISSIONS[role];
    return perms ? perms.has(permission) : false;
  }

  /**
   * Require a permission, throwing PermissionDeniedError if not authorized.
   */
  requirePermission(role: Role, permission: Permission): void {
    if (!this.hasPermission(role, permission)) {
      throw new PermissionDeniedError(role, permission);
    }
  }

  /**
   * Check whether a role can access secret values (not just metadata).
   * Only owner and admin can see actual secret values.
   * Auditor can see context metadata and audit logs but NOT secret values.
   */
  canAccessSecretValues(role: Role): boolean {
    return role === 'owner' || role === 'admin';
  }
}
