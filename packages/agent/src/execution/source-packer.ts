/**
 * `.kici/` source tarball creation for build agents.
 *
 * After cloning a customer repo, packs the `.kici/` directory (excluding
 * `node_modules/` — that lives in its own cached tarball per `dep-packer.ts`)
 * into a deterministic gzip tarball. The tarball bytes are hashed for
 * integrity verification on the execution-job side.
 *
 * The artifact is content-addressed by the compiler's `contentHash` (hash of
 * the raw workflow entry + asset digest), not by the tarball bytes — so the
 * orchestrator's cache lookup keys unchanged while the stored bytes switch
 * from a Rolldown bundle to a raw-source tarball.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { createLogger, sha256 } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'source-packer' });

export async function packKiciSource(workDir: string): Promise<{ tarball: Buffer; hash: string }> {
  const kiciDir = join(workDir, '.kici');
  if (!existsSync(kiciDir)) {
    throw new Error(`.kici/ not found at ${kiciDir}`);
  }

  logger.info('Packing .kici/ source tarball', { dir: workDir });
  const startTime = Date.now();

  // portable: strips user/group info + mtime for cross-machine determinism.
  // filter: exclude node_modules/ (already in the deps tarball).
  const stream = tarCreate(
    {
      gzip: true,
      cwd: workDir,
      portable: true,
      filter: (filePath) => !filePath.startsWith('.kici/node_modules'),
    },
    ['.kici'],
  );

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarball = Buffer.concat(chunks);

  const hash = sha256(tarball);

  const sizeKB = (tarball.length / 1024).toFixed(2);
  const durationMs = Date.now() - startTime;
  logger.info('.kici/ source packed', { sizeKB, hash: hash.slice(0, 12), durationMs });

  return { tarball, hash };
}
