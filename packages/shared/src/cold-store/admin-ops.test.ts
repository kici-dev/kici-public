import { afterEach, describe, expect, it, vi } from 'vitest';
import { createColdStoreAdminOps, type BuiltColdStore } from './admin-ops.js';
import { computeChunkId } from './chunk-id.js';
import { encodeChunk } from './chunk-encoder.js';
import { chunkObjectKey, type DbKind } from './key.js';
import { parseManifest, serializeManifest } from './manifest.js';
import type { TableAdapter } from './table-adapter.js';
import type { ChunkManifest } from './types.js';

interface Row {
  id: number;
  created_at: string;
}

const ROWS: Row[] = [
  { id: 1, created_at: '2026-10-04T00:00:00.000Z' },
  { id: 2, created_at: '2026-10-04T00:05:00.000Z' },
];

function makeAdapter(db: DbKind): TableAdapter<unknown> {
  return {
    db,
    table: 'execution_runs',
    rowId: (r: Row) => r.id,
    rowTimestamp: (r: Row) => r.created_at,
    coldTtlDays: (r: Row) => (r.id === 1 ? 30 : 90),
    markArchivedAndDelete: vi.fn(async () => undefined),
  } as unknown as TableAdapter<unknown>;
}

/**
 * An in-memory store holding one encoded chunk per side, plus its manifest.
 * With `bucket`, each chunk sits under that per-bucket (v2) subprefix.
 */
async function makeFake(opts: { enabled?: boolean; bucket?: string; rows?: Row[] } = {}) {
  const objects = new Map<string, Buffer>();
  const adapters = new Map<string, TableAdapter<unknown>>();
  const chunks = new Map<DbKind, { chunkId: string; dataKey: string; manifestKey: string }>();
  for (const db of ['orchestrator', 'platform'] as const) {
    adapters.set(db, makeAdapter(db));
    const encoded = await encodeChunk<Row>({
      rows: (async function* () {
        yield* opts.rows ?? ROWS;
      })(),
      rowId: (r) => r.id,
      rowTimestamp: (r) => r.created_at,
    });
    const tenantId = `${db}-tenant`;
    const chunkId = computeChunkId({
      db,
      table: 'execution_runs',
      tenantId,
      partitionDate: '2026-10-04',
      minRowId: encoded.minRowId,
      maxRowId: encoded.maxRowId,
    });
    const keyArgs = {
      prefix: 'cs/',
      db,
      table: 'execution_runs',
      tenantId,
      partitionDate: '2026-10-04',
      chunkId,
      bucket: opts.bucket,
    };
    const dataKey = chunkObjectKey({ ...keyArgs, kind: 'data' });
    const manifestKey = chunkObjectKey({ ...keyArgs, kind: 'manifest' });
    // serializeManifest keeps only manifest keys, so the encoder's extra fields drop out.
    const manifest = {
      ...encoded,
      ...keyArgs,
      schemaVersion: 1,
      createdAt: '2026-10-04T01:00:00.000Z',
      archiverInstanceId: 'test',
      ...(opts.bucket ? { schemaVersion: 2, maxColdDays: 90 } : {}),
    } as unknown as ChunkManifest;
    objects.set(dataKey, encoded.data);
    objects.set(manifestKey, Buffer.from(serializeManifest(manifest)));
    chunks.set(db, { chunkId, dataKey, manifestKey });
  }
  const close = vi.fn(async () => undefined);
  const built = (db: DbKind): BuiltColdStore => ({
    prefix: 'cs/',
    enabled: opts.enabled ?? true,
    close,
    store: {
      getAdapter: (table: string) => (table === 'execution_runs' ? adapters.get(db) : undefined),
      listAdapters: () => [adapters.get(db)!],
      listObjectKeys: async (prefix: string) =>
        Array.from(objects.keys())
          .filter((k) => k.startsWith(prefix))
          .sort(),
      getObjectBody: async (key: string) => {
        const body = objects.get(key);
        if (!body) throw new Error(`NoSuchKey: ${key}`);
        return body;
      },
      putManifestObject: async (key: string, m: ChunkManifest) => {
        objects.set(key, Buffer.from(serializeManifest(m)));
      },
    } as unknown as BuiltColdStore['store'],
  });
  return { objects, chunks, close, built };
}

function opsFor(fake: Awaited<ReturnType<typeof makeFake>>, db: DbKind) {
  return createColdStoreAdminOps({
    db,
    label: db === 'platform' ? 'Platform' : 'Orchestrator',
    reconcileInstanceId: `${db}-cli:reconcile`,
    build: async () => fake.built(db),
  });
}

