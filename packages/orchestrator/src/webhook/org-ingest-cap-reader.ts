import { LRUCache } from 'lru-cache';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { resolveOrgId } from '../pipeline/processor.js';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'ingest-cap' });

/** Default TTL for the routing-key → customer-id cache: 5 minutes. */
const DEFAULT_ORG_TTL_MS = 5 * 60 * 1000;
/** Default TTL for the customer-id → cap cache: 30 seconds. */
const DEFAULT_CAP_TTL_MS = 30 * 1000;
/** Max entries per cache (routing keys / orgs on one orchestrator). */
const DEFAULT_MAX_ENTRIES = 10_000;

/** The resolved fairness key + per-key concurrency cap for an ingest admission. */
export interface AdmissionKey {
  key: string;
  orgCap: number;
}

export interface OrgIngestCapReader {
  /**
   * Resolve the fairness key + per-org cap for a routing key. Never throws; on a
   * DB error / cold-miss-slow it degrades to `{ key: routingKey, orgCap:
   * clusterDefault }` (per-routing-key fairness, DB-free) so admission never
   * blocks on a sick DB.
   */
  resolve(routingKey: string): Promise<AdmissionKey>;
}

export function createOrgIngestCapReader(deps: {
  db?: Kysely<Database>;
  clusterDefault: number;
  orgTtlMs?: number;
  capTtlMs?: number;
  maxEntries?: number;
}): OrgIngestCapReader {
  const { db, clusterDefault } = deps;
  const orgCache = new LRUCache<string, string>({
    max: deps.maxEntries ?? DEFAULT_MAX_ENTRIES,
    ttl: deps.orgTtlMs ?? DEFAULT_ORG_TTL_MS,
  });
  // Caches the EFFECTIVE cap (already resolved to clusterDefault when the column
  // is NULL) so a cluster-default org is not re-queried every admission within
  // the TTL. clusterDefault is fixed at construction, so caching the resolved
  // value never goes stale relative to it.
  const capCache = new LRUCache<string, number>({
    max: deps.maxEntries ?? DEFAULT_MAX_ENTRIES,
    ttl: deps.capTtlMs ?? DEFAULT_CAP_TTL_MS,
  });

  const readOrgCap = async (orgId: string): Promise<number> => {
    const cached = capCache.get(orgId);
    if (cached !== undefined) return cached;
    const row = await db!
      .selectFrom('org_settings')
      .select('ingest_max_concurrency')
      .where('customer_id', '=', orgId)
      .executeTakeFirst();
    const value =
      row?.ingest_max_concurrency != null ? Number(row.ingest_max_concurrency) : clusterDefault;
    capCache.set(orgId, value);
    return value;
  };

  const resolveOrg = async (routingKey: string): Promise<string> => {
    const cached = orgCache.get(routingKey);
    if (cached !== undefined) return cached;
    const orgId = await resolveOrgId(db!, routingKey);
    orgCache.set(routingKey, orgId);
    return orgId;
  };

  return {
    async resolve(routingKey: string): Promise<AdmissionKey> {
      if (!db) return { key: routingKey, orgCap: clusterDefault };
      try {
        const orgId = await resolveOrg(routingKey);
        const orgCap = await readOrgCap(orgId);
        return { key: orgId, orgCap };
      } catch (err) {
        // DB-degraded: key fairness on the routing key with the cluster default,
        // so admission never waits on the resource most likely to be overloaded.
        logger.warn('ingest cap reader degraded to routing-key fairness', {
          routingKey,
          error: toErrorMessage(err),
        });
        return { key: routingKey, orgCap: clusterDefault };
      }
    },
  };
}
