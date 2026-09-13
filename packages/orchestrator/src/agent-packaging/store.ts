import { createCacheStorage } from '../storage/index.js';
import type { CacheStorage } from '../storage/types.js';
import type { AppConfig } from '../config.js';
import type { AgentPackageDownloadStorage } from './download.js';

/**
 * Resolve the agent-package store the bring-up presign handler reads from.
 *
 * Defaults to the orchestrator's OWN cache bucket (`cacheStorage`) — never a
 * vendor CDN. An `s3://bucket[/prefix]` override (`KICI_AGENT_BINARY_SOURCE`)
 * points the presign at another bucket on the SAME S3 endpoint (the customer
 * supply-chain mirror); the config schema already rejects an http(s) source so
 * no external HTTP default can slip in. Returns undefined when no cache storage
 * is configured and no override is set (the presign RPC then refuses loudly).
 */
export function resolveAgentPackageStore(
  config: AppConfig,
  cacheStorage: CacheStorage | undefined,
): AgentPackageDownloadStorage | undefined {
  const override = config.agentBinarySource;
  if (!override) return cacheStorage;

  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(override);
  if (!match) {
    throw new Error(
      `KICI_AGENT_BINARY_SOURCE must be an s3://bucket[/prefix] mirror (got "${override}")`,
    );
  }
  if (config.storage?.type !== 's3') {
    throw new Error(
      'KICI_AGENT_BINARY_SOURCE s3:// override requires an S3 cache backend (set KICI_STORAGE_*)',
    );
  }
  const [, bucket, prefix] = match;
  return createCacheStorage({
    type: 's3',
    bucket,
    prefix: prefix ?? '',
    ttlMs: config.cacheTtlDays * 86_400_000,
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    externalEndpoint: config.storage.externalEndpoint,
    uploadEndpoint: config.storage.uploadEndpoint,
    forcePathStyle: config.storage.forcePathStyle,
  });
}
