/**
 * A manifest is a JSON sidecar next to each `.jsonl.gz` chunk, serialized in a
 * stable key order so byte-diffs across archive runs are meaningful.
 */
import type { ChunkManifest } from './types.js';

/** Required in v1 and v2. The order is the on-disk key order: keep it stable. */
const COMMON_REQUIRED_KEYS: ReadonlyArray<keyof ChunkManifest> = [
  'schemaVersion',
  'db',
  'table',
  'tenantId',
  'partitionDate',
  'rowCount',
  'byteCount',
  'gzipByteCount',
  'minTimestamp',
  'maxTimestamp',
  'minRowId',
  'maxRowId',
  'contentHash',
  'chunkId',
  'createdAt',
  'archiverInstanceId',
];

/** Required in v2 only. */
const V2_REQUIRED_KEYS: ReadonlyArray<keyof ChunkManifest> = ['bucket', 'maxColdDays'];

const OPTIONAL_MANIFEST_KEYS: ReadonlyArray<keyof ChunkManifest> = ['replayLookupKeys'];

export function serializeManifest(m: ChunkManifest): string {
  const ordered: Record<string, unknown> = {};
  for (const k of COMMON_REQUIRED_KEYS) {
    ordered[k] = m[k];
  }
  if (m.schemaVersion === 2) {
    for (const k of V2_REQUIRED_KEYS) {
      if (m[k] === undefined) {
        throw new Error(`serializeManifest: schemaVersion=2 requires field "${k}"`);
      }
      ordered[k] = m[k];
    }
  }
  for (const k of OPTIONAL_MANIFEST_KEYS) {
    if (m[k] !== undefined) ordered[k] = m[k];
  }
  return JSON.stringify(ordered, null, 2);
}

export function parseManifest(raw: string | Buffer): ChunkManifest {
  const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parseManifest: not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) {
    throw new Error(`parseManifest: unsupported schemaVersion ${String(obj.schemaVersion)}`);
  }
  for (const k of COMMON_REQUIRED_KEYS) {
    if (!(k in obj)) {
      throw new Error(`parseManifest: missing field ${k}`);
    }
  }
  if (obj.schemaVersion === 2) {
    for (const k of V2_REQUIRED_KEYS) {
      if (!(k in obj)) {
        throw new Error(`parseManifest: schemaVersion=2 missing field ${k}`);
      }
    }
  } else {
    // v1: backfill the cold-purge fields so the GC sweep never purges a v1
    // chunk. The bucket-prefix migration is forwards-only: v1 chunks stay at
    // the day-prefix root indefinitely.
    if (obj.bucket === undefined) obj.bucket = 'forever';
    if (obj.maxColdDays === undefined) obj.maxColdDays = 'forever';
  }
  return obj as unknown as ChunkManifest;
}
