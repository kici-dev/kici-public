/**
 * `.kici/` source tarball creation for build agents.
 *
 * After cloning a customer repo, packs the `.kici/` directory (excluding
 * `node_modules/` — that lives in its own cached tarball per `dep-packer.ts`)
 * into a deterministic gzip tarball. The tarball bytes are hashed for
 * integrity verification on the execution-job side.
 *
 * The returned hash is the tarball's OWN digest. The orchestrator stores the
 * object under it and the restoring agent verifies the downloaded bytes against
 * it, the same contract the dependency tarball has always had; a separate
 * pointer resolves the workflow `contentHash` to it.
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

  // The filter excludes node_modules/ (already in the deps tarball). The prefix
  // is the one `hashKiciSourceTree` skips, so the digest and the tarball cover
  // the same set of files rather than two strings that must be kept in step.
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
