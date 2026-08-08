import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fake S3 client shared with the S3LogStorage under test. The active
// instance is swapped per makeStore()/makeStoreWithObjects() call before the
// storage constructor runs (which calls the mocked createS3Client).
let activeFake: FakeS3;

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return { ...actual, createS3Client: () => activeFake as unknown };
});

const { S3LogStorage } = await import('./s3-log-storage.js');

interface PutRecord {
  Key: string;
  Body: Buffer;
}

/** Minimal in-memory S3 that understands the commands S3LogStorage issues. */
class FakeS3 {
  objects = new Map<string, Buffer>();
  mtimes = new Map<string, Date>();
  puts: PutRecord[] = [];
  deleteBatches: string[][] = [];
  /** Full object keys the fake refuses to delete (returns a per-key error). */
  failDeleteKeys = new Set<string>();

  seed(objects: Record<string, string>): void {
    for (const [key, value] of Object.entries(objects)) {
      this.objects.set(key, Buffer.from(value, 'utf-8'));
    }
  }

  seedWithMtime(objects: Record<string, { body: string; mtime: Date }>): void {
    for (const [key, { body, mtime }] of Object.entries(objects)) {
      this.objects.set(key, Buffer.from(body, 'utf-8'));
      this.mtimes.set(key, mtime);
    }
  }

  private notFound(): Error {
    const err = new Error('not found') as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    err.name = 'NotFound';
    err.$metadata = { httpStatusCode: 404 };
    return err;
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'PutObjectCommand') {
      const raw = input.Body;
      const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf-8');
      this.objects.set(input.Key as string, body);
      this.puts.push({ Key: input.Key as string, Body: body });
      return {};
    }
    if (name === 'HeadObjectCommand') {
      const body = this.objects.get(input.Key as string);
      if (!body) throw this.notFound();
      return { ContentLength: body.length };
    }
    if (name === 'GetObjectCommand') {
      const body = this.objects.get(input.Key as string);
      if (!body) throw this.notFound();
      let slice = body;
      const range = input.Range as string | undefined;
      if (range) {
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        if (m) slice = body.subarray(Number(m[1]), Number(m[2]) + 1);
      }
      return { Body: { transformToByteArray: async () => new Uint8Array(slice) } };
    }
    if (name === 'ListObjectsV2Command') {
      const prefix = (input.Prefix as string | undefined) ?? '';
      let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const maxKeys = input.MaxKeys as number | undefined;
      if (maxKeys !== undefined) keys = keys.slice(0, maxKeys);
      return {
        Contents: keys.map((k) => ({
          Key: k,
          Size: this.objects.get(k)!.length,
          LastModified: this.mtimes.get(k),
        })),
        IsTruncated: false,
      };
    }
    if (name === 'DeleteObjectsCommand') {
      const del = input.Delete as { Objects: Array<{ Key: string }> };
      const keys = del.Objects.map((o) => o.Key);
      this.deleteBatches.push(keys);
      const errors: Array<{ Key: string }> = [];
      for (const k of keys) {
        if (this.failDeleteKeys.has(k)) {
          errors.push({ Key: k }); // S3 returns per-key errors even with Quiet:true
          continue;
        }
        this.objects.delete(k);
        this.mtimes.delete(k);
      }
      return errors.length > 0 ? { Errors: errors } : {};
    }
    throw new Error(`FakeS3: unhandled command ${name}`);
  }
}

function makeStore(opts: { flushBytes: number; flushMs: number }) {
  activeFake = new FakeS3();
  const store = new S3LogStorage({
    bucket: 'b',
    prefix: '',
    segmentFlushBytes: opts.flushBytes,
    segmentFlushMs: opts.flushMs,
  });
  return { store, fake: activeFake };
}

function makeStoreWithObjects(objects: Record<string, string>) {
  activeFake = new FakeS3();
  activeFake.seed(objects);
  const store = new S3LogStorage({
    bucket: 'b',
    prefix: '',
    segmentFlushBytes: 1_048_576,
    segmentFlushMs: 60_000,
  });
  return { store, fake: activeFake };
}

