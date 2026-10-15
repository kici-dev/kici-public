import type { Kysely } from 'kysely';
import type { PlanHeadroom } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

/** The ceiling as last pushed by the Platform. */
export interface StoredPlanHeadroom {
  maxWorkerPeers: number;
  orgLimit: number;
  orgTotal: number;
  evictExcess: boolean;
  updatedAt: Date;
}

const ROW_ID = 'default';

/**
 * Persisted cache of the Platform-owned worker ceiling, so a coordinator
 * restarting during a Platform outage keeps the last known ceiling instead of
 * unlimited. Like `org_trust_policy`, the Platform writes it and the orchestrator
 * only reads it back.
 */
export class PlanHeadroomStore {
  constructor(private readonly db: Kysely<Database>) {}

  async read(): Promise<StoredPlanHeadroom | null> {
    const row = await this.db
      .selectFrom('org_plan_headroom')
      .selectAll()
      .where('id', '=', ROW_ID)
      .executeTakeFirst();
    if (!row) return null;
    return {
      maxWorkerPeers: row.max_worker_peers,
      orgLimit: row.org_limit,
      orgTotal: row.org_total,
      evictExcess: row.evict_excess,
      updatedAt: row.updated_at,
    };
  }

  async write(headroom: PlanHeadroom): Promise<void> {
    const values = {
      id: ROW_ID,
      max_worker_peers: headroom.maxWorkerPeers,
      org_limit: headroom.orgLimit,
      org_total: headroom.orgTotal,
      evict_excess: headroom.evictExcess,
      updated_at: new Date(),
    };
    await this.db
      .insertInto('org_plan_headroom')
      .values(values)
      .onConflict((oc) => oc.column('id').doUpdateSet(values))
      .execute();
  }
}
