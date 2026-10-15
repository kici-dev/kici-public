/**
 * Installs the orchestrator-cached `.kici/` source tarball at `workDir/.kici`.
 * Unlike `dep-restore.ts` it reads into memory: source tarballs are kilobytes,
 * not hundreds of megabytes.
 *
 * **Verification.** `dispatch.sourceTarDigest` is the SHA-256 of the tarball
 * bytes, checked before extraction (as `restoreDeps` checks `depsHash`). With no
 * digest (a source not from the content-addressed cache) the restore proceeds
 * unverified.
 *
 * **Replacement, not overlay.** The result REPLACES `workDir/.kici` wholesale,
 * save for `node_modules/`, which the tarball omits and the deps restore has
 * already written. Extracting over the tree would keep a helper the author
 * deleted importable on every warm-cache run.
 */

import { mkdir, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { x as tarExtract } from 'tar';
import { createLogger } from '@kici-dev/shared';

import { downloadUrl } from './download.js';
import { resolveOrchestratorUrl } from './dep-restore.js';
import { redactUrl } from './resumable-download.js';

const logger = createLogger({ prefix: 'source-restore' });

async function extractSourceTarball(data: Buffer, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const readable = Readable.from(data);
  await new Promise<void>((resolve, reject) => {
    readable
      .pipe(tarExtract({ cwd: targetDir, gzip: true }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

/** `sourceTarUrl` is `http://`, `https://` or `file://`. */
export async function restoreSource(
  workDir: string,
  sourceTarUrl: string,
  sourceTarDigest?: string,
): Promise<void> {
  sourceTarUrl = resolveOrchestratorUrl(sourceTarUrl);
  logger.info('Restoring .kici/ source from tarball', { sourceTarUrl: redactUrl(sourceTarUrl) });
  const startTime = Date.now();

  let data: Buffer;
  if (sourceTarUrl.startsWith('file://')) {
    const localPath = fileURLToPath(sourceTarUrl);
    data = await fsPromises.readFile(localPath);
  } else if (sourceTarUrl.startsWith('http://') || sourceTarUrl.startsWith('https://')) {
    data = await downloadUrl(sourceTarUrl);
  } else {
    throw new Error(`Unsupported source tarball URL scheme: ${redactUrl(sourceTarUrl)}`);
  }

  if (sourceTarDigest) {
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== sourceTarDigest) {
      throw new Error(
        `Source tarball hash mismatch: expected ${sourceTarDigest}, got ${actual}. ` +
          `The restored source does not match what the orchestrator dispatched.`,
      );
    }
  }

  // Beside the destination, so the swap is a same-filesystem rename.
  const kiciDir = path.join(workDir, '.kici');
  const scratch = path.join(workDir, `.kici.restore-${process.pid}-${Date.now()}`);
  try {
    await extractSourceTarball(data, scratch);
    // Members are `.kici/…`; a tarball packed without the prefix falls back to
    // the scratch root rather than installing an empty directory.
    const extracted = path.join(scratch, '.kici');
    const src = (await fsPromises.stat(extracted).catch(() => null))?.isDirectory()
      ? extracted
      : scratch;
    // Every call path restores deps into `.kici/node_modules` BEFORE this, and
    // the tarball omits it (`KICI_SOURCE_EXCLUDED_PREFIX`): dropping it would
    // leave no `@kici-dev/sdk`, and the repairing inline install runs only when
    // that restore failed.
    const installedDeps = path.join(kiciDir, 'node_modules');
    if (await fsPromises.stat(installedDeps).catch(() => null)) {
      await rename(installedDeps, path.join(src, 'node_modules'));
    }
    await rm(kiciDir, { recursive: true, force: true });
    await rename(src, kiciDir);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const durationMs = Date.now() - startTime;
  logger.info('.kici/ source restored', {
    sizeKB: (data.length / 1024).toFixed(2),
    durationMs,
    verified: sourceTarDigest !== undefined,
  });
}
