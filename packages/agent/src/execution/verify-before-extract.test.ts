/**
 * Both tarball restores check the SHA-256 before a byte is extracted. The
 * served bytes are not gzip, so an extraction that ran first would fail with a
 * gunzip error instead of the mismatch, and the spy records every extraction.
 * Asserting on the destination alone cannot tell the two orders apart: both
 * restores extract into a scratch dir that is removed whatever happens.
 */
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractTarballFile } from './tarball-file.js';
import { restoreDeps } from './dep-restore.js';
import { DepRestoreError, DepTarballHashMismatchError } from './dep-restore-errors.js';
import { DepRestoreOutcome } from './dep-restore-report.js';
import { downloadAndExtractCache } from './cache/cache-engine.js';

vi.mock('./tarball-file.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tarball-file.js')>();
  return { ...real, extractTarballFile: vi.fn(real.extractTarballFile) };
});

const BODY = Buffer.from('not a gzip stream');
const BODY_HASH = createHash('sha256').update(BODY).digest('hex');

let dir: string;
let server: Server;
let url: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verify-before-extract-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(BODY.length) });
    res.end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  url = `http://127.0.0.1:${addr.port}/x.tar.gz`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(extractTarballFile).mockClear();
});

async function workDir(name: string): Promise<string> {
  const d = join(dir, name);
  await mkdir(join(d, '.kici'), { recursive: true });
  return d;
}

describe('dependency restore', () => {
  it('rejects a mismatch without extracting', async () => {
    // fails-when: extraction runs before the SHA-256 check
    const err = await restoreDeps(await workDir('dep-bad'), url, 'deadbeef').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DepTarballHashMismatchError);
    expect(extractTarballFile).not.toHaveBeenCalled();
  });

  it('extracts the same bytes when the hash matches', async () => {
    // breaks-if-wrong: a verified tarball must still reach extraction
    const err = await restoreDeps(await workDir('dep-ok'), url, BODY_HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DepRestoreError);
    expect((err as DepRestoreError).report.outcome).toBe(DepRestoreOutcome.enum['extract-failed']);
    expect(extractTarballFile).toHaveBeenCalledTimes(1);
  });
});

describe('user cache and artifact restore', () => {
  it('rejects a mismatch without extracting', async () => {
    // fails-when: extraction runs before the SHA-256 check
    await expect(downloadAndExtractCache(url, join(dir, 'cache-bad'), 'deadbeef')).rejects.toThrow(
      /^Cache tarball checksum mismatch on download/,
    );
    expect(extractTarballFile).not.toHaveBeenCalled();
  });

  it('extracts the same bytes when the checksum matches', async () => {
    // breaks-if-wrong: a verified tarball must still reach extraction
    await expect(downloadAndExtractCache(url, join(dir, 'cache-ok'), BODY_HASH)).rejects.toThrow();
    expect(extractTarballFile).toHaveBeenCalledTimes(1);
  });
});
