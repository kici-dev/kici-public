/**
 * The restore against the server shape that broke it: a keep-alive response
 * the server closes the moment the last byte is written, while extraction is
 * slow. Every `tar.x` in this file is throttled, so extraction takes far longer
 * than the download — the production ratio (tens of thousands of small files
 * against a ~1.5 s download).
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { x as tarExtract } from 'tar';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { restoreDeps } from './dep-restore.js';
import { DepRestoreError } from './dep-restore-errors.js';
import { DepRestoreOutcome } from './dep-restore-report.js';

vi.mock('tar', async (importOriginal) => {
  const real = await importOriginal<typeof import('tar')>();
  const { Writable } = await import('node:stream');
  /** Each chunk waits this long before the real unpacker sees it. */
  const CHUNK_DELAY_MS = 2;
  const slowX = (opts: Parameters<typeof real.x>[0]) => {
    const inner = real.x(opts as never) as unknown as NodeJS.WritableStream &
      NodeJS.EventEmitter & { destroy?: (err?: Error) => void };
    return new Writable({
      highWaterMark: 16 * 1024,
      write(chunk, _enc, cb) {
        setTimeout(() => {
          if (inner.write(chunk)) cb();
          else inner.once('drain', () => cb());
        }, CHUNK_DELAY_MS);
      },
      final(cb) {
        inner.once('error', cb);
        inner.once('close', () => cb());
        inner.end();
      },
      destroy(err, cb) {
        inner.destroy?.(err ?? undefined);
        cb(err);
      },
    });
  };
  return { ...real, x: slowX };
});

/** Rounds per test: one round loses the race about 30-60 % of the time on the old shape. */
const ROUNDS = 20;

let dir: string;
let tarball: Buffer;
let tarballHash: string;
let server: Server;
let url: string;
let requests = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dep-restore-race-'));
  const content = join(dir, 'content');
  await mkdir(join(content, '.kici', 'node_modules'), { recursive: true });
  // Random bytes do not compress, so the tarball is ~1 MiB on the wire.
  await writeFile(join(content, '.kici', 'node_modules', 'blob.bin'), randomBytes(1024 * 1024));
  execFileSync('tar', ['czf', join(dir, 'deps.tar.gz'), '-C', content, '.']);
  tarball = await readFile(join(dir, 'deps.tar.gz'));
  tarballHash = createHash('sha256').update(tarball).digest('hex');

  server = createServer((req, res) => {
    requests++;
    res.writeHead(200, {
      'content-length': String(tarball.length),
      connection: 'keep-alive',
      etag: '"deps"',
    });
    // An object store closing the idle keep-alive connection right after the response.
    res.end(tarball, () => req.socket.end());
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  url = `http://127.0.0.1:${addr.port}/deps.tar.gz`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('dep restore against a server that closes right after the response', () => {
  it('control: streaming the body into the slow extraction loses the race', async () => {
    // The body streamed into extraction (fetch -> gunzip -> tar.x), the shape
    // restoreDeps must not use. If this control stops failing, the harness no
    // longer reproduces the race and the next test proves nothing — retire both
    // deliberately, do not loosen them.
    let terminated = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const target = join(dir, `control-${i}`);
      await mkdir(target, { recursive: true });
      try {
        const res = await fetch(url);
        await pipeline(
          Readable.fromWeb(res.body as never),
          createGunzip(),
          tarExtract({ cwd: target }),
        );
      } catch (err) {
        if ((err as Error).message === 'terminated') terminated++;
      }
    }
    expect(terminated).toBeGreaterThan(0);
  });

  it('restores every round: the download finishes before extraction starts', async () => {
    // fails-when: restoreDeps streams the body into extraction, or downloads through undici fetch
    // breaks-if-wrong: the plain fast-server restores in dep-restore.test.ts keep passing
    for (let i = 0; i < ROUNDS; i++) {
      const workDir = join(dir, `work-${i}`);
      await mkdir(join(workDir, '.kici'), { recursive: true });
      const report = await restoreDeps(workDir, url, tarballHash);
      expect(report.outcome).toBe(DepRestoreOutcome.enum.restored);
      expect(report.attempts).toHaveLength(1);
      expect((await stat(join(workDir, '.kici', 'node_modules', 'blob.bin'))).size).toBe(
        1024 * 1024,
      );
      // The temp root is gone and nothing new sits inside .kici/.
      expect((await readdir(workDir)).filter((e) => e.startsWith('.kici-dep-restore-'))).toEqual(
        [],
      );
      expect(await readdir(join(workDir, '.kici'))).toEqual(['node_modules']);
    }
  });

  it('bounds extraction and never re-downloads after an extraction failure', async () => {
    // fails-when: an extraction failure retries the download, or extraction has no bound
    const workDir = join(dir, 'work-extract-timeout');
    await mkdir(join(workDir, '.kici'), { recursive: true });
    const before = requests;
    const err = await restoreDeps(workDir, url, tarballHash, {
      limits: { extractTimeoutMs: 50 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DepRestoreError);
    const report = (err as DepRestoreError).report;
    expect(report.outcome).toBe(DepRestoreOutcome.enum['extract-failed']);
    expect(report.error?.message).toContain('extraction did not finish within 50 ms');
    expect(report.verified).toBe(true);
    expect(requests - before).toBe(1);
    expect(await readdir(join(workDir, '.kici'))).toEqual([]);
  });
});
