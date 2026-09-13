import { describe, expect, it } from 'vitest';
import { parseManifest, serializeManifest } from './manifest.js';
import type { ChunkManifest } from './types.js';

const SAMPLE: ChunkManifest = {
  schemaVersion: 1,
  db: 'platform',
  table: 'run_events',
  tenantId: 'kiciStg00001',
  partitionDate: '2026-04-24',
  rowCount: 12_450,
  byteCount: 8_234_112,
  gzipByteCount: 1_200_840,
  minTimestamp: '2026-04-24T00:00:00.000Z',
  maxTimestamp: '2026-04-24T23:59:59.000Z',
  minRowId: 1000,
  maxRowId: 2000,
  contentHash: 'a'.repeat(64),
  chunkId: 'abcdef0123456789',
  createdAt: '2026-05-01T12:00:00.000Z',
  archiverInstanceId: 'orch-1',
};

describe('manifest', () => {
  it('round-trips v1 (backfills bucket=forever, maxColdDays=forever)', () => {
    const serialized = serializeManifest(SAMPLE);
    const parsed = parseManifest(serialized);
    // V1 round-trip: parseManifest backfills the v2 cold-purge fields
    // with `'forever'` so the GC sweep can rely on them always being
    // present. The serialized form on disk omits them (compatible with
    // pre-Phase-2 chunks).
    expect(parsed).toEqual({ ...SAMPLE, bucket: 'forever', maxColdDays: 'forever' });
  });

  it('round-trips v2 (preserves bucket + maxColdDays)', () => {
    const v2: ChunkManifest = {
      ...SAMPLE,
      schemaVersion: 2,
      bucket: '180d',
      maxColdDays: 180,
    };
    const serialized = serializeManifest(v2);
    expect(parseManifest(serialized)).toEqual(v2);
  });

  it('round-trips v2 with maxColdDays=forever (mixed-action chunk)', () => {
    const v2: ChunkManifest = {
      ...SAMPLE,
      schemaVersion: 2,
      bucket: 'forever',
      maxColdDays: 'forever',
    };
    expect(parseManifest(serializeManifest(v2))).toEqual(v2);
  });

  it('produces stable key order (v1)', () => {
    const serialized = serializeManifest(SAMPLE);
    const keys = Object.keys(JSON.parse(serialized) as Record<string, unknown>);
    expect(keys).toEqual([
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
    ]);
  });

  it('produces stable key order (v2 — bucket + maxColdDays after archiverInstanceId)', () => {
    const v2: ChunkManifest = {
      ...SAMPLE,
      schemaVersion: 2,
      bucket: '30d',
      maxColdDays: 30,
    };
    const serialized = serializeManifest(v2);
    const keys = Object.keys(JSON.parse(serialized) as Record<string, unknown>);
    expect(keys).toEqual([
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
      'bucket',
      'maxColdDays',
    ]);
  });

  it('rejects unsupported schemaVersion (3+)', () => {
    const obj = JSON.parse(serializeManifest(SAMPLE)) as Record<string, unknown>;
    obj.schemaVersion = 3;
    expect(() => parseManifest(JSON.stringify(obj))).toThrow(/unsupported schemaVersion 3/);
  });

  it('rejects missing fields (v1)', () => {
    const obj = JSON.parse(serializeManifest(SAMPLE)) as Record<string, unknown>;
    delete obj.contentHash;
    expect(() => parseManifest(JSON.stringify(obj))).toThrow(/missing field contentHash/);
  });

  it('rejects v2 missing bucket', () => {
    const v2: ChunkManifest = {
      ...SAMPLE,
      schemaVersion: 2,
      bucket: '30d',
      maxColdDays: 30,
    };
    const obj = JSON.parse(serializeManifest(v2)) as Record<string, unknown>;
    delete obj.bucket;
    expect(() => parseManifest(JSON.stringify(obj))).toThrow(
      /schemaVersion=2 missing field bucket/,
    );
  });
});
