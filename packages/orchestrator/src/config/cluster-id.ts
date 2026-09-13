/**
 * Orchestrator cluster-id resolution.
 *
 * Every orchestrator DB carries a stable UUID identifier
 * (`cluster_meta.cluster_id`) seeded once on first boot by the initial
 * schema migration. HA-cluster coords share the same orchestrator DB,
 * so they share the same `cluster_id`; two genuinely-different
 * orchestrator clusters carry distinct values.
 *
 * The orchestrator publishes `cluster_id` on `source.register` so
 * Platform can warn when two unrelated clusters in one org accidentally
 * share a `cluster_name`. This module is read-only — the row is seeded
 * by the schema migration and never written from application code.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const CLUSTER_META_KEY = 'cluster_id';

/**
 * Read the cluster id from `cluster_meta`. Throws when no row exists —
 * the row is seeded by the initial schema migration, so a missing row
 * indicates the DB was opened before migrations ran.
 */
export async function getClusterId(db: Kysely<Database>): Promise<string> {
  const row = await db
    .selectFrom('cluster_meta')
    .select(['value'])
    .where('key', '=', CLUSTER_META_KEY)
    .executeTakeFirst();
  if (!row) {
    throw new Error(
      'cluster_id not found in cluster_meta. The initial schema migration must run before boot.',
    );
  }
  return row.value;
}
