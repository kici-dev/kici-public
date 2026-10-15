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
   * Gates `manage_support_access`: enabling or disabling KiCI support sessions
   * for the org (the `support_sessions_enabled` flag). Checked at `admin` level
   * (`requirePermission(db, 'support', 'admin')`) because deciding whether KiCI
   * staff may open a read session is owner-tier, so members get `none`.
   */
  | 'support'
  /**
   * Gates operator-defined teams: create, rename, delete, edit membership, and
   * attach or detach team-role grants. `admin` manages, `read` views. Owners
   * get `admin`, members get `read` by default.
   */
  | 'teams'
  /**
   * Gates fleet management: viewing the host roster, declaring or removing
   * hosts, and agent control. `read` views, `write` mutates. Owners get
   * `write`, members get `none` by default.
   */
  | 'fleet'
  /**
   * Gates execution-notification config: connecting the Slack app, managing
   * channels, and creating subscriptions. `admin` manages, `read` views.
   * Owners get `admin`, members get `read` by default. Not repo-scoped.
   */
  | 'notifications';

/**
 * Permission levels ordered by privilege.
 *
 * `read_payload` is used ONLY for the `event_log` resource. It sits between
 * `read` and `write`: plain `read` lists the metadata rows, and `read_payload`
 * (or higher) fetches the raw webhook payload bodies, which may carry PII
 * (commit messages, PR bodies, sender emails, accidentally-echoed tokens).
 * For every other resource the hierarchy treats `read_payload` as `read`.
 */
export type PermissionLevel = 'none' | 'read' | 'read_payload' | 'write' | 'admin';

export type Permissions = Record<Resource, PermissionLevel>;

/** Numeric rank used to compare permission levels. */
export const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  read_payload: 2,
  write: 3,
  admin: 4,
};

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
 * @returns true when the level granted for `resource` is at or above
 *   `required`; a missing entry counts as `none`.
 */
export function hasPermission(
  permissions: Permissions,
  resource: Resource,
  required: PermissionLevel,
): boolean {
  const level = permissions[resource] ?? 'none';
  return PERMISSION_HIERARCHY[level] >= PERMISSION_HIERARCHY[required];
}
