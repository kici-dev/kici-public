import { describe, expect, it } from 'vitest';
import {
  chunkObjectKey,
  encodeKeySegment,
  tablePrefix,
  tenantDayBucketPrefix,
  tenantDayPrefix,
} from './key.js';

describe('encodeKeySegment', () => {
  // Behavior-lock fixtures. These keys have been written to production
  // object stores since the original event-log implementation; any
  // change to the encoding would render previously-written keys
  // unreachable. Do NOT edit these outputs without a migration plan.
  const FIXTURES: ReadonlyArray<{ input: string; expected: string }> = [
    { input: 'plain-alphanumeric_123', expected: 'plain-alphanumeric_123' },
    { input: 'a.b.c', expected: 'a.b.c' },
    { input: 'kici:stg:00001', expected: 'kici:stg:00001' },
    { input: 'hello world', expected: 'hello_20world' },
    { input: 'a/b/c', expected: 'a_2fb_2fc' },
    { input: '', expected: '' },
    { input: 'unicode-äöü', expected: 'unicode-_e4_f6_fc' },
    { input: 'tabs\tnewlines\n', expected: 'tabs_9newlines_a' },
    { input: 'plus+and=ampersand&', expected: 'plus_2band_3dampersand_26' },
  ];

  it.each(FIXTURES)('encodes $input deterministically', ({ input, expected }) => {
    expect(encodeKeySegment(input)).toBe(expected);
  });

  it('is idempotent only on already-safe inputs', () => {
    expect(encodeKeySegment('safe._:-')).toBe('safe._:-');
  });
});

describe('tablePrefix', () => {
  it('composes db and table under the prefix', () => {
    expect(tablePrefix({ prefix: 'cold-store', db: 'platform', table: 'run_events' })).toBe(
      'cold-store/platform/run_events',
    );
  });

  it('strips trailing slashes from the prefix', () => {
    expect(
      tablePrefix({ prefix: 'cold-store/', db: 'orchestrator', table: 'execution_runs' }),
    ).toBe('cold-store/orchestrator/execution_runs');
  });
});

describe('tenantDayPrefix', () => {
  it('encodes the tenant id and splits the date', () => {
    expect(
      tenantDayPrefix({
        prefix: 'cold-store',
        db: 'platform',
        table: 'run_events',
        tenantId: 'kici/stg',
        partitionDate: '2026-04-24',
      }),
    ).toBe('cold-store/platform/run_events/kici_2fstg/2026/04/24');
  });

  it('rejects non-YYYY-MM-DD partition dates', () => {
    expect(() =>
      tenantDayPrefix({
        prefix: 'cold-store',
        db: 'platform',
        table: 'run_events',
        tenantId: 'x',
        partitionDate: '2026/04/24',
      }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('chunkObjectKey', () => {
  it('appends .jsonl.gz for data chunks', () => {
    expect(
      chunkObjectKey({
        prefix: 'cold-store',
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        partitionDate: '2026-04-24',
        chunkId: 'abcdef0123456789',
        kind: 'data',
      }),
    ).toBe('cold-store/platform/run_events/org1/2026/04/24/abcdef0123456789.jsonl.gz');
  });

  it('appends .manifest.json for manifests', () => {
    expect(
      chunkObjectKey({
        prefix: 'cold-store',
        db: 'orchestrator',
        table: 'execution_jobs',
        tenantId: 'rk1',
        partitionDate: '2026-04-24',
        chunkId: 'abcdef0123456789',
        kind: 'manifest',
      }),
    ).toBe('cold-store/orchestrator/execution_jobs/rk1/2026/04/24/abcdef0123456789.manifest.json');
  });

  it('inserts the bucket segment when bucket is provided (Phase 2 v2 chunks)', () => {
    expect(
      chunkObjectKey({
        prefix: 'cold-store',
        db: 'orchestrator',
        table: 'access_log',
        tenantId: 'kiciStg00001',
        partitionDate: '2026-04-24',
        chunkId: 'abcdef0123456789',
        kind: 'data',
        bucket: '180d',
      }),
    ).toBe(
      'cold-store/orchestrator/access_log/kiciStg00001/2026/04/24/180d/abcdef0123456789.jsonl.gz',
    );
  });

  it('legacy v1 keys (no bucket) live at the day-prefix root for backward compatibility', () => {
    // Pre-Phase-2 chunks omit the bucket segment. The framework still
    // reads them via listRelevantManifests (recursive LIST under the
    // tenant prefix) and treats them as `'forever'` for the GC sweep.
    expect(
      chunkObjectKey({
        prefix: 'cold-store',
        db: 'orchestrator',
        table: 'access_log',
        tenantId: 'kiciStg00001',
        partitionDate: '2026-04-24',
        chunkId: 'abcdef0123456789',
        kind: 'data',
      }),
    ).toBe('cold-store/orchestrator/access_log/kiciStg00001/2026/04/24/abcdef0123456789.jsonl.gz');
  });
});

describe('tenantDayBucketPrefix', () => {
  it('appends the bucket segment under the day directory', () => {
    expect(
      tenantDayBucketPrefix({
        prefix: 'cold-store',
        db: 'orchestrator',
        table: 'access_log',
        tenantId: 'kiciStg00001',
        partitionDate: '2026-04-24',
        bucket: '30d',
      }),
    ).toBe('cold-store/orchestrator/access_log/kiciStg00001/2026/04/24/30d');
  });

  it('rejects buckets with path-unsafe characters', () => {
    for (const bad of ['30d/', '../etc', 'with space', '30.5d', '1y!']) {
      expect(() =>
        tenantDayBucketPrefix({
          prefix: 'cold-store',
          db: 'platform',
          table: 'audit_log',
          tenantId: 'org1',
          partitionDate: '2026-04-24',
          bucket: bad,
        }),
      ).toThrow(/bucket must match/);
    }
  });
});
