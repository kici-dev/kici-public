/**
 * Orchestrator cluster-name resolution and persistence.
 *
 * Each orchestrator carries a human-friendly cluster name that identifies
 * it on Platform's connection registry, in the dashboard's per-orch URL
 * segment (`/orgs/:cId/orchestrators/:clusterName/...`), and in operator
 * tooling. The orch is the source of truth; Platform stores a copy on
 * `platform_connections.cluster_name` for its own lookups.
 *
 * Storage: a row in the existing `cluster_meta` k/v table with
 * `key='cluster_name'`. The same table already holds `cluster_id`; no
 * migration is needed.
 *
 * Resolution on boot:
 *
 *   1. Row exists → use stored value. Operator-managed via the
 *      kici-admin CLI (which calls `setClusterName`).
 *   2. Row missing and `KICI_CLUSTER_NAME` env var set → validate
 *      against `clusterNameSchema` and persist. Fail-fast on regex
 *      violation.
 *   3. Row missing and no env var → auto-generate `cluster-<6hex>` via
 *      `generateClusterName` and persist. The 6-hex suffix gives ~16M
 *      values per org; same-org collisions are caught by Platform's
 *      UNIQUE constraint and handled by the existing auth-error path.
 *
 * Once a row exists, subsequent env-var changes are ignored — the CLI
 * is the canonical mutation path. This matches the design constraint
 * that operators have one obvious place to rename a cluster.
 */
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import {
  clusterNameSchema,
  generateClusterName,
  type ClusterName,
} from '@kici-dev/engine/protocol/cluster-name';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'cluster-name' });

const CLUSTER_META_KEY = 'cluster_name';

/**
 * Source attribution for the resolved cluster name. Useful for operator
 * tooling (`kici-admin cluster-name get`) to explain where the current
 * value came from.
 */
export type ClusterNameSource = 'stored' | 'env-seeded' | 'auto-generated';

export interface ResolveResult {
  clusterName: ClusterName;
  source: ClusterNameSource;
}

/**
 * Read the cluster name from `cluster_meta`. Returns null if no row
 * exists yet (orch has never resolved its name).
 */
export async function readClusterName(db: Kysely<Database>): Promise<ClusterName | null> {
  const row = await db
    .selectFrom('cluster_meta')
    .select(['value'])
    .where('key', '=', CLUSTER_META_KEY)
    .executeTakeFirst();
  if (!row) return null;
  return clusterNameSchema.parse(row.value);
}

/**
 * Look up the cluster name. Throws if no row exists — callers that hit
 * this before the boot resolver has run should be considered bugs.
 */
export async function getClusterName(db: Kysely<Database>): Promise<ClusterName> {
  const name = await readClusterName(db);
  if (name === null) {
    throw new Error(
      'cluster_name not found in cluster_meta. resolveAndPersistClusterName must run during boot.',
    );
  }
  return name;
}

/**
 * Persist a validated cluster name. Upsert semantics: replaces the
 * existing row if one exists. Called by both the boot resolver and the
 * kici-admin CLI's `cluster-name set`.
 */
export async function setClusterName(db: Kysely<Database>, name: string): Promise<ClusterName> {
  const validated = clusterNameSchema.parse(name);
  await db
    .insertInto('cluster_meta')
    .values({ key: CLUSTER_META_KEY, value: validated })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: validated }))
    .execute();
  return validated;
}

/**
 * Boot-time resolution: returns the existing row, seeds from env, or
 * auto-generates. Idempotent: a re-run after first boot just returns
 * the stored value.
 *
 * `randomSource` is dependency-injected so tests can drive deterministic
 * suffixes; production callers pass `node:crypto.randomBytes`.
 */
export async function resolveAndPersistClusterName(
  db: Kysely<Database>,
  env: NodeJS.ProcessEnv = process.env,
  randomSource: (size: number) => Uint8Array = randomBytes,
): Promise<ResolveResult> {
  const existing = await readClusterName(db);
  if (existing !== null) {
    return { clusterName: existing, source: 'stored' };
  }

  const envName = env.KICI_CLUSTER_NAME?.trim();
  if (envName) {
    const seeded = await setClusterName(db, envName);
    logger.info('Seeded cluster_name from KICI_CLUSTER_NAME env var', {
      clusterName: seeded,
    });
    return { clusterName: seeded, source: 'env-seeded' };
  }

  const generated = await setClusterName(db, generateClusterName(randomSource));
  logger.info('Auto-generated cluster_name on first boot', {
    clusterName: generated,
  });
  return { clusterName: generated, source: 'auto-generated' };
}
