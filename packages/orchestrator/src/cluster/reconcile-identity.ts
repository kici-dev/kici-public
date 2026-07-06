/**
 * Reconcile the orchestrator's cluster identity between the DB
 * (`cluster_meta.cluster_id`) and the durable S3 sentinel
 * (`<prefix>/.kici-cluster-id`).
 *
 * Used by `kici-admin cluster reconcile-identity` and the staging deploy's
 * pre-orchestrator-start self-heal step. Talks DB + S3 directly (never the
 * orchestrator HTTP admin API) so it works while the orchestrator process is
 * down — which is exactly when a "Cluster identity mismatch" boot failure needs
 * fixing. Default direction restores the DB FROM the durable sentinel (the
 * cross-restart / peer anchor); `sentinel-from-db` reverses it.
 */
import { createPool } from '@kici-dev/shared';
import type { IdempotentStep } from '@kici-dev/shared/idempotency';
import { clusterSentinelKey } from './cluster-identity.js';

export type ReconcileDirection = 'db-from-sentinel' | 'sentinel-from-db';

export interface ReconcileS3Config {
  bucket: string;
  /**
   * Optional storage prefix (mirrors `KICI_STORAGE_PREFIX`). The sentinel lives
   * at `<prefix>/.kici-cluster-id`; must match the prefix the orchestrator boots
   * with. When omitted, `clusterSentinelKey` resolves the bucket root — the same
   * as the orchestrator's `DEFAULT_CACHE_STORAGE_S3_PREFIX` (empty) default.
   */
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface IdentityDrift {
  dbClusterId: string | null;
  sentinelClusterId: string | null;
  direction: ReconcileDirection;
}

async function makeS3Client(s3: ReconcileS3Config) {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: s3.region ?? 'us-east-1',
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    ...(s3.forcePathStyle ? { forcePathStyle: true } : {}),
  });
}

async function readClusterIdFromDb(databaseUrl: string): Promise<string | null> {
  const pool = createPool(databaseUrl);
  try {
    const res = await pool.query<{ value: string }>(
      `SELECT value FROM cluster_meta WHERE key = 'cluster_id'`,
    );
    return res.rows[0]?.value ?? null;
  } finally {
    await pool.end();
  }
}

async function writeClusterIdToDb(databaseUrl: string, clusterId: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(`UPDATE cluster_meta SET value = $1 WHERE key = 'cluster_id'`, [clusterId]);
  } finally {
    await pool.end();
  }
}

async function readSentinel(s3: ReconcileS3Config): Promise<string | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await makeS3Client(s3);
  const key = clusterSentinelKey(s3.prefix);
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
    const body = await out.Body?.transformToString();
    return body?.trim() ?? null;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function writeSentinel(s3: ReconcileS3Config, clusterId: string): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await makeS3Client(s3);
  await client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: clusterSentinelKey(s3.prefix),
      Body: clusterId,
      ContentType: 'text/plain',
    }),
  );
}

/**
 * Indirection object for the DB + S3 reads/writes, so the unit test can stub
 * the I/O without an ESM partial-mock dance. `buildReconcileStep` calls every
 * reader/writer through this object; the test overrides its members directly.
 */
export const reconcileIo = {
  readClusterIdFromDb,
  writeClusterIdToDb,
  readSentinel,
  writeSentinel,
};

/**
 * Build the idempotent step that reconciles the cluster identity in the given
 * direction. `check()` returns drift when the two sides disagree (or null when
 * in sync); `apply()` performs the single write that brings them into
 * agreement. Run it through `runIdempotentStep` (`@kici-dev/core/idempotency`).
 */
export function buildReconcileStep(deps: {
  databaseUrl: string;
  s3: ReconcileS3Config;
  direction: ReconcileDirection;
}): IdempotentStep<IdentityDrift> {
  const { databaseUrl, s3, direction } = deps;
  return {
    name: `cluster reconcile-identity (${direction})`,
    check: async (): Promise<IdentityDrift | null> => {
      const dbClusterId = await reconcileIo.readClusterIdFromDb(databaseUrl);
      const sentinelClusterId = await reconcileIo.readSentinel(s3);
      if (dbClusterId === null) {
        throw new Error('cluster_meta.cluster_id is missing — run orchestrator migrations first.');
      }
      if (direction === 'db-from-sentinel') {
        if (sentinelClusterId === null) {
          throw new Error(
            'No S3 sentinel to restore the DB from. Use --adopt-db to write the sentinel from the DB instead.',
          );
        }
        if (dbClusterId === sentinelClusterId) return null;
      } else if (sentinelClusterId === dbClusterId) {
        return null;
      }
      return { dbClusterId, sentinelClusterId, direction };
    },
    summarize: (drift): string =>
      drift.direction === 'db-from-sentinel'
        ? `Rewrite DB cluster_id ${drift.dbClusterId} -> ${drift.sentinelClusterId} (from S3 sentinel s3://${s3.bucket}/${clusterSentinelKey(s3.prefix)}).`
        : `Rewrite S3 sentinel ${drift.sentinelClusterId ?? '(absent)'} -> ${drift.dbClusterId} (from DB cluster_meta.cluster_id).`,
    apply: async (drift): Promise<void> => {
      if (drift.direction === 'db-from-sentinel') {
        await reconcileIo.writeClusterIdToDb(databaseUrl, drift.sentinelClusterId!);
      } else {
        await reconcileIo.writeSentinel(s3, drift.dbClusterId!);
      }
    },
  };
}
