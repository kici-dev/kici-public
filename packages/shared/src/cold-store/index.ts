/**
 * Cold-store framework — public surface for @kici-dev/shared consumers.
 *
 * Multiple implementations extend `BaseColdStore` with their own
 * DB-specific adapters. Phase A ships framework types + the abstract
 * class with a no-op archive cycle; Phase B+ adds concrete
 * `TableAdapter` implementations.
 */
export {
  chunkObjectKey,
  encodeKeySegment,
  tablePrefix,
  tenantDayBucketPrefix,
  tenantDayPrefix,
  type DbKind,
} from './key.js';
export {
  COLD_BUCKET_NAMES,
  coldDaysToBucket,
  isLongerColdRetention,
  type ColdBucketName,
} from './bucket.js';
export {
  BaseColdStore,
  type BaseColdStoreDeps,
  type ColdStore,
  type ColdStoreFetchRangeArgs,
  type ColdStoreReplayChunkArgs,
  type ColdStoreReplayResult,
  type ColdStoreReplayRowArgs,
  type PurgeableChunk,
  type PurgeChunkResult,
  type PurgeExpiredChunksOpts,
  type PurgeExpiredChunksSummary,
} from './cold-store.js';
export { ChunkLru, type ChunkLruOptions } from './lru.js';
export { computeChunkId } from './chunk-id.js';
export {
  decodeChunk,
  encodeChunk,
  type DecodeChunkArgs,
  type EncodeChunkArgs,
  type EncodedChunk,
} from './chunk-encoder.js';
export { parseManifest, serializeManifest } from './manifest.js';
export {
  DEFAULT_TABLE_CONFIG,
  resolveTableConfig,
  type ColdStoreConfig,
  type ColdStoreTableConfig,
} from './config.js';
export {
  coldStoreArchiveBytesTotal,
  coldStoreArchiveCyclesTotal,
  coldStoreArchiveDurationSeconds,
  coldStoreArchiveRowsTotal,
  coldStorePurgeBytesTotal,
  coldStorePurgeChunksTotal,
  coldStorePurgeDurationSeconds,
  coldStoreRehydrateBytesTotal,
  coldStoreRehydrateDurationSeconds,
  coldStoreRehydrateRequestsTotal,
  coldStoreReplayDurationSeconds,
  coldStoreReplayRowsTotal,
  coldStoreVerifyFailuresTotal,
} from './metrics.js';
export {
  type ChunkCommitMetadata,
  type EligiblePartition,
  type TableAdapter,
} from './table-adapter.js';
export { type ArchiveCycleSummary, type ChunkManifest, type ColdRetention } from './types.js';
