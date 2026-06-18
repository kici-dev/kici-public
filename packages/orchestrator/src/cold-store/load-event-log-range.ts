/**
 * Read-through helper for `event_log` (Orchestrator) — Phase E.
 *
 * Mirrors the Platform-side `load-event-log-range.ts`. Tenant column is
 * `routing_key` (NOT NULL on this side) so cold-store partitioning
 * doesn't need a synthetic-tenant fallback. Partition column is
 * `received_at`.
 *
 * The orchestrator's `event_log` row carries the `payload_key` reference
 * (an S3 object that holds the gzipped webhook body). Cold-store
 * archives the row metadata and preserves `payload_key` verbatim — the
 * payload blob itself stays in object storage indefinitely so the
 * dashboard's payload-detail view continues to resolve archived
 * deliveries identically to hot ones.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type { Database, EventLogTable } from '../db/types.js';

const logger = createLogger({ prefix: 'load-event-log-range' });

const EVENT_LOG_WARM_TTL_DAYS = 30;

export type EventLogColdStoreRow = Selectable<EventLogTable>;

export interface LoadOrchEventLogRangeArgs {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  /**
   * Routing key (tenant column on this side). Required when
   * `includeArchived` is true — cold-store fetch is keyed by tenant.
   * The hot list endpoint also typically narrows by routing_key.
   */
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

  const warmCutoff = new Date(Date.now() - EVENT_LOG_WARM_TTL_DAYS * 86_400_000);

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

  const coldFromTs = fromTs ?? new Date(0);
  if (coldFromTs >= warmCutoff) return hotRows;

  const remaining = limit - hotRows.length;
  if (remaining <= 0) return hotRows;

  // Cold-side offset: when the caller paginates past the hot tail the
  // earlier pages already consumed some cold rows, so skip them. Count
  // the hot rows that match the filter in-range, then offset cold by
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

  // Collect every matching cold row before sorting. `fetchRange` yields
  // chunks oldest-first, so breaking early at `remaining` would keep the
  // OLDEST rows and drop the newest — the opposite of the
  // `received_at DESC` contract. Sort the full set, then slice.
  try {
    for await (const row of coldStore.fetchRange<EventLogColdStoreRow>({
      db: 'orchestrator',
      table: 'event_log',
      tenantId: routingKey,
      fromTs: coldFromTs,
      toTs: coldToTs,
    })) {
      if (orgId !== undefined && row.org_id !== orgId) continue;
      if (event !== undefined && row.event !== event) continue;
      if (action !== undefined && row.action !== action) continue;
      if (status !== undefined && row.status !== status) continue;
      if (deliveryId !== undefined && !row.delivery_id.includes(deliveryId)) continue;
      coldRows.push(row);
    }
  } catch (err) {
    if (hotRows.length === 0) {
      // No hot fallback for this page — the caller paginated past the
      // hot tail and cold was the only source. Returning [] would look
      // like end-of-results to the caller and silently drop the
      // remaining cold rows. Propagate so the upstream HTTP handler
      // surfaces a typed error instead.
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

  coldRows.sort((a, b) => {
    const at =
      a.received_at instanceof Date ? a.received_at.getTime() : new Date(a.received_at).getTime();
    const bt =
      b.received_at instanceof Date ? b.received_at.getTime() : new Date(b.received_at).getTime();
    return bt - at;
  });
  return [...hotRows, ...coldRows.slice(coldOffset, coldOffset + remaining)];
}

/**
 * Detail lookup by `(orgId, deliveryId)`. The dashboard handler joins
 * cross-tier on this composite key. Hot first; on miss scans cold for
 * the matching tenant. The caller must know `routingKey` to scope the
 * cold scan — when only `orgId+deliveryId` are known, callers fall
 * back to enumerating all routing keys for the org (rare; the dashboard
 * always knows the routing_key from the Platform-side row).
 */
export async function loadEventLogByDeliveryId(args: {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  orgId: string;
  deliveryId: string;
  /**
   * Optional routing-key hint. When omitted, the cold scan iterates
   * every routing_key for the org — bounded but slower. The dashboard
   * always provides this hint from the Platform-side join.
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

  // Find the routing_key. If the caller didn't pass it, sniff it from
  // a previously-archived row in the same org via SELECT (the row's
  // `archive_object_key` was stamped before DELETE — but rows are
  // gone by now, so this branch is unreachable in steady state). The
  // robust path: the caller passes routingKey; we error-log if absent.
  if (!routingKey) {
    logger.warn('cold-store delivery lookup without routingKey hint — scan skipped', {
      orgId,
      deliveryId,
    });
    return null;
  }

  const warmCutoff = new Date(Date.now() - EVENT_LOG_WARM_TTL_DAYS * 86_400_000);
  try {
    for await (const row of coldStore.fetchRange<EventLogColdStoreRow>({
      db: 'orchestrator',
      table: 'event_log',
      tenantId: routingKey,
      fromTs: new Date(0),
      toTs: warmCutoff,
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
