/**
 * Read-side helpers for a gzip tarball that is already on disk: its SHA-256,
 * and a bounded extraction. Shared by the dependency restore and the user
 * cache / artifact restore, which both download to a file first and verify
 * before a byte is extracted.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { x as tarExtract } from 'tar';

/** SHA-256 of a file, read in one pass. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Extract a gzip tarball file into `targetDir`, bounded by `timeoutMs`. A
 * timeout rejects with `extraction did not finish within <n> ms`; `tar` may
 * still be flushing writes into `targetDir` when it does.
 */
export async function extractTarballFile(
  tarPath: string,
  targetDir: string,
  timeoutMs: number,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  try {
    await pipeline(createReadStream(tarPath), createGunzip(), tarExtract({ cwd: targetDir }), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`extraction did not finish within ${timeoutMs} ms`, { cause: err });
    }
    throw err;
  }
}
