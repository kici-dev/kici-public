/**
 * Per-action warm-retention policy for the three audit-style tables:
 * Platform `audit_log`, Orchestrator `access_log`, Orchestrator
 * `secret_audit_log`.
 *
 * Single source of truth for "how long does a row stay in PG before being
 * archived to cold storage." Mirrors the per-action sampling policy in
 * `./access-log-policy.ts`; both modules classify by the same action
 * dimension, just for different downstream decisions.
 *
 * The classification table came from research-doc §5
 *  and the user's
 * `## Decisions` section. Two override layers apply uniformly:
 *
 * 1. `outcome` is `denied` or `error` → retain 180d (forensic value).
 * 2. `actor.type === 'platform_operator'` → retain 365d
 *    (compliance — non-org-member break-glass).
 *
 * Override 1 wins over override 2 when both apply (more conservative).
 *
 * The SQL-fragment generators emit Postgres `CASE` expressions so the
 * adapters can splice them directly into Kysely raw SQL without duplicating
 * the classification logic. The strings produced are derived deterministically
 * from the JS tables here, so editing the JS regenerates the SQL — and the
 * `validateActionShape()` test guards against SQL-injection surface by
 * asserting every action key matches `/^[a-z0-9_.-]+$/`.
 *
 * Browser-safe: this module MUST NOT import any Node built-ins. It is
 * re-exported via the `@kici-dev/engine` barrel which the dashboard imports.
 */
import { AccessLogAction, type AccessLogOutcome } from '../protocol/messages/access-log.js';
import { type ActorType } from '../protocol/messages/actor.js';

/* ──────────────────────────── access_log (Orchestrator) ─────────────────── */

/**
 * Warm-retention days per `AccessLogAction`. Exhaustive over the enum so a
 * new action without an entry is a compile-time error.
 *
 * Buckets:
 * - 30 days: high-volume reads (already sampled per `POLICY_BY_ACTION`),
 *   internal-ops reads (rate-limited, denied/error only at write time).
 * - 180 days: sensitive reads + tenant-plane mutations.
 * - 365 days: secret mutations / reveals + cold-store internals
 *   (compliance-class).
 */
export const ACCESS_LOG_WARM_DAYS: Record<AccessLogAction, number> = {
  // 30 days — high-volume tenant reads (sampled)
  'run.detail.read': 30,
  'runs.list.read': 30,
  'runs.filters.read': 30,
  'sources.list.read': 30,
  'run.orch_logs.read': 30,
  'step.logs.read': 30,
  'attestations.read': 30,
  'event_log.list.read': 30,
  'environment.list.read': 30,
  'environment.get.read': 30,
  'environment.history.read': 30,
  'registration.list.read': 30,
  'global_workflows.get.read': 30,
  'held_run.list.read': 30,
  'env_binding.list.read': 30,
  'backend.list.read': 30,
  'backend.get.read': 30,

  // 30 days — internal-ops reads (rate-limited; only denied/error survive
  // write-time, and those upgrade to 180 days via the override below).
  'diagnostics.read': 30,
  'scaler.capacity.read': 30,
  'scaler.agents.read': 30,

  // 180 days — sensitive reads
  'event_log.detail.read': 180,
  'event_log.payload.read': 180,
  'run.payload.read': 180,
  'env_var.list.read': 180,
  'source_override.list.read': 180,
  'access_log.list.read': 180,
  'secret.list.read': 180,

  // 180 days — tenant-plane mutations (non-secret)
  'run.cancel': 180,
  'run.rerun': 180,
  'run.manual_schedule': 180,
  'run.trigger': 180,
  'job.cancel': 180,
  'environment.create': 180,
  'environment.update': 180,
  'environment.delete': 180,
  'env_var.set': 180,
  'env_var.delete': 180,
  'source_override.set': 180,
  'source_override.delete': 180,
  'env_binding.set': 180,
  'held_run.approve': 180,
  'held_run.reject': 180,
  'held_run.request': 180,
  'held_run.expire': 180,
  'registration.disable': 180,
  'registration.delete': 180,
  'backend.sync': 180,
  'backend.sync.one': 180,
  'backend.test': 180,
  'global_workflows.update': 180,
  'org_settings.dashboard_write_policy.update': 180,
  'cluster_name.update': 180,

  // 180 days — event DLQ admin actions (Phase 5 — at-least-once delivery)
  'event_dlq.list.read': 30,
  'event_dlq.retry': 180,
  'event_dlq.discard': 180,

  // 365 days — secret mutations / reveals (compliance)
  'secret.set': 365,
  'secret.delete': 365,
  'secret.reveal': 365,
  'secret_scope.create': 365,
  'secret_scope.rename': 365,
  'secret_scope.delete': 365,

  // 365 days — cold-store internals (low volume, keep for forensics)
  archive_chunk: 365,
  purge_chunk: 365,
};

