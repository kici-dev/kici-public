/**
 * Unified Activity row + filter schemas for the dashboard's federated
 * "Activity" view. Federates Platform `audit_log` (mutation events,
 * free-form target_type) with orchestrator `access_log` (reads + admin
 * mutations, strict-enum target_type) at the query layer — see plan
 * `~/.claude/plans/ui-audit-logs-page-sleepy-wave.md`.
 *
 * The `source` discriminator on each row tells the UI whether to render
 * the audit_log or access_log column set. Fields unique to access_log
 * (origin, requestId, outcome) are nullable so audit_log rows stay
 * shape-compatible without padding.
 *
 * Browser-safe: only Zod imports + base64 helpers via globalThis.btoa/atob
 * (available in Node 18+ and all evergreen browsers). No Node built-ins.
 */
import { z } from 'zod';
import { ActorType } from '../protocol/messages/actor.js';
import { AccessLogOutcome } from '../protocol/messages/access-log.js';

/**
 * Source discriminator on a unified Activity row.
 * NOT to be confused with `AccessLogSource` (platform_proxy / admin_http /
 * admin_cli) — that field is renamed to `origin` on the unified row to
 * avoid the collision.
 */
export const ActivityRowSource = z.enum(['audit_log', 'access_log']);
export type ActivityRowSource = z.infer<typeof ActivityRowSource>;

/**
 * `source` filter parameter on /activity. `all` is the default and means
 * "federate both streams"; the other values restrict to a single stream.
 */
export const ActivityFilterSource = z.enum(['audit_log', 'access_log', 'all']);
export type ActivityFilterSource = z.infer<typeof ActivityFilterSource>;

/**
 * Unified row shape returned by GET /orgs/:customerId/activity.
 *
 * - audit_log rows: outcome=null, errorMessage=null, requestId=undefined,
 *   origin=undefined. target_type/target_id are free-form strings.
 * - access_log rows: outcome populated, errorMessage may be set on
 *   denied/error, requestId/origin populated.
 */
export const activityRowSchema = z.object({
  id: z.string(),
  source: ActivityRowSource,
  /** Merge key (createdAt DESC). ISO 8601. */
  createdAt: z.string(),
  /** Resolved actor identity. Display fields populated for user / platform_operator actors. */
  actorType: ActorType,
  actorId: z.string(),
  actorMeta: z.record(z.string(), z.unknown()).nullable(),
  actorEmail: z.string().nullable().optional(),
  actorDisplayName: z.string().nullable().optional(),
  /** Free-form on audit_log; AccessLogAction-shaped on access_log. */
  action: z.string(),
  /** Free-form string on audit_log (e.g. "member"); enum-bounded on access_log. */
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  /** access_log only; null on audit_log (audit_log has no outcome concept). */
  outcome: AccessLogOutcome.nullable(),
  /** access_log only; surfaces denied-reason and error text. */
  errorMessage: z.string().nullable(),
  /**
   * audit_log: jsonb `details` column (field changes etc.).
   * access_log: not populated by the federation (per-row metadata is in
   * actorMeta); kept on the schema so the row shape is uniform.
   */
  details: z.unknown().nullable(),
  /** access_log only — request correlation ID. */
  requestId: z.string().nullable().optional(),
  /**
   * access_log only — origin of the entry (platform_proxy / admin_http /
   * admin_cli). Renamed from `source` on the access_log row schema so the
   * unified row's `source` field is unambiguously the audit_log vs.
   * access_log discriminator.
   */
  origin: z.enum(['platform_proxy', 'admin_http', 'admin_cli']).nullable().optional(),
});
export type ActivityRow = z.infer<typeof activityRowSchema>;

/**
 * Unified filter schema accepted by GET /orgs/:customerId/activity.
 * Captures every filter the existing CLI commands expose, plus the new
 * search features (runId sugar, full-text q).
 */
export const activityFilterSchema = z.object({
  source: ActivityFilterSource.default('all'),
  actorType: ActorType.optional(),
  actorId: z.string().optional(),
  /** Free-form: matches access_log AccessLogAction values OR audit_log free-form actions. */
  action: z.string().optional(),
  outcome: AccessLogOutcome.optional(),
  origin: z.enum(['platform_proxy', 'admin_http', 'admin_cli']).optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  /** Sugar: maps to targetType='run' + targetId=runId. Both halves of the federation respect it. */
  runId: z.string().optional(),
  /** Full-text search over access_log.error_message and audit_log.details::text. */
  q: z.string().optional(),
  /** ISO timestamp lower bound (inclusive). */
  from: z.string().optional(),
  /** ISO timestamp upper bound (exclusive). */
  to: z.string().optional(),
  /** Opaque cursor produced by encodeActivityCursor(). */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ActivityFilter = z.infer<typeof activityFilterSchema>;

/**
 * Internal cursor shape — preserves both halves of the federated
 * pagination state. `null` for either half means that source is exhausted
 * and should not be re-queried on the next page.
 *
 * Encoded as base64url(JSON) to keep it opaque-looking and URL-safe.
 */
export const activityCursorSchema = z.object({
  audit: z
    .object({
      offset: z.number().int().nonnegative(),
    })
    .nullable(),
  access: z
    .object({
      /** Inner cursor returned by the orchestrator's dashboard.access-log.list response. */
      inner: z.string(),
    })
    .nullable(),
});
export type ActivityCursor = z.infer<typeof activityCursorSchema>;

// --- base64url helpers (browser-safe; Node 18+ + evergreen browsers expose btoa/atob) ---

function base64UrlEncode(s: string): string {
  // btoa requires Latin-1; cursor JSON is ASCII so this is safe.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const padded = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/**
 * Encode a cursor for the federated /activity endpoint. Returns a
 * URL-safe opaque string suitable for the `cursor` query param.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

/**
 * Decode an opaque cursor string. Returns `null` when the input is
 * malformed (corrupted base64, invalid JSON, or schema mismatch). Callers
 * should treat null as "start from page zero" rather than 500ing.
 */
export function decodeActivityCursor(cursor: string): ActivityCursor | null {
  try {
    const json = base64UrlDecode(cursor);
    const parsed = activityCursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Apply the runId sugar: when `runId` is set on the filter, it is mapped
 * to (targetType='run', targetId=runId) for both halves of the
 * federation. Returns a new filter with runId resolved into the explicit
 * target fields; existing target* fields take precedence if both are set.
 */
export function resolveRunIdSugar(filter: ActivityFilter): ActivityFilter {
  if (!filter.runId) return filter;
  return {
    ...filter,
    targetType: filter.targetType ?? 'run',
    targetId: filter.targetId ?? filter.runId,
  };
}
