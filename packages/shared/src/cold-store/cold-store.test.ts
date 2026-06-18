import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { BaseColdStore, type BaseColdStoreDeps } from './cold-store.js';
import type { ColdStoreConfig } from './config.js';
import { ChunkLru } from './lru.js';
import type { ChunkCommitMetadata, TableAdapter } from './table-adapter.js';

class TestColdStore extends BaseColdStore {
  constructor(deps: BaseColdStoreDeps) {
    super(deps);
  }
  registerAdapterForTests(adapter: TableAdapter<unknown>): void {
    this.registerAdapter(adapter);
  }
}

function makeConfig(enabled: boolean): ColdStoreConfig {
  return {
    enabled,
    s3Concurrency: 4,
    tables: {},
    storage: { bucket: 'test-bucket', prefix: 'cold-store/' },
  };
}

interface TestRow {
  id: number;
  org_id: string;
  created_at: string;
  payload: string;
}

function makeTestAdapter(opts?: {
  minChunkBytes?: number;
  minWarmTenantBytes?: number;
  warmTtlDays?: number;
  rows?: TestRow[];
  warmBytes?: number;
  eligiblePartitions?: Array<{ tenantId: string; partitionDate: string }>;
  markArchivedAndDelete?: Mock;
  withPartitionLock?: 'acquire' | 'skip';
}) {
  const rows = opts?.rows ?? [
    { id: 1, org_id: 'org1', created_at: '2026-04-16T00:00:00.000Z', payload: 'a' },
    { id: 2, org_id: 'org1', created_at: '2026-04-16T00:01:00.000Z', payload: 'b' },
  ];
  const markArchivedAndDelete = opts?.markArchivedAndDelete ?? vi.fn(async () => undefined);
  const withLock = opts?.withPartitionLock ?? 'acquire';
  const adapter: TableAdapter<TestRow> = {
    db: 'platform',
    table: 'run_events',
    tenantColumn: 'org_id',
    partitionColumn: 'created_at',
    config: {
      warmTtlDays: opts?.warmTtlDays ?? 7,
      minWarmTenantBytes: opts?.minWarmTenantBytes ?? 0,
      minChunkBytes: opts?.minChunkBytes ?? 0,
      maxChunkBytes: 10 * 1024 * 1024,
      maxRowsPerCycle: 10_000,
      enabled: true,
    },
    listEligiblePartitions: async function* () {
      for (const p of opts?.eligiblePartitions ?? [
        { tenantId: 'org1', partitionDate: '2026-04-16' },
      ]) {
        yield p;
      }
    },
    countTenantWarmBytes: async () => opts?.warmBytes ?? 10 * 1024 * 1024,
    withPartitionLock: async (_args, fn) => {
      if (withLock === 'skip') return null;
      return fn();
    },
    selectEligible: async function* () {
      for (const r of rows) yield r;
    },
    encodeRow: (r) => JSON.stringify(r),
    decodeRow: (line) => JSON.parse(line) as TestRow,
    rowId: (r) => r.id,
    rowTimestamp: (r) => r.created_at,
    markArchivedAndDelete,
  };
  return { adapter, markArchivedAndDelete };
}

/** Build a tiny in-memory S3 mock. */
function makeMockS3() {
  const objects = new Map<string, { body: Buffer; metadata?: Record<string, string> }>();
  const sends: Array<{ name: string; input: any }> = [];

  const client = {
    send: vi.fn(async (cmd: any) => {
      sends.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body;
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as any);
        objects.set(cmd.input.Key!, { body: buf, metadata: cmd.input.Metadata });
        return { ETag: '"abc"' };
      }
      if (cmd instanceof HeadObjectCommand) {
        const entry = objects.get(cmd.input.Key!);
        if (!entry) {
          const err = new Error('NotFound') as any;
          err.name = 'NotFound';
          throw err;
        }
        return { Metadata: entry.metadata ?? {} };
      }
      if (cmd instanceof GetObjectCommand) {
        const entry = objects.get(cmd.input.Key!);
        if (!entry) {
          const err = new Error('NoSuchKey') as any;
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(entry.body),
          },
        };
      }
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? '';
        const keys = Array.from(objects.keys())
          .filter((k) => k.startsWith(prefix))
          .sort();
        return {
          Contents: keys.map((k) => ({ Key: k })),
          IsTruncated: false,
        };
      }
      throw new Error(`unexpected command: ${cmd.constructor.name}`);
    }),
  };
  return { client: client as any, objects, sends };
}