/** Override outcomes that promote retention to 180 days regardless of action. */
const FORENSIC_OUTCOME_DAYS = 180;
/** Override actor type that promotes retention to 365 days. */
const PLATFORM_OPERATOR_DAYS = 365;

/**
 * Default warm TTL for action strings outside `AccessLogAction.options`. Hit
 * by E2E synthetic action names and would-be-future enum additions on a
 * rolling deploy. Matches the conservative `180d` mutations bucket so
 * unknown rows are never archived sooner than a tenant-plane mutation.
 */
const UNKNOWN_ACTION_WARM_DAYS = 180;

export function getAccessLogWarmDays(args: {
  action: AccessLogAction;
  outcome: AccessLogOutcome;
  actorType: ActorType;
}): number {
  if (args.outcome !== 'allowed') return FORENSIC_OUTCOME_DAYS;
  if (args.actorType === 'platform_operator') return PLATFORM_OPERATOR_DAYS;
  return ACCESS_LOG_WARM_DAYS[args.action] ?? UNKNOWN_ACTION_WARM_DAYS;
}

/* ──────────────────────────── audit_log (Platform) ──────────────────────── */

/**
 * Platform `audit_log.action` is a free-form string (no enum), so we classify
 * by prefix / set membership. Compliance-class actions (billing, RBAC,
 * platform-admin break-glass, system events) get 365 days; everything else
 * defaults to 180 days (tenant-plane mutations).
 *
 * The Platform `audit_log` has no `outcome` column — every row is a "happened"
 * event. The platform_operator override still applies via `actor_type`.
 */
const COMPLIANCE_AUDIT_PREFIXES = [
  'plan.',
  'plan_config.',
  'org.',
  'member.',
  'invite.',
  'role.',
  'platform-admin.',
  'support-read.',
] as const;

const COMPLIANCE_AUDIT_EXACT = new Set<string>([
  'archive_chunk',
  'purge_chunk',
  'replay_chunk',
  'scheduled_job_failure',
]);

/**
 * Days a Platform `audit_log` row stays in PG before archival, ignoring
 * actor-type overrides. Use `getAuditLogWarmDays()` to apply the override.
 */
export function auditLogWarmDays(action: string): number {
  if (COMPLIANCE_AUDIT_EXACT.has(action)) return 365;
  for (const prefix of COMPLIANCE_AUDIT_PREFIXES) {
    if (action.startsWith(prefix)) return 365;
  }
  return 180;
}

export function getAuditLogWarmDays(args: { action: string; actorType: ActorType }): number {
  if (args.actorType === 'platform_operator') return PLATFORM_OPERATOR_DAYS;
  return auditLogWarmDays(args.action);
}

/* ──────────────────────────── secret_audit_log (Orchestrator) ───────────── */

/**
 * Orchestrator `secret_audit_log.action` is a free-form string (no enum).
 * Sampled job-execution resolves are 30 days (already sampled at 1% in the
 * writer per `shouldRecordSecretResolve`); everything else (mutations: set,
 * delete, rotate, scope ops) is 365 days. The denied-outcome override
 * promotes to 180 days. There is no `actor_type` column on this table, so
 * the platform_operator override does not apply.
 */
const SAMPLED_RESOLVE_ACTIONS = new Set<string>(['resolve', 'resolve_named']);

export function secretAuditLogWarmDays(action: string): number {
  if (SAMPLED_RESOLVE_ACTIONS.has(action)) return 30;
  return 365;
}

export function getSecretAuditLogWarmDays(args: {
  action: string;
  outcome: 'allowed' | 'denied';
}): number {
  if (args.outcome !== 'allowed') return FORENSIC_OUTCOME_DAYS;
  return secretAuditLogWarmDays(args.action);
}

/* ──────────────────────────── SQL-fragment generators ───────────────────── */

/**
 * Action strings that may appear in SQL must match this shape. A failed match
 * means an action key was added that could escape the string-literal context
 * — that's a bug, not user input, but we still reject it at test time.
 */
const SAFE_ACTION_RE = /^[a-z0-9_.-]+$/;

