/** Lazy dependency downloader tests, on a real temp dir, with no network beyond loopback. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAZY_DEPS_MIRROR_ENV, lazyDepMirrorPath, type LazyDep } from '@kici-dev/shared/lazy-deps';
import { cleanCache, getCacheBasePath } from './cache.js';
import { ensureDep, resolveDepUrl, verifyIntegrity } from './downloader.js';

const BYTES = Buffer.from('the lazy dependency bytes\n');
const OTHER_BYTES = Buffer.from('a substituted archive\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A single-file dependency, so a download needs no archive tool to extract. */
const testDep: LazyDep = {
  name: 'test-dep',
  version: '1.0.0',
  platform: 'linux',
  arch: 'x64',
  url: 'https://example.invalid/releases/download/v1.0.0/test-dep-1.0.0',
  sha256: sha(BYTES),
  extractPath: 'test-dep',
  archiveType: 'binary',
};

let tmp = '';
let cacheDir = '';
const servers: Server[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-lazy-deps-'));
  cacheDir = path.join(tmp, 'cache');
  vi.stubEnv(LAZY_DEPS_MIRROR_ENV, '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A mirror directory holding `bytes` at the dependency's mirror path; returns its file:// URL. */
function fileMirror(bytes: Buffer, dep: LazyDep = testDep): string {
  const root = path.join(tmp, 'mirror');
  const file = path.join(root, ...lazyDepMirrorPath(dep).split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return pathToFileURL(root).href;
}

/** An HTTP mirror on loopback that serves `bytes` at every path; records each path asked. */
async function httpMirror(bytes: Buffer): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(bytes);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/lazy`, paths };
}

/** The cached file of `testDep`. */
const cachedFile = () => path.join(cacheDir, 'test-dep', '1.0.0', 'test-dep');

describe('resolveDepUrl', () => {
  it('a mirror rewrites the URL to name/version/variant/basename', () => {
    for (const mirror of ['http://mirror.internal/lazy', 'http://mirror.internal/lazy/']) {
      expect(resolveDepUrl(testDep, mirror)).toBe(
        'http://mirror.internal/lazy/test-dep/1.0.0/linux-x64/test-dep-1.0.0',
      );
    }
    expect(resolveDepUrl(testDep, 'file:///srv/lazy')).toBe(
      'file:///srv/lazy/test-dep/1.0.0/linux-x64/test-dep-1.0.0',
    );
  });

  it('no mirror keeps the registry URL', () => {
    // breaks-if-wrong: an install with no mirror must keep downloading from the registry URL
    for (const mirror of [undefined, '', '  ']) {
      expect(resolveDepUrl(testDep, mirror)).toBe(testDep.url);
    }
  });

  it('a mirror that is not an http(s) or file URL is refused', () => {
    // fails-when: a typo in the setting silently falls back to the internet
    expect(() => resolveDepUrl(testDep, 'ftp://mirror.internal/lazy')).toThrow(
      /KICI_LAZY_DEPS_MIRROR must be an http:\/\/, https:\/\/ or file:\/\/ URL/,
    );
    expect(() => resolveDepUrl(testDep, 'mirror.internal/lazy')).toThrow(
      /KICI_LAZY_DEPS_MIRROR is not a URL/,
    );
  });
});

describe('ensureDep', () => {
  it('returns the cached path on a cache hit, with no download', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    fs.mkdirSync(path.join(cacheDir, 'test-dep', '1.0.0'), { recursive: true });
    expect(await ensureDep(testDep, cacheDir)).toBe(path.join(cacheDir, 'test-dep', '1.0.0'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no mirror keeps the registry URL', async () => {
    // breaks-if-wrong: with the setting unset, the download goes to the registry URL as before
    const fetchSpy = vi.fn(async () => new Response(BYTES));
    vi.stubGlobal('fetch', fetchSpy);
    await ensureDep(testDep, cacheDir);
    expect(fetchSpy).toHaveBeenCalledWith(testDep.url, { redirect: 'follow' });
    expect(fs.readFileSync(cachedFile())).toEqual(BYTES);
  });

  it('a file:// mirror is read from disk', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const mirror = fileMirror(BYTES);
    expect(await ensureDep(testDep, cacheDir, { mirror })).toBe(
      path.join(cacheDir, 'test-dep', '1.0.0'),
    );
    expect(fs.readFileSync(cachedFile())).toEqual(BYTES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an http mirror is asked for the mirror path', async () => {
    const mirror = await httpMirror(BYTES);
    await ensureDep(testDep, cacheDir, { mirror: mirror.url });
    expect(mirror.paths).toEqual(['/lazy/test-dep/1.0.0/linux-x64/test-dep-1.0.0']);
    expect(fs.readFileSync(cachedFile())).toEqual(BYTES);
  });

  it('KICI_LAZY_DEPS_MIRROR names the mirror when the caller passes none', async () => {
    vi.stubEnv(LAZY_DEPS_MIRROR_ENV, fileMirror(BYTES));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await ensureDep(testDep, cacheDir);
    expect(fs.readFileSync(cachedFile())).toEqual(BYTES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a mirror serving wrong bytes fails the SHA-256 check', async () => {
    // fails-when: a mirror substitutes an archive, and it is cached as the dependency
    const fileUrl = fileMirror(OTHER_BYTES);
    await expect(ensureDep(testDep, cacheDir, { mirror: fileUrl })).rejects.toThrow(
      'SHA-256 integrity check failed',
    );
    const http = await httpMirror(OTHER_BYTES);
    await expect(ensureDep(testDep, cacheDir, { mirror: http.url })).rejects.toThrow(
      'SHA-256 integrity check failed',
    );
    expect(fs.existsSync(path.join(cacheDir, 'test-dep', '1.0.0'))).toBe(false);
  });

  it('a mirror missing the file names the path it read', async () => {
    const mirror = pathToFileURL(path.join(tmp, 'empty-mirror')).href;
    await expect(ensureDep(testDep, cacheDir, { mirror })).rejects.toThrow(
      /Read failed: ENOENT for .*empty-mirror\/test-dep\/1\.0\.0\/linux-x64\/test-dep-1\.0\.0/,
    );
  });
});

describe('a zip dependency', () => {
  /** A zip archive holding `entries`, and a dependency on it whose SHA-256 matches. */
  async function zipDep(entries: Record<string, Buffer>): Promise<{ dep: LazyDep; bytes: Buffer }> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(entries)) zip.file(name, content);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const dep: LazyDep = {
      ...testDep,
      name: 'zip-dep',
      url: 'https://example.invalid/releases/download/v1.0.0/zip-dep-1.0.0.zip',
      sha256: sha(bytes),
      extractPath: 'tool.exe',
      archiveType: 'zip',
    };
    return { dep, bytes };
  }

  it('is extracted with no unzip on the host', async () => {
    // breaks-if-wrong: a host with no unzip binary must still cache a zip dependency
    vi.stubEnv('PATH', '/nonexistent');
    const { dep, bytes } = await zipDep({ 'tool.exe': BYTES, 'docs/README.txt': OTHER_BYTES });
    const dir = await ensureDep(dep, cacheDir, { mirror: fileMirror(bytes, dep) });
    expect(fs.readFileSync(path.join(dir, 'tool.exe'))).toEqual(BYTES);
    expect(fs.readFileSync(path.join(dir, 'docs', 'README.txt'))).toEqual(OTHER_BYTES);
  });

  it('an entry that leaves the extract dir is refused', async () => {
    const { dep, bytes } = await zipDep({ '../escaped.txt': BYTES });
    // JSZip lists the parent folder of ../escaped.txt as an entry of its own, which is refused
    // first; either entry is outside the extract dir.
    await expect(ensureDep(dep, cacheDir, { mirror: fileMirror(bytes, dep) })).rejects.toThrow(
      /zip entry leaves the extract dir: /,
    );
    expect(fs.existsSync(path.join(cacheDir, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'zip-dep', '1.0.0'))).toBe(false);
  });
});

describe('verifyIntegrity', () => {
  it('rejects on SHA-256 mismatch', () => {
    expect(() => verifyIntegrity(BYTES, 'wrong-hash-value')).toThrow(
      'SHA-256 integrity check failed',
    );
  });

  it('passes with the correct hash', () => {
    expect(() => verifyIntegrity(BYTES, sha(BYTES))).not.toThrow();
  });
});

describe('cache', () => {
  it('getCacheBasePath returns a path', () => {
    expect(getCacheBasePath().length).toBeGreaterThan(0);
  });

  it('cleanCache removes the directory when it exists, and ignores a missing one', () => {
    fs.mkdirSync(path.join(tmp, 'c', 'x'), { recursive: true });
    cleanCache(path.join(tmp, 'c'));
    expect(fs.existsSync(path.join(tmp, 'c'))).toBe(false);
    expect(() => cleanCache(path.join(tmp, 'missing'))).not.toThrow();
  });
});
