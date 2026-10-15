/**
 * Unified Activity row + filter schemas for the dashboard's federated
 * "Activity" view. Federates Platform `audit_log` (mutation events,
 * free-form target_type) with orchestrator `access_log` (reads + admin
 * mutations, strict-enum target_type) at the query layer.
 *
 * The `source` discriminator on each row tells the UI whether to render
 * the audit_log or access_log column set. Fields unique to access_log
 * (origin, requestId, outcome) are nullable so audit_log rows stay
 * shape-compatible without padding.
 *
 * Browser-safe: Zod plus globalThis.btoa/atob (Node 18+ and evergreen
 * browsers); no Node built-ins.
 */
import { z } from 'zod';
import { ActorType } from '../protocol/messages/actor.js';
import { AccessLogOutcome, AccessLogSource } from '../protocol/messages/access-log.js';

/**
 * Source discriminator on a unified Activity row. Not `AccessLogSource`,
 * which the unified row carries as `origin`.
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
   * access_log only — the access_log row's `source` (platform_proxy /
   * admin_http / admin_cli / agent), renamed so the unified `source` is
   * unambiguously the audit_log vs. access_log discriminator.
   */
  origin: AccessLogSource.nullable().optional(),
});
export type ActivityRow = z.infer<typeof activityRowSchema>;

/**
 * Unified filter schema accepted by GET /orgs/:customerId/activity: every
 * filter the CLI commands expose, plus runId sugar and full-text `q`.
 */
export const activityFilterSchema = z.object({
  source: ActivityFilterSource.default('all'),
  actorType: ActorType.optional(),
  actorId: z.string().optional(),
  /** Free-form: matches access_log AccessLogAction values OR audit_log free-form actions. */
  action: z.string().optional(),
  outcome: AccessLogOutcome.optional(),
  origin: AccessLogSource.optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  /** Sugar: maps to targetType='run' + targetId=runId. Both halves of the federation respect it. */
  runId: z.string().optional(),
  /** Full-text search over access_log.error_message and audit_log.details::text. */
  q: z.string().optional(),
  /**
   * Exact-match filter on the agent provenance label. Only the access_log half
   * of the federation carries an agent label, so an agent filter restricts the
   * stream to agent-attributed access-log rows.
   */
  agentLabel: z.string().max(255).optional(),
  /**
   * When true, return only agent-attributed rows (access_log `agent_label IS NOT NULL`).
   * Parsed with `z.stringbool()`, not `z.coerce.boolean()`, because
   * `z.coerce.boolean('false') === true`. The `z.boolean()` arm accepts a native
   * boolean from programmatic callers, as `limit` accepts a number or a string.
   */
  agentOnly: z.union([z.boolean(), z.stringbool()]).optional(),
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
 * Internal cursor holding both halves of the federated pagination state. A
 * `null` half means that source is exhausted and is not re-queried. Encoded
 * as base64url(JSON) so it stays opaque and URL-safe.
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

// --- base64url helpers ---

function base64UrlEncode(s: string): string {
  // btoa requires Latin-1; cursor JSON is ASCII so this is safe.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const padded = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/** Encodes a cursor as a URL-safe opaque string for the /activity `cursor` query param. */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

/**
 * Returns `null` for a malformed cursor (bad base64, invalid JSON, or schema
 * mismatch); callers treat null as "start from page zero" rather than 500ing.
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
 * Resolves `runId` into targetType='run' + targetId=runId for both halves of
 * the federation; explicit target* fields take precedence.
 */
export function resolveRunIdSugar(filter: ActivityFilter): ActivityFilter {
  if (!filter.runId) return filter;
  return {
    ...filter,
    targetType: filter.targetType ?? 'run',
    targetId: filter.targetId ?? filter.runId,
  };
}
