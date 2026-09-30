import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { downloadAndExtractCache, packCachePaths } from './cache-engine.js';

let dir: string;
let tarball: Buffer;
let hash: string;
let server: Server | undefined;
let requests = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cache-download-test-'));
  const src = join(dir, 'src');
  await mkdir(join(src, 'out'), { recursive: true });
  await writeFile(join(src, 'out', 'a.txt'), 'cached');
  // Incompressible, so the tarball is ~1 MiB on the wire and the close can race the body.
  await writeFile(join(src, 'out', 'blob.bin'), randomBytes(1024 * 1024));
  ({ tarball, hash } = await packCachePaths(src, ['out']));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** A keep-alive server that closes the connection the moment the body is written. */
async function serve(body: Buffer): Promise<string> {
  requests = 0;
  server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-length': String(body.length), etag: '"c"' });
    res.end(body, () => req.socket.end());
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  return `http://127.0.0.1:${addr.port}/cache.tar.gz`;
}

describe('downloadAndExtractCache', () => {
  it('round-trips a cache entry from a server that closes right after the response', async () => {
    // fails-when: the body is streamed into extraction through undici fetch
    const url = await serve(tarball);
    for (let i = 0; i < 20; i++) {
      const dest = join(dir, `dest-${i}`);
      await downloadAndExtractCache(url, dest, hash);
      expect(await readFile(join(dest, 'out', 'a.txt'), 'utf-8')).toBe('cached');
      expect((await stat(join(dest, 'out', 'blob.bin'))).size).toBe(1024 * 1024);
    }
  });

  it('verifies before extracting: a checksum mismatch leaves the destination untouched', async () => {
    // fails-when: extraction runs before the checksum check
    // breaks-if-wrong: a matching checksum restores (previous test)
    const url = await serve(tarball);
    const dest = join(dir, 'dest-bad');
    await expect(downloadAndExtractCache(url, dest, 'deadbeef')).rejects.toThrow(
      /^Cache tarball checksum mismatch on download: expected deadbeef, got /,
    );
    expect(requests).toBe(1);
    await expect(readdir(dest)).rejects.toThrow(/ENOENT/);
  });
});