describe('S3LogStorage buffered streaming segments (appendStreaming)', () => {
  it('two concurrent appendStreaming to the same path both persist (no lost update)', async () => {
    const { store, fake } = makeStore({ flushBytes: 1, flushMs: 0 }); // seal every append
    await Promise.all([
      store.appendStreaming('executions/r/job-a/step-0.log', 'A\n'),
      store.appendStreaming('executions/r/job-a/step-0.log', 'B\n'),
    ]);
    const bodies = fake.puts.map((p) => p.Body.toString('utf-8'));
    expect(bodies).toContain('A\n');
    expect(bodies).toContain('B\n');
    const keys = fake.puts.map((p) => p.Key);
    expect(new Set(keys).size).toBe(keys.length); // all unique seg keys
  });

  it('buffers below threshold and seals one segment on finalize', async () => {
    const { store, fake } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await store.appendStreaming('executions/r/job-a/step-1.log', 'x\n');
    await store.appendStreaming('executions/r/job-a/step-1.log', 'y\n');
    expect(fake.puts.length).toBe(0); // nothing sealed yet
    await store.finalize('executions/r/job-a/step-1.log');
    expect(fake.puts.length).toBe(1);
    expect(fake.puts[0].Body.toString('utf-8')).toBe('x\ny\n');
    expect(fake.puts[0].Key).toMatch(/step-1\.log\/seg-000000$/);
  });

  it('seals by size threshold with each byte written exactly once', async () => {
    const { store, fake } = makeStore({ flushBytes: 4, flushMs: 60_000 });
    await store.appendStreaming('executions/r/job-a/step-2.log', 'aa\n'); // 3 bytes < 4
    await store.appendStreaming('executions/r/job-a/step-2.log', 'bb\n'); // now 6 >= 4 -> seal
    expect(fake.puts.length).toBe(1);
    expect(fake.puts[0].Body.toString('utf-8')).toBe('aa\nbb\n');
  });

  it('continues seq numbering after a mid-run redeploy (existing segments)', async () => {
    const { store, fake } = makeStoreWithObjects({
      'executions/r/job-a/step-0.log/seg-000000': 'old\n',
    });
    // A fresh append should seal as seg-000001, not clobber seg-000000.
    await store.appendStreaming('executions/r/job-a/step-0.log', 'new\n');
    await store.finalize('executions/r/job-a/step-0.log');
    expect(fake.puts.length).toBe(1);
    expect(fake.puts[0].Key).toMatch(/step-0\.log\/seg-000001$/);
  });
});

describe('S3LogStorage append() single-shot durability (v1-revert guard)', () => {
  it('append() stays immediately durable + readable with NO finalize', async () => {
    // A single-shot writer (webhook payload, rerun payload, orchestration log)
    // writes once via append() and must read the content back without any
    // appendStreaming/finalize. The reverted v1 broke exactly this by routing
    // append() through the buffer; this guard fails loudly if it recurs.
    const { store, fake } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await store.append('event-log/deliveries/d1.json.gz', 'payload-bytes');
    // No appendStreaming/finalize was called.
    expect(fake.puts.length).toBe(1); // written immediately as a single object
    expect(fake.puts.some((p) => p.Key.includes('/seg-'))).toBe(false); // NOT a segment
    const res = await store.read('event-log/deliveries/d1.json.gz');
    expect(res.data).toBe('payload-bytes');
    expect(res.complete).toBe(true);
  });

  it('append() concatenates onto its existing single object (read-modify-write)', async () => {
    const { store } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await store.append('logs/orchestration.log', 'line-1\n');
    await store.append('logs/orchestration.log', 'line-2\n');
    const res = await store.read('logs/orchestration.log');
    expect(res.data).toBe('line-1\nline-2\n');
    expect(res.complete).toBe(true);
  });
});

