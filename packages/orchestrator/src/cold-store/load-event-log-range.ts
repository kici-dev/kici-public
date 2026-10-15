/**
 * Read-through helper for `event_log`; mirrors the Platform-side `load-event-log-range.ts`.
 *
 * Tenant column is `routing_key` (NOT NULL here, so no synthetic-tenant fallback); partition
 * column is `received_at`. Cold-store archives the row metadata and keeps `payload_key` (the
 * S3 object holding the gzipped webhook body) verbatim; the blob stays in object storage
 * indefinitely, so the payload-detail view resolves archived deliveries like hot ones.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { EventLogColdStoreRow } from './tables/event-log.js';

/**
 * Re-exported, not re-declared: the alias lives beside the cold-store adapter that owns the
 * table (a second declaration trips the homonym sweep); the export keeps this module's surface.
 */
export type { EventLogColdStoreRow };

const logger = createLogger({ prefix: 'load-event-log-range' });

export interface LoadOrchEventLogRangeArgs {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  /** Tenant column; required for `includeArchived` because the cold-store fetch is keyed by it. */
  routingKey: string;
  /** Optional org filter (event_log carries org_id for cross-tier joins). */
  orgId?: string;
  event?: string;
  action?: string;
  status?: string;
  deliveryId?: string;
  fromTs?: Date;
  toTs?: Date;
  limit: number;
  offset: number;
  includeArchived: boolean;
}

export async function loadEventLogRange(
  args: LoadOrchEventLogRangeArgs,
): Promise<EventLogColdStoreRow[]> {
  const {
    db,
    coldStore,
    routingKey,
    orgId,
    event,
    action,
    status,
    deliveryId,
    fromTs,
    toTs,
    limit,
    offset,
    includeArchived,
  } = args;

  let hotQuery = db.selectFrom('event_log').selectAll().where('routing_key', '=', routingKey);
  if (orgId) hotQuery = hotQuery.where('org_id', '=', orgId);
  if (event) hotQuery = hotQuery.where('event', '=', event);
  if (action) hotQuery = hotQuery.where('action', '=', action);
  if (status) hotQuery = hotQuery.where('status', '=', status);
  if (deliveryId) hotQuery = hotQuery.where('delivery_id', 'like', `%${deliveryId}%`);
  if (fromTs) hotQuery = hotQuery.where('received_at', '>=', fromTs);
  if (toTs) hotQuery = hotQuery.where('received_at', '<', toTs);

  const hotRows = await hotQuery
    .orderBy('received_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  if (!includeArchived || !coldStore) return hotRows;

  // The bound comes from the store so it always matches what the archiver used.
  const warmCutoff = coldStore.warmCutoff('event_log');
  const coldFromTs = fromTs ?? new Date(0);
  if (coldFromTs >= warmCutoff) return hotRows;

  const remaining = limit - hotRows.length;
  if (remaining <= 0) return hotRows;

  // Pages past the hot tail already consumed some cold rows: offset cold by
  // `offset - hotCount` (mirrors `load-secret-audit-log-range.ts`).
  let hotCountQuery = db
    .selectFrom('event_log')
    .select(sql<string>`count(*)::text`.as('n'))
    .where('routing_key', '=', routingKey);
  if (orgId) hotCountQuery = hotCountQuery.where('org_id', '=', orgId);
  if (event) hotCountQuery = hotCountQuery.where('event', '=', event);
  if (action) hotCountQuery = hotCountQuery.where('action', '=', action);
  if (status) hotCountQuery = hotCountQuery.where('status', '=', status);
  if (deliveryId) hotCountQuery = hotCountQuery.where('delivery_id', 'like', `%${deliveryId}%`);
  if (fromTs) hotCountQuery = hotCountQuery.where('received_at', '>=', fromTs);
  if (toTs) hotCountQuery = hotCountQuery.where('received_at', '<', toTs);
  const hotCount = Number((await hotCountQuery.executeTakeFirst())?.n ?? '0');
  const coldOffset = Math.max(0, offset - hotCount);

  const coldToTs = toTs && toTs < warmCutoff ? toTs : warmCutoff;
  const coldRows: EventLogColdStoreRow[] = [];

  // The cold stream is newest-first: stop once `coldOffset + remaining` rows match.
  try {
    for await (const row of coldStore.fetchRange<EventLogColdStoreRow>({
      db: 'orchestrator',
      table: 'event_log',
      tenantId: routingKey,
      fromTs: coldFromTs,
      toTs: coldToTs,
      order: 'desc',
    })) {
      if (orgId !== undefined && row.org_id !== orgId) continue;
      if (event !== undefined && row.event !== event) continue;
      if (action !== undefined && row.action !== action) continue;
      if (status !== undefined && row.status !== status) continue;
      if (deliveryId !== undefined && !row.delivery_id.includes(deliveryId)) continue;
      coldRows.push(row);
      if (coldRows.length >= coldOffset + remaining) break;
    }
  } catch (err) {
    if (hotRows.length === 0) {
      // Cold was the only source: [] would read as end-of-results and silently drop the
      // remaining cold rows, so propagate for the HTTP handler to surface a typed error.
      logger.error('cold-store fetchRange failed with no hot fallback; propagating', {
        routingKey,
        error: toErrorMessage(err),
      });
      throw err;
    }
    logger.warn('cold-store fetchRange failed; returning hot rows only', {
      routingKey,
      error: toErrorMessage(err),
    });
    return hotRows;
  }

  return [...hotRows, ...coldRows.slice(coldOffset, coldOffset + remaining)];
}

/**
 * Detail lookup by `(orgId, deliveryId)`. The dashboard handler joins
 * cross-tier on this composite key. Hot first; on miss scans cold for
 * the matching tenant. The caller must pass `routingKey` to scope the
 * cold scan; without it a hot miss returns `null` (the dashboard
 * always knows the routing_key from the Platform-side row).
 */
export async function loadEventLogByDeliveryId(args: {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  orgId: string;
  deliveryId: string;
  /**
   * Routing-key hint that scopes the cold scan. When omitted, the cold
   * scan is skipped with a warning and a hot miss returns `null`. The
   * dashboard always provides this hint from the Platform-side join.
   */
  routingKey?: string;
}): Promise<EventLogColdStoreRow | null> {
  const { db, coldStore, orgId, deliveryId, routingKey } = args;

  const hotRow = await db
    .selectFrom('event_log')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('delivery_id', '=', deliveryId)
    .executeTakeFirst();
  if (hotRow) return hotRow;
  if (!coldStore) return null;

  // The archived rows are gone from the hot table, so the routing_key cannot be
  // looked up here: without the caller's hint, warn and skip the cold scan.
  if (!routingKey) {
    logger.warn('cold-store delivery lookup without routingKey hint — scan skipped', {
      orgId,
      deliveryId,
    });
    return null;
  }

  // No explicit upper bound: the store resolves `event_log`'s warm cutoff.
  try {
    for await (const row of coldStore.fetchRange<EventLogColdStoreRow>({
      db: 'orchestrator',
      table: 'event_log',
      tenantId: routingKey,
      fromTs: new Date(0),
    })) {
      if (row.org_id === orgId && row.delivery_id === deliveryId) {
        return row;
      }
    }
  } catch (err) {
    logger.warn('cold-store fetchRange failed for delivery lookup', {
      routingKey,
      orgId,
      deliveryId,
      error: toErrorMessage(err),
    });
  }
  return null;
}
