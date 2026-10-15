/**
 * Helpers for an on-disk gzip tarball, shared by the dependency restore and the
 * cache / artifact restore, which both download to a file and verify it before
 * extracting a byte.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { x as tarExtract } from 'tar';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * A timeout rejects with `extraction did not finish within <n> ms` while `tar`
 * may still be writing into `targetDir`.
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