describe('S3LogStorage segment-aware read/exists/list', () => {
  it('read maps the byte cursor across multiple sealed segments', async () => {
    const { store } = makeStoreWithObjects({
      'p/step-0.log/seg-000000': 'aaa\n', // 4 bytes
      'p/step-0.log/seg-000001': 'bb\n', // 3 bytes
    });
    const first = await store.read('p/step-0.log', { cursor: 0, limit: 4 });
    expect(first.data).toBe('aaa\n');
    expect(first.cursor).toBe(4);
    expect(first.complete).toBe(false);
    const rest = await store.read('p/step-0.log', { cursor: 4 });
    expect(rest.data).toBe('bb\n');
    expect(rest.cursor).toBe(7);
    expect(rest.complete).toBe(true);
  });

  it('read concatenates a legacy single object before segments (deploy transition)', async () => {
    const { store } = makeStoreWithObjects({
      'p/step-0.log': 'old\n', // legacy/single object, 4 bytes
      'p/step-0.log/seg-000000': 'new\n', // 4 bytes
    });
    const all = await store.read('p/step-0.log');
    expect(all.data).toBe('old\nnew\n');
    expect(all.complete).toBe(true);
    expect(all.cursor).toBe(8);
  });

  it('read returns empty + complete for a missing step', async () => {
    const { store } = makeStoreWithObjects({});
    const res = await store.read('p/nope.log');
    expect(res.data).toBe('');
    expect(res.cursor).toBe(0);
    expect(res.complete).toBe(true);
  });

  it('list collapses segment keys to the logical step path and dedups', async () => {
    const { store } = makeStoreWithObjects({
      'executions/r/job-a/step-0.log/seg-000000': 'x',
      'executions/r/job-a/step-0.log/seg-000001': 'y',
      'executions/r/job-a/step-1.log/seg-000000': 'z',
    });
    const paths = await store.list('executions/r/');
    expect(paths).toEqual(['executions/r/job-a/step-0.log', 'executions/r/job-a/step-1.log']);
  });

  it('exists is true when only segments exist', async () => {
    const { store } = makeStoreWithObjects({ 'p/step-0.log/seg-000000': 'x' });
    expect(await store.exists('p/step-0.log')).toBe(true);
  });

  it('exists is true for a legacy single object', async () => {
    const { store } = makeStoreWithObjects({ 'p/step-0.log': 'x' });
    expect(await store.exists('p/step-0.log')).toBe(true);
  });

  it('exists is false when neither legacy nor segments exist', async () => {
    const { store } = makeStoreWithObjects({});
    expect(await store.exists('p/step-0.log')).toBe(false);
  });
});

describe('S3LogStorage round-trip', () => {
  beforeEach(() => {
    // isolate module-level fake between round-trip cases
    activeFake = new FakeS3();
  });

  it('appendStreaming then read returns the full buffered content across seals', async () => {
    const { store } = makeStore({ flushBytes: 4, flushMs: 60_000 });
    const path = 'executions/r/job-a/step-0.log';
    await store.appendStreaming(path, 'aa\n'); // buffered
    await store.appendStreaming(path, 'bb\n'); // seals seg-000000 ('aa\nbb\n')
    await store.appendStreaming(path, 'cc\n'); // buffered tail
    await store.finalize(path); // seals seg-000001 ('cc\n')

    const res = await store.read(path);
    expect(res.data).toBe('aa\nbb\ncc\n');
    expect(res.complete).toBe(true);
    expect(res.cursor).toBe(9);
  });
});

describe('S3LogStorage retention helpers (listWithMetadata + deleteMany)', () => {
  it('listWithMetadata returns physical segment keys with LastModified (no seg-collapse)', async () => {
    const d0 = new Date('2026-01-01T00:00:00Z');
    const d1 = new Date('2026-02-01T00:00:00Z');
    const { store } = makeStoreWithObjects({});
    activeFake.seedWithMtime({
      'executions/r1/job-a/step-0.log/seg-000000': { body: 'a\n', mtime: d0 },
      'executions/r1/job-a/step-0.log/seg-000001': { body: 'b\n', mtime: d1 },
      'executions/r2/job-a/step-0.log': { body: 'c\n', mtime: d0 }, // legacy single object
    });
    const out = await store.listWithMetadata('executions/');
    expect(out).toEqual(
      expect.arrayContaining([
        { path: 'executions/r1/job-a/step-0.log/seg-000000', lastModified: d0 },
        { path: 'executions/r1/job-a/step-0.log/seg-000001', lastModified: d1 },
        { path: 'executions/r2/job-a/step-0.log', lastModified: d0 },
      ]),
    );
    expect(out).toHaveLength(3);
  });

  it('deleteMany issues DeleteObjects chunked at 1000 keys and returns the count', async () => {
    const { store, fake } = makeStore({ flushBytes: 1, flushMs: 0 });
    const paths = Array.from({ length: 1500 }, (_, i) => `executions/r/job-a/step-${i}.log`);
    const n = await store.deleteMany(paths);
    expect(n).toBe(1500);
    expect(fake.deleteBatches).toHaveLength(2);
    expect(fake.deleteBatches[0]).toHaveLength(1000);
    expect(fake.deleteBatches[1]).toHaveLength(500);
    // Keys are deleteKey()-prefixed (empty prefix here, so identity).
    expect(fake.deleteBatches[0][0]).toBe('executions/r/job-a/step-0.log');
  });

  it('deleteMany counts only keys S3 actually removed (per-key errors excluded)', async () => {
    const { store, fake } = makeStore({ flushBytes: 1, flushMs: 0 });
    const paths = ['executions/r/j/a.log', 'executions/r/j/b.log', 'executions/r/j/c.log'];
    fake.failDeleteKeys.add('executions/r/j/b.log'); // one key fails
    const n = await store.deleteMany(paths);
    expect(n).toBe(2); // a + c removed; b reported an error, not counted
  });
});