function assertSafeAction(action: string): void {
  if (!SAFE_ACTION_RE.test(action)) {
    throw new Error(`Unsafe action key for SQL: ${JSON.stringify(action)}`);
  }
}

function quoteList(actions: ReadonlyArray<string>): string {
  for (const a of actions) assertSafeAction(a);
  return actions.map((a) => `'${a}'`).join(',');
}

/**
 * Group a `Record<action, days>` into `days → action[]` so the emitted CASE
 * has one WHEN per distinct TTL value.
 */
function groupByDays<K extends string>(map: Record<K, number>): Map<number, K[]> {
  const groups = new Map<number, K[]>();
  for (const key of Object.keys(map) as K[]) {
    const days = map[key];
    const list = groups.get(days);
    if (list) list.push(key);
    else groups.set(days, [key]);
  }
  return groups;
}

/**
 * Postgres CASE expression yielding the per-row warm-retention `INTERVAL`.
 * Splice into a `sql.raw()` template inside the adapter:
 *
 *   sql`WHERE created_at < (NOW() - (${sql.raw(accessLogWarmSqlCase())}))`
 */
export function accessLogWarmSqlCase(): string {
  const groups = groupByDays(ACCESS_LOG_WARM_DAYS);
  // Emit longest-retention buckets first inside the action-IN clauses so the
  // generated SQL is stable and easy to eyeball; the override layers come first
  // so they short-circuit cleanly.
  const sortedDays = [...groups.keys()].sort((a, b) => b - a);

  // The ELSE defaults genuinely-unknown actions to the same conservative TTL
  // the JS getter uses (UNKNOWN_ACTION_WARM_DAYS). Every known action lands in
  // an explicit WHEN clause below, so the ELSE is reached only by action
  // strings outside the enum — E2E synthetic names, future enum additions on a
  // rolling deploy, post-rollback rows. For warm retention the conservative
  // choice is to keep those rows LONGER, not shorter: archiving an unknown row
  // early evicts it from PG (losing indexability) and the SQL pre-filter never
  // re-runs the JS getter's overrides, so a too-eager ELSE would silently lose
  // data the getter would have retained.
  const defaultDays = UNKNOWN_ACTION_WARM_DAYS;

  const whenClauses: string[] = [];
  // Override 1: denied / error → 180 days.
  whenClauses.push(
    `WHEN outcome IN ('denied','error') THEN INTERVAL '${FORENSIC_OUTCOME_DAYS} days'`,
  );
  // Override 2: platform_operator → 365 days.
  whenClauses.push(
    `WHEN actor_type = 'platform_operator' THEN INTERVAL '${PLATFORM_OPERATOR_DAYS} days'`,
  );
  // Per-action buckets — every known TTL group gets an explicit WHEN clause,
  // including the 30-day group, so the ELSE stays reserved for unknown actions.
  for (const days of sortedDays) {
    const actions = groups.get(days)!;
    whenClauses.push(`WHEN action IN (${quoteList(actions)}) THEN INTERVAL '${days} days'`);
  }
  return `CASE\n  ${whenClauses.join('\n  ')}\n  ELSE INTERVAL '${defaultDays} days'\nEND`;
}

/**
 * Postgres CASE for Platform `audit_log`. Mirrors `auditLogWarmDays()`.
 *
 * The Platform `audit_log` table has neither an `outcome` nor an `actor_type`
 * column (per migration `001_initial`). Actor type only exists in the JS
 * application layer — when an actor is written, the JS code derives `actor_id`
 * from `actor.sub` (or a fixed string like `'platform-admin-cli'`). Because of
 * that, the SQL CASE here cannot apply the `actor.type='platform_operator'`
 * override the way `accessLogWarmSqlCase()` does — the column doesn't exist.
 *
 * In practice this is fine: there is no Platform code path that writes a
 * `platform_operator` actor into Platform `audit_log`. Platform-operator
 * break-glass (`makePlatformOperatorActor`) is exclusively used to proxy
 * orchestrator reads via the support-read listener; those rows land in the
 * orchestrator's `access_log`, where the per-row CASE *can* see `actor_type`.
 *
 * The TS-side `getAuditLogWarmDays()` keeps the override defensively so any
 * future call site that genuinely passes a `platform_operator` actor still
 * gets the right TTL — just not the SQL pre-filter, which has no column to
 * inspect.
 */
