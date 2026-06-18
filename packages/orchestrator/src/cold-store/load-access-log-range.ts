/**
 * Read-through helper for `access_log` (Orchestrator) — Phase D.
 *
 * Unlike `audit_log` and `secret_audit_log`, the `access_log` callers
 * (dashboard "Data access" tab, admin HTTP route, `kici-admin
 * access-log list` CLI) all use the same cursor-based pagination
 * already implemented by `AccessLogWriter.query()`. Phase D's design
 * §7 row 11 classifies access_log as "paginated/transparent" — there
 * is NO `--include-archived` flag. The helper merges cold rows
 * automatically when pagination crosses the warm cutoff or the caller
 * supplies a `from` timestamp older than warm.
 *
 * Cursor extension: the existing cursor encodes `{createdAt, id}` for
 * the hot tuple comparison `(created_at, id) < (cursor.createdAt, cursor.id)`.
 * The cursor also carries a `source: 'hot' | 'cold'` discriminator so a
 * cursor minted while the page boundary was inside cold can resume in
 * the cold stream on the next request. Cursors without a `source` field
 * default to `'hot'` — backwards-compatible with any tab the user had
 * open across a deploy boundary.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import {
  minAccessLogWarmDays,
  type AccessLogAction,
  type AccessLogItem,
  type AccessLogOutcome,
  type AccessLogSource,
  type AccessLogTargetType,
  type ActorType,
} from '@kici-dev/engine';
import type { AccessLogTable, Database } from '../db/types.js';

const logger = createLogger({ prefix: 'load-access-log-range' });

/**
 * Warm cutoff = the table's MINIMUM per-category TTL. Any row younger than
 * this is guaranteed still in PG (no category archives sooner). Older rows
 * may be in PG (long-TTL category not yet eligible), in cold (short-TTL
 * category already archived), or both — the merge handles overlap by id.
 *
 * Sourced from the engine's per-action retention table so this constant
 * stays in lockstep with `AccessLogAdapter.DEFAULT_CONFIG.warmTtlDays`.
 */
const ACCESS_LOG_WARM_TTL_DAYS = minAccessLogWarmDays();

/**
 * Synthetic tenant placeholder for orchestrator-level rows whose `org_id IS
 * NULL` — collapses every NULL-tenant row under one cold-store prefix so the
 * `(tenant_id, day)` partition scheme still yields a single scan key. Shared
 * across every cold-store reader / adapter touching tables that may emit
 * NULL-tenant rows (`access_log`, `secret_audit_log`); export once here so
 * the four call sites in `cold-store/` and the fallback in
 * `audit/access-log.ts` cannot drift apart.
 */
export const SYNTHETIC_ORCH_TENANT = '__orchestrator__';

export type AccessLogColdRow = Selectable<AccessLogTable>;

export interface LoadAccessLogRangeArgs {
  db: Kysely<Database>;
  coldStore: ColdStore | undefined;
  filter: {
    orgId?: string;
    actorType?: ActorType;
    actorId?: string;
    action?: AccessLogAction;
    source?: AccessLogSource;
    outcome?: AccessLogOutcome;
    targetType?: AccessLogTargetType;
    targetId?: string;
    fromTimestamp?: Date | string;
    toTimestamp?: Date | string;
    /**
     * Full-text search over `error_message`. Trigram-indexed via migration
     * `009_access_log_trigram.ts`. Min ~3 chars for the index to help.
     */
    q?: string;
  };
  limit: number;
  cursor?: string;
}

export interface LoadAccessLogRangeResult {
  items: AccessLogItem[];
  nextCursor: string | null;
}

interface ParsedCursor {
  source: 'hot' | 'cold';
  createdAt: string;
  id: string;
}

