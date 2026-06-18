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
  | 'event_dlq.read'
  | 'event_dlq.manage';

/**
 * Role-to-permission mapping.
 * owner gets everything, admin gets context/secret/audit,
 * auditor gets context.read + audit.read + run.read.
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
    'event_dlq.read',
    'event_dlq.manage',
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
    'event_dlq.read',
    'event_dlq.manage',
  ]),
  auditor: new Set<Permission>([
    'context.read',
    'audit.read',
    'run.read',
    'event_log.read',
    'access_log.read',
    'event_dlq.read',
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
