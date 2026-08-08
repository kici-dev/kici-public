import type { Kysely, Transaction } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import {
  agentLabelOf,
  flattenActor,
  shouldRecordAccess,
  type AccessLogAction,
  type AccessLogItem,
  type AccessLogOutcome,
  type AccessLogRateLimiter,
  type AccessLogSource,
  type AccessLogTargetType,
  type ActorPrincipal,
  type ActorType,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import {
  loadAccessLogRange,
  toAccessLogItem,
  SYNTHETIC_ORCH_TENANT,
  type AccessLogColdRow,
} from '../cold-store/load-access-log-range.js';
import { SamplingRateLimiter } from './sampling-rate-limiter.js';

const logger = createLogger({ prefix: 'access-log' });

export interface AccessLogRecord {
  orgId: string | null;
  routingKey: string | null;
  actor: ActorPrincipal;
  action: AccessLogAction;
  target: { type: AccessLogTargetType; id: string } | null;
  requestId: string | null;
  source: AccessLogSource;
  outcome: AccessLogOutcome;
  errorMessage?: string | null;
  /**
   * Extra key/value pairs merged into `actor_meta` on insert. Lets
   * callers attach action-specific context (e.g. which dashboard-write
   * operation flipped) without overloading other columns. Values must
   * be JSON-serialisable.
   */
  meta?: Record<string, unknown>;
}

export interface AccessLogQueryFilter {
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
  /** Full-text search over error_message (trigram-indexed). */
  q?: string;
  /** Exact-match filter on the agent provenance label (`agent_label` column). */
  agentLabel?: string;
  /** When true, return only agent-attributed rows (`agent_label IS NOT NULL`). */
  agentOnly?: boolean;
  limit?: number;
  cursor?: string;
}

export interface AccessLogQueryResult {
  items: AccessLogItem[];
  nextCursor: string | null;
}

/**
 * Best-effort writer for the orchestrator `access_log` table. Records one
 * row per read / orchestrator-admin mutation attributable to an
 * ActorPrincipal. Callers get their actor from the incoming Platform proxy
 * message (`msg.actor`) or from the admin HTTP auth chain.
 *
 * Failure mode: insert errors are logged and swallowed — a broken
 * access_log table MUST NOT take down dashboard reads. Use `secret_audit_log`
 * for the always-consistent secret mutation path; `access_log` is the
 * read + broad-surface audit stream.
 */
export class AccessLogWriter {
  private readonly db: Kysely<Database>;
  private coldStore: ColdStore | undefined;
  private readonly rateLimiter: AccessLogRateLimiter;

  constructor(
    db: Kysely<Database>,
    coldStore?: ColdStore,
    rateLimiter: AccessLogRateLimiter = new SamplingRateLimiter(),
  ) {
    this.db = db;
    this.coldStore = coldStore;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Late-binding setter for the cold-store handle. orchestrator-core
   * builds AccessLogWriter before the cold-store singleton, then
   * attaches it via this setter (mirrors AuditLogger.setColdStore).
   */
  setColdStore(coldStore: ColdStore | null): void {
    this.coldStore = coldStore ?? undefined;
  }

  async record(entry: AccessLogRecord): Promise<void> {
    // The whole body runs under a single try/catch so the documented
    // best-effort contract holds for every call site. Every consumer
    // uses `void this.accessLog.record(...)` (fire-and-forget), so a
    // throw from the policy gate or the limiter would surface as an
    // unhandled promise rejection — which crashes the orchestrator
    // under Node's default rejection handling.
    try {
      await this.insert(this.db, entry);
    } catch (err) {
      logger.error('access_log record failed', {
        error: toErrorMessage(err),
        action: entry.action,
        source: entry.source,
      });
    }
  }

  /**
   * Transactional variant: writes the row through the caller's executor so it
   * commits or rolls back with the mutation it audits.
   *
   * Unlike `record`, failures PROPAGATE. The best-effort swallow exists so a
   * broken `access_log` cannot take down dashboard reads; a caller that opted
   * into a transaction is asserting the opposite — the mutation must not land
   * unaudited — so the error has to reach the transaction and abort it.
   *
   * The per-action `POLICY_BY_ACTION` gate still applies, so a `sample` /
   * `rate_limit` action would be dropped here silently and the caller's
   * mutation would commit unaudited after all. Callers must therefore use an
   * action whose policy is `always` — which is why `trust_policy.updated` is
   * one.
   */
  async recordInTransaction(
    executor: Kysely<Database> | Transaction<Database>,
    entry: AccessLogRecord,
  ): Promise<void> {
    await this.insert(executor, entry);
  }

  private async insert(
    executor: Kysely<Database> | Transaction<Database>,
    entry: AccessLogRecord,
  ): Promise<void> {
    // Apply the engine's per-action policy (sample / rate-limit / always)
    // with the platform_operator + denied/error overrides. Drops here are
    // the volume-reduction half of the design.
    if (
      !shouldRecordAccess(
        entry.action,
        entry.outcome,
        entry.actor,
        entry.requestId,
        this.rateLimiter,
      )
    ) {
      return;
    }
    const { actorType, actorId, actorMeta } = flattenActor(entry.actor);
    const mergedMeta = entry.meta ? { ...(actorMeta ?? {}), ...entry.meta } : actorMeta;
    // An agent-kind credential carries its label on the user (PAT) or api_key
    // actor; promote it to a queryable column so the access log can be
    // filtered by agent regardless of credential family.
    const agentLabel = agentLabelOf(entry.actor);
    await executor
      .insertInto('access_log')
      .values({
        org_id: entry.orgId,
        routing_key: entry.routingKey,
        actor_type: actorType,
        actor_id: actorId,
        actor_meta: mergedMeta,
        action: entry.action,
        target_type: entry.target?.type ?? null,
        target_id: entry.target?.id ?? null,
        request_id: entry.requestId,
        source: entry.source,
        outcome: entry.outcome,
        error_message: entry.errorMessage ?? null,
        agent_label: agentLabel,
      })
      .execute();
  }

  /**
   * Phase D: delegates to `loadAccessLogRange` so cold-store rows are
   * merged transparently when pagination crosses the warm cutoff. The
   * caller-visible `{items, nextCursor}` shape is preserved. NO
   * --include-archived flag — access_log is "paginated/transparent"
   * per design §7 row 11.
   */
  async query(filter: AccessLogQueryFilter): Promise<AccessLogQueryResult> {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
    return loadAccessLogRange({
      db: this.db,
      coldStore: this.coldStore,
      filter: {
        orgId: filter.orgId,
        actorType: filter.actorType,
        actorId: filter.actorId,
        action: filter.action,
        source: filter.source,
        outcome: filter.outcome,
        targetType: filter.targetType,
        targetId: filter.targetId,
        fromTimestamp: filter.fromTimestamp,
        toTimestamp: filter.toTimestamp,
        q: filter.q,
        agentLabel: filter.agentLabel,
        agentOnly: filter.agentOnly,
      },
      limit,
      cursor: filter.cursor,
    });
  }

  /**
   * Detail lookup by row id. Hot first; on miss falls back to a single
   * cold-store tenant scan filtering by `id`. Mirrors the
   * `loadEventLogByDeliveryId` pattern in `load-event-log-range.ts` —
   * cold-store is partitioned by `(tenant_id, day)` with no cross-tenant
   * `id` index, so the caller MUST scope the cold scan to one tenant.
   *
   * `opts.orgId` supplies the tenant scope. When omitted, only the
   * synthetic `__orchestrator__` tenant is scanned (matches the
   * NULL-org_id rows the orchestrator itself emits via
   * `cold-store-archive` / `cold-store-purge`). The CLI exposes this as
   * `kici-admin access-log show <id> --org-id <orgId>`.
   *
   * Best-effort contract: a cold-store error logs a warn line and
   * returns null, matching `loadAccessLogRange` and
   * `loadEventLogByDeliveryId`. A transient S3 outage MUST NOT
   * manufacture a misleading 404-vs-500 distinction at the HTTP layer.
   */
  async getById(id: string, opts?: { orgId?: string }): Promise<AccessLogItem | null> {
    const hot = await this.db
      .selectFrom('access_log')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (hot) return toAccessLogItem(hot as unknown as AccessLogColdRow);

    if (!this.coldStore) return null;

    const tenantId = opts?.orgId ?? SYNTHETIC_ORCH_TENANT;
    // No explicit upper bound: the store resolves `access_log`'s warm cutoff
    // from the same adapter config the archiver uses.
    try {
      for await (const row of this.coldStore.fetchRange<AccessLogColdRow>({
        db: 'orchestrator',
        table: 'access_log',
        tenantId,
        fromTs: new Date(0),
      })) {
        if (String(row.id) === id) {
          return toAccessLogItem(row);
        }
      }
    } catch (err) {
      logger.warn('cold-store fetchRange failed for access-log getById', {
        id,
        tenantId,
        error: toErrorMessage(err),
      });
      return null;
    }
    return null;
  }
}