describe('BaseColdStore', () => {
  it('reports skipped=no_tables when no adapters are registered', async () => {
    const log = vi.fn();
    const mock = makeMockS3();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'test-1',
      log,
      config: makeConfig(true),
      s3Client: mock.client,
    });

    const summary = await store.runArchiveCycle();
    expect(summary.skipped.no_tables).toBe(1);
    expect(summary.tablesProcessed).toBe(0);
  });

  it('reports skipped=disabled when config.enabled is false', async () => {
    const log = vi.fn();
    const mock = makeMockS3();
    const store = new TestColdStore({
      db: 'orchestrator',
      instanceId: 'orch-1',
      log,
      config: makeConfig(false),
      s3Client: mock.client,
    });

    const summary = await store.runArchiveCycle();
    expect(summary.skipped.disabled).toBe(1);
    expect(summary.skipped.no_tables).toBe(0);
  });

  it('archives a partition end-to-end: PUT data, verify, PUT manifest, markArchivedAndDelete', async () => {
    const mock = makeMockS3();
    const { adapter, markArchivedAndDelete } = makeTestAdapter();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'archiver-1',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.chunksWritten).toBe(1);
    expect(summary.rowsArchived).toBe(2);
    expect(summary.rowsFailed).toBe(0);

    // Sequence of S3 ops: PUT data, HEAD verify, PUT manifest.
    const ops = mock.sends.map((s) => s.name);
    expect(ops).toEqual([
      'PutObjectCommand', // data
      'HeadObjectCommand', // verify
      'PutObjectCommand', // manifest
    ]);

    // The data + manifest keys are distinct.
    const keys = mock.sends
      .filter((s) => s.name === 'PutObjectCommand')
      .map((s) => s.input.Key as string);
    expect(keys[0]).toMatch(/\/run_events\/org1\/2026\/04\/16\/[a-f0-9]{16}\.jsonl\.gz$/);
    expect(keys[1]).toMatch(/\/run_events\/org1\/2026\/04\/16\/[a-f0-9]{16}\.manifest\.json$/);

    // markArchivedAndDelete received the exact row IDs that were encoded.
    expect(markArchivedAndDelete).toHaveBeenCalledTimes(1);
    const call = markArchivedAndDelete.mock.calls[0][0] as {
      rowIds: number[];
      chunkMeta: ChunkCommitMetadata;
    };
    expect(call.rowIds).toEqual([1, 2]);
    expect(call.chunkMeta.rowCount).toBe(2);
    expect(call.chunkMeta.tenantId).toBe('org1');
    expect(call.chunkMeta.partitionDate).toBe('2026-04-16');
    expect(call.chunkMeta.chunkId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('skips a partition when the encoded chunk is smaller than minChunkBytes', async () => {
    const mock = makeMockS3();
    const { adapter, markArchivedAndDelete } = makeTestAdapter({
      minChunkBytes: 10 * 1024 * 1024, // 10 MB floor; encoded tiny chunk falls below
    });
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.chunksWritten).toBe(0);
    expect(summary.skipped.min_chunk).toBe(1);
    expect(markArchivedAndDelete).not.toHaveBeenCalled();
    // No S3 PUTs should have happened.
    expect(mock.sends.filter((s) => s.name === 'PutObjectCommand')).toHaveLength(0);
  });

  it('skips a tenant below minWarmTenantBytes without touching the partition lock', async () => {
    const mock = makeMockS3();
    const { adapter, markArchivedAndDelete } = makeTestAdapter({
      minWarmTenantBytes: 100 * 1024 * 1024,
      warmBytes: 1024, // 1 KB vs 100 MB floor
    });
    const withLockSpy = vi.spyOn(adapter, 'withPartitionLock');
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.skipped.min_warm).toBe(1);
    expect(withLockSpy).not.toHaveBeenCalled();
    expect(markArchivedAndDelete).not.toHaveBeenCalled();
  });

  it('skips a partition when another replica holds the lock', async () => {
    const mock = makeMockS3();
    const { adapter, markArchivedAndDelete } = makeTestAdapter({ withPartitionLock: 'skip' });
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.chunksWritten).toBe(0);
    expect(markArchivedAndDelete).not.toHaveBeenCalled();
    // No S3 ops expected since we never entered the critical section.
    expect(mock.sends).toHaveLength(0);
  });

  it('retries verify on content-hash mismatch then fails after 3 attempts', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    // Override HeadObject to return a wrong hash.
    mock.client.send.mockImplementation(async (cmd: any) => {
      if (cmd instanceof PutObjectCommand) {
        return { ETag: '"abc"' };
      }
      if (cmd instanceof HeadObjectCommand) {
        return { Metadata: { 'content-hash': 'bogus' } };
      }
      throw new Error('unexpected');
    });
    const log = vi.fn();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log,
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.rowsFailed).toBe(2);
    expect(summary.chunksWritten).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'error',
      'cold-store chunk archive failed',
      expect.objectContaining({ table: 'run_events' }),
    );
  });

  it('fetchRange yields only rows whose partition-column falls in [fromTs, toTs)', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter({
      rows: [
        { id: 1, org_id: 'org1', created_at: '2026-04-16T10:00:00.000Z', payload: 'a' },
        { id: 2, org_id: 'org1', created_at: '2026-04-16T11:00:00.000Z', payload: 'b' },
        { id: 3, org_id: 'org1', created_at: '2026-04-16T12:00:00.000Z', payload: 'c' },
      ],
    });
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 10 * 1024 * 1024,
      sizeOf: (v) => v.length,
    });
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
      chunkCache: lru,
    });
    store.registerAdapterForTests(adapter);

    // First archive the partition so manifest + data exist in mock S3.
    await store.runArchiveCycle();

    const out: TestRow[] = [];
    for await (const row of store.fetchRange<TestRow>({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      fromTs: new Date('2026-04-16T10:30:00.000Z'),
      toTs: new Date('2026-04-16T11:30:00.000Z'),
    })) {
      out.push(row);
    }
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('hasRange returns true when a chunk overlaps and false otherwise', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();

    await expect(
      store.hasRange({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        fromTs: new Date('2026-04-16T00:00:00.000Z'),
        toTs: new Date('2026-04-17T00:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    await expect(
      store.hasRange({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        fromTs: new Date('2026-05-01T00:00:00.000Z'),
        toTs: new Date('2026-05-02T00:00:00.000Z'),
      }),
    ).resolves.toBe(false);
  });

  it('countRange sums manifest rowCount across overlapping chunks', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();

    await expect(
      store.countRange({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        fromTs: new Date('2026-04-16T00:00:00.000Z'),
        toTs: new Date('2026-04-17T00:00:00.000Z'),
      }),
    ).resolves.toBe(2);
  });

  it('LRU cache short-circuits the second fetch for the same chunk', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    const lru = new ChunkLru<string, Buffer>({
      maxBytes: 10 * 1024 * 1024,
      sizeOf: (v) => v.length,
    });
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'a',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
      chunkCache: lru,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();

    const range = {
      db: 'platform' as const,
      table: 'run_events',
      tenantId: 'org1',
      fromTs: new Date('2026-04-16T00:00:00.000Z'),
      toTs: new Date('2026-04-17T00:00:00.000Z'),
    };
    const first: TestRow[] = [];
    for await (const r of store.fetchRange<TestRow>(range)) first.push(r);
    const getsAfterFirst = mock.sends.filter(
      (s) => s.name === 'GetObjectCommand' && (s.input.Key as string).endsWith('.jsonl.gz'),
    ).length;

    const second: TestRow[] = [];
    for await (const r of store.fetchRange<TestRow>(range)) second.push(r);
    const getsAfterSecond = mock.sends.filter(
      (s) => s.name === 'GetObjectCommand' && (s.input.Key as string).endsWith('.jsonl.gz'),
    ).length;

    // Second fetch hits the LRU; only manifest GETs happen, no chunk GET.
    expect(first).toEqual(second);
    expect(getsAfterSecond).toBe(getsAfterFirst);
  });

  // ── Phase F: replayChunk / replayRow ────────────────────────────────

  it('replayChunk: passes decoded rows to adapter.replayInsert and returns counts', async () => {
    const mock = makeMockS3();
    const replayInsert = vi.fn(async () => ({ inserted: 2, skipped: 0 }));
    const { adapter } = makeTestAdapter();
    (adapter as unknown as { replayInsert: typeof replayInsert }).replayInsert = replayInsert;
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'archiver-replay',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    // Archive a partition first so a real chunk lands in S3.
    await store.runArchiveCycle();
    const dataKey = Array.from(mock.objects.keys()).find((k) => k.endsWith('.jsonl.gz'))!;
    const chunkId = dataKey.split('/').pop()!.replace('.jsonl.gz', '');

    const result = await store.replayChunk({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      partitionDate: '2026-04-16',
      chunkId,
    });

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.chunkId).toBe(chunkId);

    expect(replayInsert).toHaveBeenCalledTimes(1);
    const calls = replayInsert.mock.calls as unknown as Array<
      [{ rows: TestRow[]; chunkMeta: ChunkCommitMetadata }]
    >;
    const call = calls[0][0];
    expect(call.rows).toHaveLength(2);
    expect(call.rows[0].id).toBe(1);
    expect(call.rows[1].id).toBe(2);
    expect(call.chunkMeta.chunkId).toBe(chunkId);
    expect(call.chunkMeta.tenantId).toBe('org1');
  });

  it('replayChunk: throws when adapter has no replayInsert', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    // No replayInsert assigned → method-not-supported path.
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-no-impl',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    await expect(
      store.replayChunk({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        partitionDate: '2026-04-16',
        chunkId: 'deadbeef00000000',
      }),
    ).rejects.toThrow(/replay-into-pg not supported/);
  });

  it('replayChunk: refuses to replay on contentHash mismatch', async () => {
    const mock = makeMockS3();
    const replayInsert = vi.fn(async () => ({ inserted: 0, skipped: 0 }));
    const { adapter } = makeTestAdapter();
    (adapter as unknown as { replayInsert: typeof replayInsert }).replayInsert = replayInsert;
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-tamper',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();
    const dataKey = Array.from(mock.objects.keys()).find((k) => k.endsWith('.jsonl.gz'))!;
    const chunkId = dataKey.split('/').pop()!.replace('.jsonl.gz', '');

    // Tamper with the data file: replace the gzipped body with garbage so
    // sha256(data) no longer matches manifest.contentHash.
    mock.objects.get(dataKey)!.body = Buffer.from('not-the-real-chunk');

    await expect(
      store.replayChunk({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        partitionDate: '2026-04-16',
        chunkId,
      }),
    ).rejects.toThrow(/contentHash mismatch/);
    expect(replayInsert).not.toHaveBeenCalled();
  });

  it('replayChunk: idempotent — second pass reports inserted=0', async () => {
    const mock = makeMockS3();
    let firstPass = true;
    const replayInsert = vi.fn(async () => {
      if (firstPass) {
        firstPass = false;
        return { inserted: 2, skipped: 0 };
      }
      return { inserted: 0, skipped: 2 };
    });
    const { adapter } = makeTestAdapter();
    (adapter as unknown as { replayInsert: typeof replayInsert }).replayInsert = replayInsert;
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-idem',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();
    const dataKey = Array.from(mock.objects.keys()).find((k) => k.endsWith('.jsonl.gz'))!;
    const chunkId = dataKey.split('/').pop()!.replace('.jsonl.gz', '');

    const first = await store.replayChunk({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      partitionDate: '2026-04-16',
      chunkId,
    });
    const second = await store.replayChunk({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      partitionDate: '2026-04-16',
      chunkId,
    });
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('replayRow: locates the chunk via manifest minRowId/maxRowId bounds', async () => {
    const mock = makeMockS3();
    const replayInsert = vi.fn(async () => ({ inserted: 2, skipped: 0 }));
    const { adapter } = makeTestAdapter();
    (adapter as unknown as { replayInsert: typeof replayInsert }).replayInsert = replayInsert;
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-row',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);
    await store.runArchiveCycle();
    // Rows 1, 2 are in the chunk; ask for row 1 (in range) and row 99 (out).
    const inRange = await store.replayRow({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      rowId: 1,
    });
    expect(inRange.chunkId).not.toBeNull();
    expect(inRange.inserted).toBe(2);

    const outOfRange = await store.replayRow({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      rowId: 99,
    });
    expect(outOfRange.chunkId).toBeNull();
    expect(outOfRange.inserted).toBe(0);
  });

  it('replayChunk: short-circuits when cold-store is disabled', async () => {
    const mock = makeMockS3();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-disabled',
      log: vi.fn(),
      config: makeConfig(false),
      s3Client: mock.client,
    });
    await expect(
      store.replayChunk({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        partitionDate: '2026-04-16',
        chunkId: 'deadbeef00000000',
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('replayRow: returns null chunkId when cold-store is disabled', async () => {
    const mock = makeMockS3();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'rep-row-disabled',
      log: vi.fn(),
      config: makeConfig(false),
      s3Client: mock.client,
    });
    const result = await store.replayRow({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      rowId: 1,
    });
    expect(result.chunkId).toBeNull();
    expect(result.inserted).toBe(0);
  });

  // ── Phase 2: per-bucket chunk grouping ─────────────────────────────
  it('archives one chunk per bucket when adapter implements coldTtlDays', async () => {
    const mock = makeMockS3();
    const markArchivedAndDelete = vi.fn(async () => undefined);
    // Three rows spanning three different cold-bucket TTLs.
    type BucketRow = TestRow & { ttl: number | 'forever' };
    const rows: BucketRow[] = [
      {
        id: 1,
        org_id: 'org1',
        created_at: '2026-04-16T00:00:00.000Z',
        payload: 'a'.repeat(20),
        ttl: 30,
      },
      {
        id: 2,
        org_id: 'org1',
        created_at: '2026-04-16T00:01:00.000Z',
        payload: 'b'.repeat(20),
        ttl: 180,
      },
      {
        id: 3,
        org_id: 'org1',
        created_at: '2026-04-16T00:02:00.000Z',
        payload: 'c'.repeat(20),
        ttl: 'forever',
      },
    ];
    const adapter: TableAdapter<BucketRow> = {
      db: 'platform',
      table: 'run_events',
      tenantColumn: 'org_id',
      partitionColumn: 'created_at',
      config: {
        warmTtlDays: 7,
        minWarmTenantBytes: 0,
        minChunkBytes: 0,
        maxChunkBytes: 10 * 1024 * 1024,
        maxRowsPerCycle: 10_000,
        enabled: true,
      },
      listEligiblePartitions: async function* () {
        yield { tenantId: 'org1', partitionDate: '2026-04-16' };
      },
      countTenantWarmBytes: async () => 10 * 1024 * 1024,
      withPartitionLock: async (_a, fn) => fn(),
      selectEligible: async function* () {
        for (const r of rows) yield r;
      },
      encodeRow: (r) => JSON.stringify(r),
      decodeRow: (line) => JSON.parse(line) as BucketRow,
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.created_at,
      coldTtlDays: (r) => r.ttl,
      markArchivedAndDelete,
    };
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'archiver-1',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.chunksWritten).toBe(3);
    expect(summary.rowsArchived).toBe(3);

    // Each chunk's data key should sit under its bucket subprefix.
    const dataKeys = mock.sends
      .filter((s) => s.name === 'PutObjectCommand')
      .map((s) => s.input.Key as string)
      .filter((k) => k.endsWith('.jsonl.gz'))
      .sort();
    expect(dataKeys).toHaveLength(3);
    expect(dataKeys.some((k) => k.includes('/2026/04/16/30d/'))).toBe(true);
    expect(dataKeys.some((k) => k.includes('/2026/04/16/180d/'))).toBe(true);
    expect(dataKeys.some((k) => k.includes('/2026/04/16/forever/'))).toBe(true);

    // markArchivedAndDelete called once per bucket (3 transactions, not 1).
    expect(markArchivedAndDelete).toHaveBeenCalledTimes(3);

    // Each manifest carries v2 schema + bucket + maxColdDays.
    const manifestKeys = mock.sends
      .filter((s) => s.name === 'PutObjectCommand')
      .map((s) => s.input.Key as string)
      .filter((k) => k.endsWith('.manifest.json'));
    expect(manifestKeys).toHaveLength(3);
    for (const key of manifestKeys) {
      const entry = mock.objects.get(key);
      expect(entry).toBeTruthy();
      const parsed = JSON.parse(entry!.body.toString('utf-8')) as {
        schemaVersion: number;
        bucket: string;
        maxColdDays: number | 'forever';
      };
      expect(parsed.schemaVersion).toBe(2);
      // Each chunk holds exactly one row, so maxColdDays equals that row's TTL,
      // and bucket = coldDaysToBucket(TTL).
      if (parsed.bucket === '30d') expect(parsed.maxColdDays).toBe(30);
      else if (parsed.bucket === '180d') expect(parsed.maxColdDays).toBe(180);
      else if (parsed.bucket === 'forever') expect(parsed.maxColdDays).toBe('forever');
      else throw new Error(`unexpected bucket ${parsed.bucket}`);
    }
  });

  it('falls back to legacy single-chunk path when adapter has no coldTtlDays (v1 manifest)', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    // Sanity check: this adapter does NOT implement coldTtlDays.
    expect(adapter.coldTtlDays).toBeUndefined();
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'archiver-1',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    const summary = await store.runArchiveCycle();
    expect(summary.chunksWritten).toBe(1);

    // Data key sits at the day-prefix root (no bucket segment).
    const dataKey = mock.sends
      .filter((s) => s.name === 'PutObjectCommand')
      .map((s) => s.input.Key as string)
      .find((k) => k.endsWith('.jsonl.gz'))!;
    expect(dataKey).toMatch(/\/2026\/04\/16\/[a-f0-9]{16}\.jsonl\.gz$/);

    // Manifest carries schemaVersion=1, no bucket / maxColdDays fields
    // on disk (parseManifest backfills them in memory).
    const manifestKey = dataKey.replace('.jsonl.gz', '.manifest.json');
    const entry = mock.objects.get(manifestKey)!;
    const parsedRaw = JSON.parse(entry.body.toString('utf-8')) as Record<string, unknown>;
    expect(parsedRaw.schemaVersion).toBe(1);
    expect('bucket' in parsedRaw).toBe(false);
    expect('maxColdDays' in parsedRaw).toBe(false);
  });

  it('replayChunk: locates a v2 chunk that lives under a bucket subprefix', async () => {
    const mock = makeMockS3();
    const replayInsert = vi.fn(async () => ({ inserted: 1, skipped: 0 }));
    type BucketRow = TestRow & { ttl: number | 'forever' };
    const rows: BucketRow[] = [
      {
        id: 1,
        org_id: 'org1',
        created_at: '2026-04-16T00:00:00.000Z',
        payload: 'a'.repeat(20),
        ttl: 30,
      },
    ];
    const adapter: TableAdapter<BucketRow> = {
      db: 'platform',
      table: 'run_events',
      tenantColumn: 'org_id',
      partitionColumn: 'created_at',
      config: {
        warmTtlDays: 7,
        minWarmTenantBytes: 0,
        minChunkBytes: 0,
        maxChunkBytes: 10 * 1024 * 1024,
        maxRowsPerCycle: 10_000,
        enabled: true,
      },
      listEligiblePartitions: async function* () {
        yield { tenantId: 'org1', partitionDate: '2026-04-16' };
      },
      countTenantWarmBytes: async () => 10 * 1024 * 1024,
      withPartitionLock: async (_a, fn) => fn(),
      selectEligible: async function* () {
        for (const r of rows) yield r;
      },
      encodeRow: (r) => JSON.stringify(r),
      decodeRow: (line) => JSON.parse(line) as BucketRow,
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.created_at,
      coldTtlDays: (r) => r.ttl,
      markArchivedAndDelete: vi.fn(async () => undefined),
      replayInsert,
    };
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'v2-replay',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    await store.runArchiveCycle();
    // Sanity: the chunk landed under the 30d bucket subprefix.
    const dataKey = Array.from(mock.objects.keys()).find((k) => k.endsWith('.jsonl.gz'))!;
    expect(dataKey).toContain('/2026/04/16/30d/');
    const chunkId = dataKey.split('/').pop()!.replace('.jsonl.gz', '');

    // Caller has no idea which bucket this lives under — only chunkId.
    const result = await store.replayChunk({
      db: 'platform',
      table: 'run_events',
      tenantId: 'org1',
      partitionDate: '2026-04-16',
      chunkId,
    });
    expect(result.inserted).toBe(1);
    expect(result.chunkId).toBe(chunkId);
    expect(replayInsert).toHaveBeenCalledTimes(1);
  });

  it('replayChunk: throws not-found when no manifest matches the chunkId', async () => {
    const mock = makeMockS3();
    const { adapter } = makeTestAdapter();
    const replayInsert = vi.fn(async () => ({ inserted: 0, skipped: 0 }));
    (adapter as unknown as { replayInsert: typeof replayInsert }).replayInsert = replayInsert;
    const store = new TestColdStore({
      db: 'platform',
      instanceId: 'replay-missing',
      log: vi.fn(),
      config: makeConfig(true),
      s3Client: mock.client,
    });
    store.registerAdapterForTests(adapter);

    await expect(
      store.replayChunk({
        db: 'platform',
        table: 'run_events',
        tenantId: 'org1',
        partitionDate: '2026-04-16',
        chunkId: 'deadbeef00000000',
      }),
    ).rejects.toThrow(/replay-chunk deadbeef00000000 not found/);
    expect(replayInsert).not.toHaveBeenCalled();
  });
});