export async function loadAccessLogRange(
  args: LoadAccessLogRangeArgs,
): Promise<LoadAccessLogRangeResult> {
  const { db, coldStore, filter, limit } = args;
  const cursor = args.cursor ? parseCursor(args.cursor) : null;
  const warmCutoff = new Date(Date.now() - ACCESS_LOG_WARM_TTL_DAYS * 86_400_000);

  // ── 1. Hot path ────────────────────────────────────────────────
  // Skip when the cursor explicitly resumes in cold; otherwise run
  // the legacy hot SELECT with limit + 1 to detect "needs more".
  const fromTs = parseDate(filter.fromTimestamp);
  const toTs = parseDate(filter.toTimestamp);

  const hotItems: AccessLogItem[] = [];
  let hotHasMore = false;

  if (!cursor || cursor.source === 'hot') {
    let q = db
      .selectFrom('access_log')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (filter.orgId !== undefined) q = q.where('org_id', '=', filter.orgId);
    if (filter.actorType) q = q.where('actor_type', '=', filter.actorType);
    if (filter.actorId) q = q.where('actor_id', '=', filter.actorId);
    if (filter.action) q = q.where('action', '=', filter.action);
    if (filter.source) q = q.where('source', '=', filter.source);
    if (filter.outcome) q = q.where('outcome', '=', filter.outcome);
    if (filter.targetType) q = q.where('target_type', '=', filter.targetType);
    if (filter.targetId) q = q.where('target_id', '=', filter.targetId);
    if (filter.q && filter.q.length > 0) {
      // Trigram-indexed ILIKE on error_message (migration 009).
      q = q.where(sql<boolean>`error_message ILIKE ${'%' + filter.q + '%'}`);
    }
    if (fromTs) q = q.where('created_at', '>=', fromTs);
    if (toTs) q = q.where('created_at', '<', toTs);
    if (cursor && cursor.source === 'hot') {
      q = q.where(
        sql`(created_at, id)`,
        '<',
        sql`(${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const hotRows = await q.execute();
    hotHasMore = hotRows.length > limit;
    const hotPage = hotHasMore ? hotRows.slice(0, limit) : hotRows;
    for (const r of hotPage) {
      hotItems.push(toAccessLogItem(r as unknown as AccessLogColdRow));
    }
  }

  // ── 2. Decide whether to descend into cold ─────────────────────
  // Cold becomes relevant when:
  //   (a) caller passed cursor.source === 'cold'
  //   (b) hot returned fewer than `limit` items AND fromTs (if any)
  //       is older than warmCutoff
  //   (c) no cold-store wired → skip
  const wantCold =
    !!coldStore && (cursor?.source === 'cold' || (!hotHasMore && hotItems.length < limit));
  const coldFromTs = fromTs ?? new Date(0);
  if (!wantCold || coldFromTs >= warmCutoff) {
    return {
      items: hotItems,
      nextCursor:
        hotHasMore && hotItems.length > 0 ? buildHotCursor(hotItems[hotItems.length - 1]) : null,
    };
  }

  // ── 3. Cold path ───────────────────────────────────────────────
  const coldToTs = toTs && toTs < warmCutoff ? toTs : warmCutoff;
  const coldRemaining = limit - hotItems.length;

  // Tenants to scan: when caller supplies orgId, scan that tenant
  // exclusively. When orgId is omitted (which the dashboard rarely
  // does — admin queries can), scan the synthetic tenant only.
  // Multi-tenant scans without an orgId are not supported via this
  // helper — callers should supply an orgId.
  const tenantToScan = filter.orgId ?? SYNTHETIC_ORCH_TENANT;

  const coldItems: AccessLogItem[] = [];
  try {
    for await (const row of coldStore.fetchRange<AccessLogColdRow>({
      db: 'orchestrator',
      table: 'access_log',
      tenantId: tenantToScan,
      fromTs: coldFromTs,
      toTs: coldToTs,
    })) {
      if (filter.actorType && row.actor_type !== filter.actorType) continue;
      if (filter.actorId && row.actor_id !== filter.actorId) continue;
      if (filter.action && row.action !== filter.action) continue;
      if (filter.source && row.source !== filter.source) continue;
      if (filter.outcome && row.outcome !== filter.outcome) continue;
      if (filter.targetType && row.target_type !== filter.targetType) continue;
      if (filter.targetId && row.target_id !== filter.targetId) continue;
      if (filter.q && filter.q.length > 0) {
        const haystack = (row.error_message ?? '').toLowerCase();
        if (!haystack.includes(filter.q.toLowerCase())) continue;
      }
      coldItems.push(toAccessLogItem(row));
    }
  } catch (err) {
    if (cursor?.source === 'cold') {
      // Cold-resume mode has no hot fallback: hotItems is empty and
      // hotHasMore is false because the hot SELECT was skipped above.
      // Returning {items:[], nextCursor:null} would look like
      // end-of-results to the dashboard / CLI and silently drop the
      // remaining cold rows. Propagate so handleAccessLogList surfaces
      // the error band instead.
      logger.error('cold-store fetchRange failed during cold-resume; propagating', {
        tenantId: tenantToScan,
        error: toErrorMessage(err),
      });
      throw err;
    }
    logger.warn('cold-store fetchRange failed; returning hot rows only', {
      tenantId: tenantToScan,
      error: toErrorMessage(err),
    });
    return {
      items: hotItems,
      nextCursor:
        hotHasMore && hotItems.length > 0 ? buildHotCursor(hotItems[hotItems.length - 1]) : null,
    };
  }

  coldItems.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  // If resuming in cold, drop everything ≥ cursor.
  let coldStart = 0;
  if (cursor && cursor.source === 'cold') {
    coldStart = coldItems.findIndex(
      (it) =>
        it.createdAt < cursor.createdAt || (it.createdAt === cursor.createdAt && it.id < cursor.id),
    );
    if (coldStart < 0) coldStart = coldItems.length;
  }

  const coldPage = coldItems.slice(coldStart, coldStart + coldRemaining);
  const coldHasMore = coldStart + coldRemaining < coldItems.length;

  const merged = [...hotItems, ...coldPage];
  const nextCursor =
    coldHasMore && coldPage.length > 0
      ? buildColdCursor(coldPage[coldPage.length - 1])
      : hotHasMore && hotItems.length > 0 && coldPage.length === 0
        ? buildHotCursor(hotItems[hotItems.length - 1])
        : null;

  return { items: merged, nextCursor };
}

function parseDate(v: Date | string | undefined): Date | undefined {
  if (v === undefined) return undefined;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Canonical hot-or-cold `AccessLogRow → AccessLogItem` adapter. Exported
 * because `AccessLogWriter.getById` (in `audit/access-log.ts`) needs to
 * convert both hot (`AccessLogRow`) and cold (`AccessLogColdRow`) rows
 * into the same `AccessLogItem` shape — the two row types are
 * structurally identical (`Selectable<AccessLogTable>`), so a single
 * converter avoids drift.
 */
export function toAccessLogItem(row: AccessLogColdRow): AccessLogItem {
  return {
    id: String(row.id),
    orgId: row.org_id,
    routingKey: row.routing_key,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    actorMeta: (row.actor_meta as Record<string, unknown> | null) ?? null,
    action: row.action as AccessLogAction,
    targetType: (row.target_type as AccessLogTargetType | null) ?? null,
    targetId: row.target_id,
    requestId: row.request_id,
    source: row.source as AccessLogSource,
    outcome: row.outcome as AccessLogOutcome,
    errorMessage: row.error_message,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function buildHotCursor(item: AccessLogItem): string {
  const payload: ParsedCursor = { source: 'hot', createdAt: item.createdAt, id: item.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function buildColdCursor(item: AccessLogItem): string {
  const payload: ParsedCursor = { source: 'cold', createdAt: item.createdAt, id: item.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseCursor(cursor: string): ParsedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }
    // Backward compat: pre-Phase-D cursors lack `source`; treat as hot.
    const source = parsed.source === 'cold' ? 'cold' : 'hot';
    return { source, createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
