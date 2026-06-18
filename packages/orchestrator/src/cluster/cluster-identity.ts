/**
 * Cluster identity validation for split-brain prevention.
 *
 * In geo-distributed setups, orchestrators may use different connection strings
 * for the same logical DB and S3. URL comparison would falsely flag them as
 * different resources. cluster_id validates that orchestrators share the same
 * logical DB, and the S3 sentinel validates they share the same logical bucket.
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
   * Optional storage prefix (mirrors `KICI_STORAGE_PREFIX`). When set, the
   * sentinel lives under that prefix (`<prefix>/.kici-cluster-id`) so multiple
   * clusters can share the same physical bucket as long as they use distinct
   * prefixes. When empty, the sentinel is at the bucket root.
   */
  storagePrefix?: string;
  /**
   * E2E escape hatch — when true, validateS3Sentinel logs a warning and
   * returns early. Mirrors the orchestrator's
   * `config.skipS3SentinelValidation` (KICI_SKIP_S3_SENTINEL_VALIDATION).
   */
  skipSentinelValidation?: boolean;
}

/**
 * Build the S3 key for the cluster identity sentinel under an optional prefix.
 * Strips any trailing slash from the prefix so callers can pass either form.
 */
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
   * Validate S3 sentinel file matches DB cluster_id.
   * - If no S3 configured, skip (filesystem-only deployment).
   * - If sentinel doesn't exist, write it (first orch to use this bucket).
   * - If sentinel exists and matches, success.
   * - If sentinel exists and doesn't match, throw error (different DB/bucket mismatch).
   */
  async validateS3Sentinel(): Promise<void> {
    if (!this.deps.s3Client || !this.deps.storageBucket) {
      logger.debug('S3 not configured, skipping sentinel validation');
      return;
    }

    // Escape hatch for E2E fault-injection tests that deliberately boot the
    // orchestrator with broken S3 credentials to exercise cache-failure paths.
    // Without this, validateS3Sentinel's getObject would reject the startup
    // and the orchestrator would never come up for the test to drive.
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
   * Validate cluster identity at startup.
   * Logs cluster_id and instance_id for operational visibility, then runs
   * S3 sentinel check. Throws on misconfiguration (e.g., different cluster
   * using same DB/S3).
   */
  async validateAtStartup(instanceId: string): Promise<string> {
    const clusterId = await this.getClusterId();
    logger.info('Cluster identity validated', { clusterId, instanceId });
    await this.validateS3Sentinel();
    return clusterId;
  }
}