export function auditLogWarmSqlCase(): string {
  const exact = [...COMPLIANCE_AUDIT_EXACT];
  const whenClauses: string[] = [];
  // Compliance prefixes — emit one OR'd predicate.
  const prefixPredicate = COMPLIANCE_AUDIT_PREFIXES.map((p) => {
    assertSafeAction(p.replace(/\.$/, '')); // trailing dot is allowed in pattern
    return `action LIKE '${p}%'`;
  }).join(' OR ');
  whenClauses.push(`WHEN ${prefixPredicate} THEN INTERVAL '365 days'`);
  // Compliance exact-match set.
  if (exact.length > 0) {
    whenClauses.push(`WHEN action IN (${quoteList(exact)}) THEN INTERVAL '365 days'`);
  }
  // Default: 180 days for all tenant-plane mutations.
  return `CASE\n  ${whenClauses.join('\n  ')}\n  ELSE INTERVAL '180 days'\nEND`;
}

/**
 * Postgres CASE for Orchestrator `secret_audit_log`. No `actor_type` column
 * on this table; only the denied-outcome override applies.
 */
export function secretAuditLogWarmSqlCase(): string {
  const sampled = [...SAMPLED_RESOLVE_ACTIONS];
  const whenClauses: string[] = [];
  // Override: denied → 180 days. The column on this table is just 'allowed'/
  // 'denied' (no 'error' variant).
  whenClauses.push(`WHEN outcome = 'denied' THEN INTERVAL '${FORENSIC_OUTCOME_DAYS} days'`);
  if (sampled.length > 0) {
    whenClauses.push(`WHEN action IN (${quoteList(sampled)}) THEN INTERVAL '30 days'`);
  }
  return `CASE\n  ${whenClauses.join('\n  ')}\n  ELSE INTERVAL '365 days'\nEND`;
}

/* ──────────────────────────── Cold retention (Phase 2) ──────────────────── */

/**
 * Cold-store retention horizon. Number of days a chunk lives in S3 after
 * archival before it is purged; `'forever'` means the chunk is never purged.
 */
export type ColdRetention = number | 'forever';

/**
 * Cold-retention days per `AccessLogAction`. Mirrors `ACCESS_LOG_WARM_DAYS`'s
 * shape (exhaustive over the enum). Buckets:
 *
 * - 30 days: internal-ops reads (only denied/error rows survive write-time
 *   sampling; once they age out of warm, no need to keep them in cold either).
 * - 180 days: high-volume tenant reads (sampled at write-time too — the
 *   forensic value drops sharply after 6 months of cold).
 * - 730 days (2 years): sensitive reads + tenant-plane mutations
 *   (covers SOC 2 audit windows comfortably).
 * - `'forever'`: secret mutations / reveals + cold-store internals
 *   (compliance-class — never purged).
 */
export const ACCESS_LOG_COLD_DAYS: Record<AccessLogAction, ColdRetention> = {
  // 180 days — high-volume tenant reads (sampled at write-time)
  'run.detail.read': 180,
  'runs.list.read': 180,
  'runs.filters.read': 180,
  'sources.list.read': 180,
  'run.orch_logs.read': 180,
  'step.logs.read': 180,
  'attestations.read': 180,
  'event_log.list.read': 180,
  'environment.list.read': 180,
  'environment.get.read': 180,
  'environment.history.read': 180,
  'registration.list.read': 180,
  'global_workflows.get.read': 180,
  'held_run.list.read': 180,
  'env_binding.list.read': 180,
  'backend.list.read': 180,
  'backend.get.read': 180,

  // 30 days — internal-ops reads (rate-limited; denied/error only survive
  // write-time and they upgrade to 730 days via the override below).
  'diagnostics.read': 30,
  'scaler.capacity.read': 30,
  'scaler.agents.read': 30,

  // 730 days — sensitive reads
  'event_log.detail.read': 730,
  'event_log.payload.read': 730,
  'run.payload.read': 730,
  'env_var.list.read': 730,
  'source_override.list.read': 730,
  'access_log.list.read': 730,
  'secret.list.read': 730,

  // 730 days — tenant-plane mutations (non-secret)
  'run.cancel': 730,
  'run.rerun': 730,
  'run.manual_schedule': 730,
  'run.trigger': 730,
  'job.cancel': 730,
  'environment.create': 730,
  'environment.update': 730,
  'environment.delete': 730,
  'env_var.set': 730,
  'env_var.delete': 730,
  'source_override.set': 730,
  'source_override.delete': 730,
  'env_binding.set': 730,
  'held_run.approve': 730,
  'held_run.reject': 730,
  'held_run.request': 730,
  'held_run.expire': 730,
  'registration.disable': 730,
  'registration.delete': 730,
  'backend.sync': 730,
  'backend.sync.one': 730,
  'backend.test': 730,
  'global_workflows.update': 730,
  'org_settings.dashboard_write_policy.update': 730,
  'cluster_name.update': 730,

  // 730 days — event DLQ admin actions (Phase 5 — at-least-once delivery)
  'event_dlq.list.read': 180,
  'event_dlq.retry': 730,
  'event_dlq.discard': 730,

  // forever — secret mutations / reveals (compliance)
  'secret.set': 'forever',
  'secret.delete': 'forever',
  'secret.reveal': 'forever',
  'secret_scope.create': 'forever',
  'secret_scope.rename': 'forever',
  'secret_scope.delete': 'forever',

  // forever — cold-store internals (low volume, keep for forensics)
  archive_chunk: 'forever',
  purge_chunk: 'forever',
};

