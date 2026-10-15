/**
 * Packs a cloned repo's `.kici/` (minus `node_modules/`, which `dep-packer.ts`
 * packs) into a gzip tarball. Entry mtimes are kept, so it is not
 * byte-reproducible (`tar-pack.ts`).
 *
 * The returned hash is the tarball's OWN digest: the orchestrator stores the
 * object under it and the restoring agent verifies the download against it, as
 * for the dependency tarball; a separate pointer maps the workflow
 * `contentHash` to it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@kici-dev/shared';
import { KICI_SOURCE_EXCLUDED_PREFIX } from '@kici-dev/core/kici-source-digest';
import { packGzipTarball } from './tar-pack.js';

const logger = createLogger({ prefix: 'source-packer' });

export async function packKiciSource(workDir: string): Promise<{ tarball: Buffer; hash: string }> {
  const kiciDir = join(workDir, '.kici');
  if (!existsSync(kiciDir)) {
    throw new Error(`.kici/ not found at ${kiciDir}`);
  }

  logger.info('Packing .kici/ source tarball', { dir: workDir });
  const startTime = Date.now();

  // The prefix `hashKiciSourceTree` skips, so digest and tarball cover the same files.
  const { tarball, hash } = await packGzipTarball(
    workDir,
    ['.kici'],
    (filePath) => !filePath.startsWith(KICI_SOURCE_EXCLUDED_PREFIX),
  );

  const sizeKB = (tarball.length / 1024).toFixed(2);
  const durationMs = Date.now() - startTime;
  logger.info('.kici/ source packed', { sizeKB, hash: hash.slice(0, 12), durationMs });

  return { tarball, hash };
}
