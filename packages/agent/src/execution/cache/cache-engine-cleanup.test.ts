import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { downloadAndExtractCache, packCachePaths } from './cache-engine.js';

// The restore's temp dirs cannot be removed, as happens while `tar` is still
// writing into a scratch dir after a failed extraction. Packing keeps the real ones.
const RESTORE_DIRS = new Set(['cache-download', 'cache-extract']);
vi.mock('@kici-dev/core/tmp', async (importOriginal) => {
  const real = await importOriginal<typeof import('@kici-dev/core/tmp')>();
  return {
    ...real,
    makeTempDir: async (label: string) => {
      const handle = await real.makeTempDir(label);
      if (!RESTORE_DIRS.has(label)) return handle;
      return {
        ...handle,
        cleanup: async () => {
          await handle.cleanup();
          throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
        },
      };
    },
  };
});

let dir: string;
let server: Server;
let url: string;
let tarball: Buffer;
let hash: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cache-cleanup-test-'));
  const src = join(dir, 'src');
  await mkdir(join(src, 'out'), { recursive: true });
  await writeFile(join(src, 'out', 'a.txt'), 'cached');
  ({ tarball, hash } = await packCachePaths(src, ['out']));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(tarball.length) });
    res.end(tarball);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  url = `http://127.0.0.1:${addr.port}/cache.tar.gz`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('downloadAndExtractCache temp-dir cleanup', () => {
  it('keeps the restore error when a temp dir cannot be removed', async () => {
    // fails-when: the cleanup's ENOTEMPTY replaces the error that explains the failure
    await expect(downloadAndExtractCache(url, join(dir, 'dest-bad'), 'deadbeef')).rejects.toThrow(
      /^Cache tarball checksum mismatch on download/,
    );
  });

  it('keeps a successful restore successful when a temp dir cannot be removed', async () => {
    // breaks-if-wrong: a restore that extracted everything still resolves
    await expect(downloadAndExtractCache(url, join(dir, 'dest-ok'), hash)).resolves.toBeUndefined();
  });
});