/** Override outcome cold-retention (forensic — 2 years). */
const FORENSIC_OUTCOME_COLD_DAYS: ColdRetention = 730;
/** Override actor type cold-retention (compliance — never purge). */
const PLATFORM_OPERATOR_COLD: ColdRetention = 'forever';

/**
 * Default cold TTL for action strings outside `AccessLogAction.options`. Same
 * conservative-by-default reasoning as `UNKNOWN_ACTION_WARM_DAYS`; matches
 * the 730d "tenant-plane mutations" bucket so unknown rows are kept long
 * enough for any forensic review.
 */
const UNKNOWN_ACTION_COLD_DAYS: ColdRetention = 730;

export function getAccessLogColdDays(args: {
  action: AccessLogAction;
  outcome: AccessLogOutcome;
  actorType: ActorType;
}): ColdRetention {
  if (args.outcome !== 'allowed') return FORENSIC_OUTCOME_COLD_DAYS;
  if (args.actorType === 'platform_operator') return PLATFORM_OPERATOR_COLD;
  return ACCESS_LOG_COLD_DAYS[args.action] ?? UNKNOWN_ACTION_COLD_DAYS;
}

/**
 * Cold retention for Platform `audit_log`. Mirrors `auditLogWarmDays()`.
 * Compliance-class actions (billing, RBAC, platform-admin, system events) are
 * `'forever'`; everything else (tenant-plane mutations) is 730 days.
 *
 * Same column-availability caveat as `auditLogWarmSqlCase()` — Platform
 * `audit_log` has no `outcome` or `actor_type` column; the JS-side override
 * still applies for callers that genuinely have an `actorType` to pass.
 */
export function auditLogColdDays(action: string): ColdRetention {
  if (COMPLIANCE_AUDIT_EXACT.has(action)) return 'forever';
  for (const prefix of COMPLIANCE_AUDIT_PREFIXES) {
    if (action.startsWith(prefix)) return 'forever';
  }
  return 730;
}

export function getAuditLogColdDays(args: { action: string; actorType: ActorType }): ColdRetention {
  if (args.actorType === 'platform_operator') return PLATFORM_OPERATOR_COLD;
  return auditLogColdDays(args.action);
}

/**
 * Cold retention for Orchestrator `secret_audit_log`. Sampled job-execution
 * resolves are 180 days (already sampled at 1% in the writer + warm-retained
 * 30d); everything else (mutations) is `'forever'`. The denied-outcome
 * override promotes to 730 days.
 */
export function secretAuditLogColdDays(action: string): ColdRetention {
  if (SAMPLED_RESOLVE_ACTIONS.has(action)) return 180;
  return 'forever';
}

export function getSecretAuditLogColdDays(args: {
  action: string;
  outcome: 'allowed' | 'denied';
}): ColdRetention {
  if (args.outcome !== 'allowed') return FORENSIC_OUTCOME_COLD_DAYS;
  return secretAuditLogColdDays(args.action);
}

/**
 * Test-only helper that returns the minimum warm-retention TTL across all
 * `AccessLogAction` actions and override paths. Used by adapter tests to
 * sanity-check that `DEFAULT_CONFIG.warmTtlDays` matches this minimum (so
 * the framework's partition-day scan doesn't pre-filter out rows the adapter
 * would consider eligible).
 */
export function minAccessLogWarmDays(): number {
  return Math.min(...Object.values(ACCESS_LOG_WARM_DAYS));
}

export function minSecretAuditLogWarmDays(): number {
  return Math.min(30, FORENSIC_OUTCOME_DAYS);
}

export function minAuditLogWarmDays(): number {
  // 180 is the lowest bucket emitted by `auditLogWarmDays`.
  return 180;
}
