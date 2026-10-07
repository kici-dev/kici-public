/**
 * The resource × level permission matrix shared by the Platform (enforcement)
 * and the dashboard (conditional rendering). Browser-safe: data and types only.
 */

/** Resources that can be permission-gated. */
export type Resource =
  | 'runs'
  | 'api_keys'
  | 'webhook_sources'
  | 'org_settings'
  | 'members'
  | 'secrets'
  | 'workflows'
  | 'billing'
  | 'audit'
  | 'contexts'
  | 'ci_trust'
  | 'webhook_endpoints'
  | 'event_log'
  | 'event_dlq'
  /**
   * `support` gates the `manage_support_access` capability: enabling /
   * disabling KiCI support sessions for the org (the `support_sessions_enabled`
   * org flag). Checked at `admin` level (`requirePermission(db, 'support',
   * 'admin')`) — managing whether KiCI staff may open a read session is an
   * owner-tier operation, so members get `none`.
   */
  | 'support'
  /**
   * `teams` gates managing operator-defined teams: creating / renaming /
   * deleting teams, editing membership, and attaching / detaching team-role
   * grants. `teams:admin` to manage; `teams:read` to view. Owners get `admin`,
   * members get `read` by default.
   */
  | 'teams'
  /**
   * `fleet` gates fleet-management: viewing the host roster, declaring /
   * removing hosts, and agent control. `fleet:read` to view, `fleet:write`
   * to mutate. Owners get `write`, members get `none` by default.
   */
  | 'fleet'
  /**
   * `notifications` gates execution-notification config: connecting the Slack
   * app, managing channels, and creating subscriptions. `notifications:admin`
   * to manage; `notifications:read` to view. Owners get `admin`, members get
   * `read` by default. Not repo-scoped.
   */
  | 'notifications';

/**
 * Permission levels ordered by privilege.
 *
 * `read_payload` is a special level used ONLY for the `event_log` resource.
 * It sits between `read` and `write`: holders can fetch the raw webhook
 * payload bodies, which may carry PII (commit messages, PR bodies, sender
 * emails, accidentally-echoed tokens). Listing the metadata rows is gated
 * by plain `read`; the payload body is gated by `read_payload` (or higher).
 *
 * For all other resources, `read_payload` is treated equivalently to `read`
 * by the hierarchy.
 */
export type PermissionLevel = 'none' | 'read' | 'read_payload' | 'write' | 'admin';

/**
 * Permission matrix mapping each resource to a permission level.
 */
export type Permissions = Record<Resource, PermissionLevel>;

/**
 * Numeric hierarchy for comparing permission levels.
 */
export const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  read_payload: 2,
  write: 3,
  admin: 4,
};

/**
 * All resources in the system.
 */
export const ALL_RESOURCES: Resource[] = [
  'runs',
  'api_keys',
  'webhook_sources',
  'org_settings',
  'members',
  'secrets',
  'workflows',
  'billing',
  'audit',
  'contexts',
  'ci_trust',
  'webhook_endpoints',
  'event_log',
  'event_dlq',
  'support',
  'teams',
  'fleet',
  'notifications',
];

/**
 * Check if a permissions object grants sufficient access to a resource.
 *
 * @param permissions - The permission matrix to check
 * @param resource - The resource being accessed
 * @param required - The minimum permission level required
 * @returns true if the permission level for the resource is >= required
 */
export function hasPermission(
  permissions: Permissions,
  resource: Resource,
  required: PermissionLevel,
): boolean {
  const level = permissions[resource] ?? 'none';
  return PERMISSION_HIERARCHY[level] >= PERMISSION_HIERARCHY[required];
}