function captureStdout() {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  return () => write.mock.calls.map((c) => String(c[0])).join('');
}

const SIDES = ['orchestrator', 'platform'] as const;

describe('createColdStoreAdminOps', () => {
  afterEach(() => vi.restoreAllMocks());

  // fails-when: listChunks hard-codes one side's key segment for both sides
  it.each(SIDES)('%s side lists only chunks under its own key segment', async (db) => {
    const fake = await makeFake();
    const out = captureStdout();
    await opsFor(fake, db).listChunks({ databaseUrl: 'unused', table: 'execution_runs' });
    const { chunkId, dataKey, manifestKey } = fake.chunks.get(db)!;
    expect(out()).toBe(
      JSON.stringify({
        chunkId,
        tenantId: `${db}-tenant`,
        partitionDate: '2026-10-04',
        dataKey,
        manifestKey,
      }) + '\n',
    );
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  // fails-when: the --from/--to window filter is dropped from listChunks
  it('drops chunks outside the --from window', async () => {
    const fake = await makeFake();
    const out = captureStdout();
    await opsFor(fake, 'platform').listChunks({
      databaseUrl: 'unused',
      table: 'execution_runs',
      from: '2026-10-05',
    });
    expect(out()).toBe('no chunks registered\n');
  });

  // fails-when: the error names the wrong side
  it('names the side in the unknown-adapter error', async () => {
    const fake = await makeFake();
    await expect(
      opsFor(fake, 'platform').archiveNow({ databaseUrl: 'u', table: 'nope' }),
    ).rejects.toThrow(
      "no cold-store adapter registered for table 'nope' on Platform; registered: execution_runs",
    );
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  // fails-when: assertEnabled is skipped
  it('refuses to run while the cold store is disabled', async () => {
    const fake = await makeFake({ enabled: false });
    await expect(
      opsFor(fake, 'orchestrator').listChunks({ databaseUrl: 'u', table: 'execution_runs' }),
    ).rejects.toThrow(/cold-store is disabled/);
  });

  // fails-when: verifyChunk stops comparing the data hash with the manifest
  it('verifyChunk reports a match, then a mismatch once the data changes', async () => {
    const fake = await makeFake();
    const ops = opsFor(fake, 'orchestrator');
    const { chunkId, dataKey } = fake.chunks.get('orchestrator')!;
    const args = {
      databaseUrl: 'u',
      chunkId,
      table: 'execution_runs',
      tenant: 'orchestrator-tenant',
      partitionDate: '2026-10-04',
    };
    captureStdout();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(ops.verifyChunk(args)).resolves.toBe('match');
    fake.objects.set(dataKey, Buffer.from('tampered'));
    await expect(ops.verifyChunk(args)).resolves.toBe('mismatch');
  });

  // fails-when: reconcile writes a manifest under, or stamped with, the wrong side
  it.each(SIDES)('%s side reconcile rebuilds a missing manifest for its side', async (db) => {
    const fake = await makeFake();
    const { chunkId, manifestKey } = fake.chunks.get(db)!;
    fake.objects.delete(manifestKey);
    const out = captureStdout();
    await opsFor(fake, db).reconcile({ databaseUrl: 'u', table: 'execution_runs' });
    expect(out()).toContain(
      `reconcile execution_runs: orphans_repaired=1 data_missing=0 total_chunks=1`,
    );
    const rebuilt = parseManifest(fake.objects.get(manifestKey)!);
    expect(rebuilt).toMatchObject({
      schemaVersion: 1,
      db,
      chunkId,
      rowCount: ROWS.length,
      byteCount: 0,
      archiverInstanceId: `${db}-cli:reconcile`,
    });
  });

  // fails-when: reconcile drops the adapter's natural-key index from the rebuilt manifest
  // breaks-if-wrong: an adapter with no replayLookupKey must still get a manifest without the field
  it('reconcile rebuilds the replayLookupKeys index when the adapter defines one', async () => {
    const fake = await makeFake();
    const { manifestKey } = fake.chunks.get('orchestrator')!;
    const platformManifestKey = fake.chunks.get('platform')!.manifestKey;
    fake.objects.delete(manifestKey);
    fake.objects.delete(platformManifestKey);
    const adapter = fake.built('orchestrator').store.getAdapter('execution_runs')!;
    Object.assign(adapter, { replayLookupKey: (r: Row) => `run-${r.id}` });
    captureStdout();
    await opsFor(fake, 'orchestrator').reconcile({ databaseUrl: 'u', table: 'execution_runs' });
    await opsFor(fake, 'platform').reconcile({ databaseUrl: 'u', table: 'execution_runs' });
    expect(parseManifest(fake.objects.get(manifestKey)!).replayLookupKeys).toEqual([
      'run-1',
      'run-2',
    ]);
    expect(parseManifest(fake.objects.get(platformManifestKey)!)).not.toHaveProperty(
      'replayLookupKeys',
    );
  });

  // fails-when: reconcile orders numeric row ids as strings ('10' < '9'), derives a
  // different chunk id than the archiver did, and skips the chunk as tampered
  it('reconcile re-derives the chunk id of numeric row ids the way the archiver does', async () => {
    const fake = await makeFake({
      rows: [
        { id: 9, created_at: '2026-10-04T00:00:00.000Z' },
        { id: 10, created_at: '2026-10-04T00:05:00.000Z' },
      ],
    });
    const { manifestKey } = fake.chunks.get('orchestrator')!;
    fake.objects.delete(manifestKey);
    const out = captureStdout();
    await opsFor(fake, 'orchestrator').reconcile({ databaseUrl: 'u', table: 'execution_runs' });
    expect(out()).toContain('orphans_repaired=1');
    expect(parseManifest(fake.objects.get(manifestKey)!)).toMatchObject({
      minRowId: 9,
      maxRowId: 10,
    });
  });

  // fails-when: --confirm-cleanup stops printing its deprecation notice
  // breaks-if-wrong: the deprecated flag must not stop reconcile from rebuilding manifests
  it('reconcile --confirm-cleanup prints a deprecation notice and still rebuilds', async () => {
    const fake = await makeFake();
    fake.objects.delete(fake.chunks.get('platform')!.manifestKey);
    const out = captureStdout();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await opsFor(fake, 'platform').reconcile({
      databaseUrl: 'u',
      table: 'execution_runs',
      confirmCleanup: true,
    });
    expect(String(err.mock.calls[0]?.[0])).toContain('--confirm-cleanup is deprecated');
    expect(out()).toContain('orphans_repaired=1');
  });

  describe('per-bucket (v2) chunks', () => {
    // fails-when: the key pattern drops the optional <bucket> segment again
    it('listChunks lists a chunk under a bucket subprefix', async () => {
      const fake = await makeFake({ bucket: '180d' });
      const out = captureStdout();
      await opsFor(fake, 'platform').listChunks({ databaseUrl: 'u', table: 'execution_runs' });
      const { dataKey, manifestKey } = fake.chunks.get('platform')!;
      expect(dataKey).toContain('/2026/10/04/180d/');
      expect(JSON.parse(out())).toMatchObject({ dataKey, manifestKey });
    });

    // fails-when: verifyChunk and peekChunk address only the v1 day-root key
    it('verifyChunk and peekChunk find a chunk under a bucket subprefix', async () => {
      const fake = await makeFake({ bucket: '180d' });
      const { chunkId } = fake.chunks.get('orchestrator')!;
      const args = {
        databaseUrl: 'u',
        chunkId,
        table: 'execution_runs',
        tenant: 'orchestrator-tenant',
        partitionDate: '2026-10-04',
      };
      const out = captureStdout();
      const ops = opsFor(fake, 'orchestrator');
      await expect(ops.verifyChunk(args)).resolves.toBe('match');
      await ops.peekChunk({ ...args, limit: 1 });
      expect(out()).toContain(JSON.stringify(ROWS[0]) + '\n');
    });

    // breaks-if-wrong: a v1 chunk must still resolve to its day-root key
    it('verifyChunk still reads a v1 chunk at the day root', async () => {
      const fake = await makeFake();
      const { chunkId } = fake.chunks.get('platform')!;
      captureStdout();
      await expect(
        opsFor(fake, 'platform').verifyChunk({
          databaseUrl: 'u',
          chunkId,
          table: 'execution_runs',
          tenant: 'platform-tenant',
          partitionDate: '2026-10-04',
        }),
      ).resolves.toBe('match');
    });

    // fails-when: reconcile writes a v1 manifest at the day root for a bucketed chunk
    it('reconcile rebuilds a v2 manifest beside the bucketed data file', async () => {
      const fake = await makeFake({ bucket: '180d' });
      const { manifestKey } = fake.chunks.get('platform')!;
      fake.objects.delete(manifestKey);
      captureStdout();
      await opsFor(fake, 'platform').reconcile({ databaseUrl: 'u', table: 'execution_runs' });
      expect(parseManifest(fake.objects.get(manifestKey)!)).toMatchObject({
        schemaVersion: 2,
        bucket: '180d',
        maxColdDays: 90,
        archiverInstanceId: 'platform-cli:reconcile',
      });
    });
  });
});
