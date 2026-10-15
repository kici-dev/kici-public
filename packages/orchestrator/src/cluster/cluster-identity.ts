/**
 * Cluster identity validation for split-brain prevention.
 *
 * Geo-distributed orchestrators may use different connection strings for the same
 * logical DB and S3, so URL comparison would give false mismatches. cluster_id
 * proves a shared logical DB; the S3 sentinel proves a shared logical bucket.
 */

import { createLogger } from '@kici-dev/shared';
import type { Kysely } from 'kysely';

const logger = createLogger({ prefix: 'cluster-identity' });

interface ClusterIdentityS3Client {
  getObject(bucket: string, key: string): Promise<string | null>;
  putObject(bucket: string, key: string, body: string): Promise<void>;
}

export interface ClusterIdentityDeps {
  db: Kysely<any>;
  s3Client?: ClusterIdentityS3Client;
  storageBucket?: string;
  /**
   * Mirrors `KICI_STORAGE_PREFIX`. When set, the sentinel is
   * `<prefix>/.kici-cluster-id`, so clusters with distinct prefixes can share one
   * bucket; when empty, it is at the bucket root.
   */
  storagePrefix?: string;
  /**
   * Test-only: validateS3Sentinel warns and returns early. Only the build-time test
   * double's fault-injection policy sets it; the shipped orchestrator always validates.
   */
  skipSentinelValidation?: boolean;
}

/**
 * Mirrors the orchestrator config `cacheStorageS3Prefix` default. Empty puts the
 * cache blobs and the sentinel at the bucket root — the bucket already scopes the
 * cluster. Every sentinel-prefix resolver (the orchestrator runtime and
 * `kici-admin cluster reconcile-identity`, including a deploy's pre-start self-heal
 * run) MUST fall back to THIS value when no prefix is set; divergent sentinel keys
 * crash-loop the boot on a spurious "Cluster identity mismatch".
 */
export const DEFAULT_CACHE_STORAGE_S3_PREFIX = '';

/** Sentinel S3 key; a trailing slash on the prefix is stripped, so either form works. */
export function clusterSentinelKey(prefix?: string): string {
  if (!prefix) return '.kici-cluster-id';
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed.length === 0 ? '.kici-cluster-id' : `${trimmed}/.kici-cluster-id`;
}

export class ClusterIdentity {
  constructor(private readonly deps: ClusterIdentityDeps) {}

  /** Read cluster_id from DB. Throws if not found (migration not run). */
  async getClusterId(): Promise<string> {
    const row = await this.deps.db
      .selectFrom('cluster_meta' as any)
      .select(['value'])
      .where('key', '=', 'cluster_id')
      .executeTakeFirst();
    if (!row) {
      throw new Error('cluster_id not found in cluster_meta table. Run migrations first.');
    }
    return (row as any).value;
  }

  /**
   * Check the S3 sentinel against the DB cluster_id: skip without S3
   * (filesystem-only), write it when absent (first orchestrator on this bucket),
   * throw on mismatch (different DB/bucket).
   */
  async validateS3Sentinel(): Promise<void> {
    if (!this.deps.s3Client || !this.deps.storageBucket) {
      logger.debug('S3 not configured, skipping sentinel validation');
      return;
    }

    // Fault-injection tests boot with broken S3 credentials; without this, getObject
    // rejects startup and the orchestrator never comes up for the test to drive.
    if (this.deps.skipSentinelValidation) {
      logger.warn('Skipping S3 sentinel validation (KICI_SKIP_S3_SENTINEL_VALIDATION=true)');
      return;
    }

    const clusterId = await this.getClusterId();
    const sentinelKey = clusterSentinelKey(this.deps.storagePrefix);

    const existing = await this.deps.s3Client.getObject(this.deps.storageBucket, sentinelKey);
    if (existing === null) {
      // First orchestrator using this bucket+prefix -- write sentinel
      await this.deps.s3Client.putObject(this.deps.storageBucket, sentinelKey, clusterId);
      logger.info('Wrote cluster identity sentinel to S3', {
        clusterId,
        bucket: this.deps.storageBucket,
        sentinelKey,
      });
      return;
    }

    if (existing.trim() !== clusterId) {
      throw new Error(
        `Cluster identity mismatch: this orchestrator's database does not match the target pool. ` +
          `DB cluster_id=${clusterId}, S3 sentinel=${existing.trim()} (s3://${this.deps.storageBucket}/${sentinelKey}). ` +
          `Verify database connection configuration, or set KICI_STORAGE_PREFIX to isolate this cluster's sentinel.`,
      );
    }

    logger.debug('S3 sentinel matches cluster_id', { clusterId, sentinelKey });
  }

  /**
   * Logs cluster_id and instance_id, then runs the S3 sentinel check. Throws on
   * misconfiguration (e.g., a different cluster using the same DB/S3).
   */
  async validateAtStartup(instanceId: string): Promise<string> {
    const clusterId = await this.getClusterId();
    logger.info('Cluster identity validated', { clusterId, instanceId });
    await this.validateS3Sentinel();
    return clusterId;
  }
}
