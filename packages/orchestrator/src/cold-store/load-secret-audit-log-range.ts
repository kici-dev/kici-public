/**
 * Read-through helper for `secret_audit_log` (Orchestrator) — Phase D.
 *
 * Mirrors the Phase B/C reader pattern. Wraps `AuditLogger.query()`'s
 * existing offset/limit shape; cold-store rows are fetched only when
 * `includeArchived === true`.
 *
 * Design contract: the `kici-admin secret audit` CLI surfaces an
 * explicit `--include-archived` flag; admin HTTP route mirrors via a
 * query param. Default is hot-only so existing tooling doesn't pay an
 * S3 round-trip on every invocation.
 *
 * Cold-side filter handling: any filter that the hot SELECT applies
 * (contextName, action, run_id, ...) is re-applied in-process to cold
 * rows after streaming. This is correct because cold chunks are
 * partitioned by `(routing_key, day)`, not by the secondary filters.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import { minSecretAuditLogWarmDays } from '@kici-dev/engine';
import type { Database, SecretAuditLogTable } from '../db/types.js';
import { SYNTHETIC_ORCH_TENANT } from './load-access-log-range.js';

const logger = createLogger({ prefix: 'load-secret-audit-log-range' });

/**
 * Warm cutoff for secret_audit_log = the table's MINIMUM per-category TTL.
 * Sourced from the engine's per-action retention table so this constant
 * stays in lockstep with `SecretAuditLogAdapter.DEFAULT_CONFIG.warmTtlDays`.
 *
 * Lowered from a flat 90d to 30d as part of the audit per-category retention
 * work — sampled `resolve` / `resolve_named` rows can archive at 30d, while
 * mutations stay 365d via the per-row CASE on the adapter.
 */
const SECRET_AUDIT_LOG_WARM_TTL_DAYS = minSecretAuditLogWarmDays();

export type SecretAuditLogRow = Selectable<SecretAuditLogTable>;

export interface LoadSecretAuditLogRangeArgs {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  /** Optional filters mirroring AuditLogger.query(). */
  contextName?: string;
  routingKey?: string;
  action?: string;
  /** Inclusive lower bound on `timestamp`. */
  fromTs?: Date;
  /** Exclusive upper bound on `timestamp`. */
  toTs?: Date;
  limit: number;
  offset: number;
  includeArchived: boolean;
}

export async function loadSecretAuditLogRange(
  args: LoadSecretAuditLogRangeArgs,
): Promise<SecretAuditLogRow[]> {
  const {
    db,
    coldStore,
    contextName,
    routingKey,
    action,
    fromTs,
    toTs,
    limit,
    offset,
    includeArchived,
  } = args;

  const warmCutoff = new Date(Date.now() - SECRET_AUDIT_LOG_WARM_TTL_DAYS * 86_400_000);

  // 1. Hot path mirroring AuditLogger.query().
  let hotQuery = db.selectFrom('secret_audit_log').selectAll().orderBy('timestamp', 'desc');
  if (contextName) hotQuery = hotQuery.where('context_name', '=', contextName);
  if (routingKey) hotQuery = hotQuery.where('routing_key', '=', routingKey);
  if (action) hotQuery = hotQuery.where('action', '=', action);
  if (fromTs) hotQuery = hotQuery.where('timestamp', '>=', fromTs);
  if (toTs) hotQuery = hotQuery.where('timestamp', '<', toTs);

  const hotRows = (await hotQuery.limit(limit).offset(offset).execute()) as SecretAuditLogRow[];

  if (!includeArchived || !coldStore) return hotRows;
  const coldFromTs = fromTs ?? new Date(0);
  if (coldFromTs >= warmCutoff) return hotRows;

  // Count hot total to compute cold-side offset.
  const hotCountRow = await (() => {
    let q = db.selectFrom('secret_audit_log').select(sql<string>`count(*)::text`.as('n'));
    if (contextName) q = q.where('context_name', '=', contextName);
    if (routingKey) q = q.where('routing_key', '=', routingKey);
    if (action) q = q.where('action', '=', action);
    if (fromTs) q = q.where('timestamp', '>=', fromTs);
    if (toTs) q = q.where('timestamp', '<', toTs);
    return q.executeTakeFirst();
  })();
  const hotCount = Number(hotCountRow?.n ?? '0');
  const remaining = limit - hotRows.length;
  if (remaining <= 0) return hotRows;
  const coldOffset = Math.max(0, offset - hotCount);

  const coldToTs = toTs && toTs < warmCutoff ? toTs : warmCutoff;

  // Cold rows live under one tenant per chunk: `routing_key` (or
  // synthetic `__orchestrator__`). When the caller filters by
  // routingKey we hit a single tenant; otherwise we'd need a list
  // helper, but the adapter doesn't expose one. For the
  // current API surface (`kici-admin secret audit`), routingKey is
  // typically supplied; when it isn't, we fall back to scanning the
  // synthetic tenant only — covers orchestrator-level rotations.
  const tenantsToScan = routingKey ? [routingKey] : [SYNTHETIC_ORCH_TENANT];

  const coldRows: SecretAuditLogRow[] = [];
  try {
    for (const tenant of tenantsToScan) {
      for await (const row of coldStore.fetchRange<SecretAuditLogRow>({
        db: 'orchestrator',
        table: 'secret_audit_log',
        tenantId: tenant,
        fromTs: coldFromTs,
        toTs: coldToTs,
      })) {
        if (contextName && row.context_name !== contextName) continue;
        if (action && row.action !== action) continue;
        coldRows.push(row);
      }
    }
  } catch (err) {
    if (hotRows.length === 0) {
      // No hot fallback for this page — the caller paginated past the
      // hot tail and cold was the only source. Returning [] would look
      // like end-of-results to the caller and silently drop the
      // remaining cold rows. Propagate so the upstream HTTP handler
      // surfaces a typed error instead.
      logger.error('cold-store fetchRange failed with no hot fallback; propagating', {
        error: toErrorMessage(err),
      });
      throw err;
    }
    logger.warn('cold-store fetchRange failed; returning hot rows only', {
      error: toErrorMessage(err),
    });
    return hotRows;
  }

  coldRows.sort(
    (a, b) =>
      new Date(b.timestamp as unknown as string | Date).getTime() -
      new Date(a.timestamp as unknown as string | Date).getTime(),
  );
  const coldSlice = coldRows.slice(coldOffset, coldOffset + remaining);
  return [...hotRows, ...coldSlice];
}
