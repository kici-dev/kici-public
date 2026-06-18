import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemCacheStorage } from './filesystem.js';
import { generateSigningSecret, verifyToken } from './sign-url.js';

describe('FilesystemCacheStorage', () => {
  let dir: string;
  let storage: FilesystemCacheStorage;
  let secret: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-cache-test-'));
    secret = generateSigningSecret();
    storage = new FilesystemCacheStorage({
      basePath: dir,
      ttlMs: 60_000,
      baseUrl: 'http://orch.local:10143',
      signingSecret: secret,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put + get round-trips a buffer', async () => {
    await storage.put('dep/abc', Buffer.from('hello world'));
    const got = await storage.get('dep/abc');
    expect(got?.toString('utf-8')).toBe('hello world');
  });

  it('put + get round-trips a string', async () => {
    await storage.put('dep/string', 'plain text');
    const got = await storage.get('dep/string');
    expect(got?.toString('utf-8')).toBe('plain text');
  });

  it('has() returns false when missing, true when present, false after delete', async () => {
    expect(await storage.has('dep/missing')).toBe(false);
    await storage.put('dep/present', 'x');
    expect(await storage.has('dep/present')).toBe(true);
    expect(await storage.delete('dep/present')).toBe(true);
    expect(await storage.has('dep/present')).toBe(false);
  });

  it('delete() returns false when key never existed', async () => {
    expect(await storage.delete('dep/never')).toBe(false);
  });

  it('get() returns null when missing', async () => {
    expect(await storage.get('dep/missing')).toBeNull();
  });

  it('expires items past ttlMs via lastAccessedAt staleness', async () => {
    storage = new FilesystemCacheStorage({
      basePath: dir,
      ttlMs: 1, // 1ms
      baseUrl: 'http://orch.local:10143',
      signingSecret: secret,
    });
    await storage.put('dep/expiring', 'gone soon');
    await new Promise((r) => setTimeout(r, 10));
    expect(await storage.has('dep/expiring')).toBe(false);
    expect(await storage.get('dep/expiring')).toBeNull();
  });

  it('touch() refreshes lastAccessedAt without changing data', async () => {
    await storage.put('dep/touched', 'data');
    const before = await readFile(join(dir, 'dep/touched.meta.json'), 'utf-8');
    await new Promise((r) => setTimeout(r, 5));
    await storage.touch('dep/touched');
    const after = await readFile(join(dir, 'dep/touched.meta.json'), 'utf-8');
    expect(after).not.toBe(before);
    const got = await storage.get('dep/touched');
    expect(got?.toString('utf-8')).toBe('data');
  });

  it('getMetadata returns createdAt + lastAccessedAt and touch advances only lastAccessedAt', async () => {
    await storage.put('dep/meta', 'data');
    const first = await storage.getMetadata('dep/meta');
    expect(first).not.toBeNull();
    expect(typeof first!.createdAt).toBe('string');
    expect(typeof first!.lastAccessedAt).toBe('string');
    // Advance wall-clock enough that a touch yields a strictly later ISO timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await storage.touch('dep/meta');
    const second = await storage.getMetadata('dep/meta');
    expect(second!.createdAt).toBe(first!.createdAt); // creation time is immutable
    expect(new Date(second!.lastAccessedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first!.lastAccessedAt).getTime(),
    );
  });

  it('getMetadata returns null for a missing key', async () => {
    expect(await storage.getMetadata('dep/nope')).toBeNull();
  });

  it('getUrl() returns null when missing', async () => {
    expect(await storage.getUrl('dep/missing')).toBeNull();
  });

  it('getUrl() returns a signed GET URL that round-trips verification', async () => {
    await storage.put('dep/abc', 'x');
    const url = await storage.getUrl('dep/abc');
    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe('http://orch.local:10143');
    expect(parsed.pathname).toBe('/api/v1/cache/blob/dep/abc');
    const token = parsed.searchParams.get('sig');
    expect(token).toBeTruthy();
    const result = verifyToken(secret, 'GET', 'dep/abc', token!);
    expect(result.ok).toBe(true);
  });

  it('getUploadUrl() returns a signed PUT URL', async () => {
    const url = await storage.getUploadUrl('dep/up');
    const parsed = new URL(url);
    const token = parsed.searchParams.get('sig')!;
    const result = verifyToken(secret, 'PUT', 'dep/up', token);
    expect(result.ok).toBe(true);
  });

  it('initMeta() writes metadata for a separately-written file', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'dep'), { recursive: true });
    await writeFile(join(dir, 'dep/uploaded'), 'put-by-route');
    expect(await storage.has('dep/uploaded')).toBe(false);
    await storage.initMeta('dep/uploaded');
    expect(await storage.has('dep/uploaded')).toBe(true);
    const got = await storage.get('dep/uploaded');
    expect(got?.toString('utf-8')).toBe('put-by-route');
  });

  it('rejects keys with .. segments', async () => {
    await expect(storage.put('../etc/passwd', 'pwn')).rejects.toThrow(/Invalid cache key/);
    await expect(storage.get('foo/../../bar')).rejects.toThrow(/Invalid cache key/);
  });

  it('rejects keys with NUL bytes', async () => {
    await expect(storage.put('foo\0bar', 'x')).rejects.toThrow(/Invalid cache key/);
  });

  it('pathFor() exposes the on-disk path for HTTP-route consumers', () => {
    expect(storage.pathFor('dep/abc')).toBe(join(dir, 'dep/abc'));
  });

  it('signed URL key percent-encodes individual segments but keeps slashes', async () => {
    await storage.put('dep/has space', 'x');
    const url = await storage.getUrl('dep/has space');
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe('/api/v1/cache/blob/dep/has%20space');
  });

  it('list() returns keys under a sub-prefix newest-first, excluding meta files', async () => {
    await storage.put('a/k1', 'one');
    await new Promise((r) => setTimeout(r, 5));
    await storage.put('a/k2', 'two');
    await storage.put('b/k3', 'three');
    const listed = await storage.list('a/');
    // Only data files under a/ — meta sidecars are excluded.
    expect([...listed].sort()).toEqual(['a/k1', 'a/k2']);
    // Newest-first ordering: a/k2 written after a/k1.
    expect(listed[0]).toBe('a/k2');
  });

  it('list() returns an empty array for a missing sub-prefix', async () => {
    expect(await storage.list('nope/')).toEqual([]);
  });

  it('copy() server-side copies bytes to a new key with fresh metadata', async () => {
    await storage.put('a/k1', 'payload');
    await storage.copy('a/k1', 'a/k1.committed');
    const got = await storage.get('a/k1.committed');
    expect(got?.toString('utf-8')).toBe('payload');
    // Original still present.
    expect((await storage.get('a/k1'))?.toString('utf-8')).toBe('payload');
  });
});
