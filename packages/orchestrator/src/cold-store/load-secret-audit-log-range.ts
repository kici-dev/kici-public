/**
 * Read-through helper for `secret_audit_log` (Orchestrator).
 *
 * Follows the execution-table reader pattern with `AuditLogger.query()`'s
 * offset/limit shape. Cold rows are fetched only when `includeArchived` is
 * true (`kici-admin secret audit --include-archived`, or the admin HTTP query
 * param); hot-only is the default so tooling skips an S3 round-trip.
 *
 * Hot-side filters also apply to cold rows: routingKey selects the tenant, the
 * time bounds go to `fetchRange`, and contextName / action are checked
 * in-process, because cold chunks are partitioned by `(routing_key, day)`,
 * not by the secondary filters.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type { Database, SecretAuditLogRow } from '../db/types.js';

/** Re-exported rather than re-declared — see the note in `load-event-log-range`. */
export type { SecretAuditLogRow };
import { SYNTHETIC_ORCH_TENANT } from './load-access-log-range.js';

const logger = createLogger({ prefix: 'load-secret-audit-log-range' });

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

  // Hot path mirroring AuditLogger.query().
  let hotQuery = db.selectFrom('secret_audit_log').selectAll().orderBy('timestamp', 'desc');
  if (contextName) hotQuery = hotQuery.where('context_name', '=', contextName);
  if (routingKey) hotQuery = hotQuery.where('routing_key', '=', routingKey);
  if (action) hotQuery = hotQuery.where('action', '=', action);
  if (fromTs) hotQuery = hotQuery.where('timestamp', '>=', fromTs);
  if (toTs) hotQuery = hotQuery.where('timestamp', '<', toTs);

  const hotRows = (await hotQuery.limit(limit).offset(offset).execute()) as SecretAuditLogRow[];

  if (!includeArchived || !coldStore) return hotRows;
  // The bound is the table's MINIMUM per-category TTL from the archiver's
  // adapter config: sampled `resolve` / `resolve_named` rows archive soonest
  // and mutations far later, so the minimum keeps the read window widest.
  const warmCutoff = coldStore.warmCutoff('secret_audit_log');
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

  // Each chunk has one tenant: `routing_key` or synthetic `__orchestrator__`.
  // The adapter has no tenant-list helper, so without a routingKey filter only
  // the synthetic tenant (orchestrator-level rotations) is scanned.
  const tenantsToScan = routingKey ? [routingKey] : [SYNTHETIC_ORCH_TENANT];

  const coldRows: SecretAuditLogRow[] = [];
  // The cold stream is newest-first: stop once `coldOffset + remaining` rows match.
  try {
    for (const tenant of tenantsToScan) {
      for await (const row of coldStore.fetchRange<SecretAuditLogRow>({
        db: 'orchestrator',
        table: 'secret_audit_log',
        tenantId: tenant,
        fromTs: coldFromTs,
        toTs: coldToTs,
        order: 'desc',
      })) {
        if (contextName && row.context_name !== contextName) continue;
        if (action && row.action !== action) continue;
        coldRows.push(row);
        if (coldRows.length >= coldOffset + remaining) break;
      }
    }
  } catch (err) {
    if (hotRows.length === 0) {
      // Past the hot tail, cold is the only source: returning [] would read as
      // end-of-results, so propagate and let the HTTP handler send a typed error.
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

  const coldSlice = coldRows.slice(coldOffset, coldOffset + remaining);
  return [...hotRows, ...coldSlice];
}