describe('S3LogStorage key validation', () => {
  // Not a traversal fix: S3 keys are opaque, so `..` is a literal segment and
  // nothing escapes the prefix. This refuses to MINT a malformed key, whose
  // prefix-sliced form list() would hand back as an odd relative path.
  const NUL_PATH = 'executions/run-1/job-\u0000evil/step-0.log';

  const malformed: Array<[name: string, path: string]> = [
    ['a leading .. segment', '../escape'],
    ['a .. segment mid-path', 'a/../../escape'],
    ['an absolute path', '/etc/passwd'],
    ['a NUL-bearing key', NUL_PATH],
  ];

  for (const [name, path] of malformed) {
    it(`refuses ${name}`, async () => {
      const { store } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
      await expect(store.append(path, 'x\n')).rejects.toThrow();
      await expect(store.read(path)).rejects.toThrow();
      await expect(store.exists(path)).rejects.toThrow();
    });
  }

  it('still accepts the canonical step-log path', async () => {
    const { store } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await expect(
      store.append('executions/run-1/job-build/step-0.log', 'x\n'),
    ).resolves.not.toThrow();
  });

  it('still accepts a job name containing .. as a substring', async () => {
    const { store } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await expect(store.append('executions/r/job-a..b/step-0.log', 'x\n')).resolves.not.toThrow();
  });
});

describe('S3LogStorage retention over a legacy malformed key', () => {
  // A key carrying `..` cannot be minted any more, but a bucket written before
  // objectKey() started refusing them still holds one. listWithMetadata()
  // reports it verbatim, so the retention sweep feeds it straight back into
  // deleteMany(). If that path re-applied the minting assert it would throw
  // while building the batch, aborting the whole sweep — so every expired
  // object in the bucket would be retained forever, not just the malformed one.
  const LEGACY_MALFORMED = 'executions/r/job-../../evil/step-0.log';

  it('lists a legacy malformed key rather than hiding it', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const { store } = makeStoreWithObjects({});
    activeFake.seedWithMtime({
      [LEGACY_MALFORMED]: { body: 'x\n', mtime: old },
      'executions/r/job-a/step-0.log': { body: 'y\n', mtime: old },
    });
    const out = await store.listWithMetadata('executions/');
    expect(out.map((o) => o.path).sort()).toEqual([
      LEGACY_MALFORMED,
      'executions/r/job-a/step-0.log',
    ]);
  });

  it('deleteMany removes it alongside well-formed keys instead of aborting the batch', async () => {
    const { store, fake } = makeStoreWithObjects({});
    activeFake.seedWithMtime({
      [LEGACY_MALFORMED]: { body: 'x\n', mtime: new Date('2026-01-01T00:00:00Z') },
    });
    const n = await store.deleteMany([
      'executions/r/job-a/step-0.log',
      LEGACY_MALFORMED,
      'executions/r/job-b/step-0.log',
    ]);
    // All three keys reached S3 in ONE batch — the malformed one did not throw
    // while the batch was being built, which is the whole point.
    expect(n).toBe(3);
    expect(fake.deleteBatches).toHaveLength(1);
    expect(fake.deleteBatches[0]).toContain(LEGACY_MALFORMED);
    expect(fake.objects.has(LEGACY_MALFORMED)).toBe(false);
  });

  it('still refuses to MINT a malformed key on the write and read paths', async () => {
    // The removal carve-out is scoped to deleteMany: append/read/exists still
    // reject, so nothing can create another one.
    const { store } = makeStore({ flushBytes: 1_000_000, flushMs: 60_000 });
    await expect(store.append(LEGACY_MALFORMED, 'x\n')).rejects.toThrow();
    await expect(store.read(LEGACY_MALFORMED)).rejects.toThrow();
    await expect(store.exists(LEGACY_MALFORMED)).rejects.toThrow();
  });
});
