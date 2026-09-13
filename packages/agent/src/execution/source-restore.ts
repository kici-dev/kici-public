/**
 * `.kici/` source tarball restoration for execution agents.
 *
 * Downloads a pre-built `.kici/` source tarball from the orchestrator's cache
 * and installs it at `workDir/.kici` so the workflow entry point becomes
 * importable. Mirrors the shape of `dep-restore.ts` but without the streaming
 * optimization — source tarballs are tiny (kilobytes, not the hundreds of
 * megabytes a `node_modules/` tarball carries).
 *
 * Two properties this path is responsible for, both of which it previously
 * lacked:
 *
 * **Verification.** `dispatch.sourceTarDigest` is the SHA-256 of the tarball's
 * own bytes, so the download is checked before anything is extracted — the same
 * contract `restoreDeps` has always had via `depsHash`. The older
 * `dispatch.sourceTarHash` field carries the workflow `contentHash` instead, so
 * it never could serve this purpose; it stays on the wire for older peers and
 * is deliberately not used as a verification input here. When no digest is
 * dispatched (an older orchestrator, or a source that did not come from the
 * content-addressed cache) the restore proceeds unverified rather than failing,
 * so a mixed-version rollout still runs.
 *
 * **Replacement, not overlay.** Extraction lands in a scratch directory and the
 * result REPLACES `workDir/.kici` wholesale, save for `node_modules/` — the one
 * directory the tarball deliberately omits, which the deps restore has already
 * written by the time this runs. Extracting over the existing tree left any file
 * the tarball no longer carries in place, so a helper the author deleted
 * survived every warm-cache run and kept being imported.
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

/**
 * Download, verify, and install the `.kici/` source tree.
 *
 * @param workDir - Root of the cloned repository; `.kici` is replaced under it
 * @param sourceTarUrl - `http://`, `https://`, or `file://` URL to the tarball
 * @param sourceTarDigest - Expected SHA-256 of the tarball bytes, when known
 */
export async function restoreSource(
  workDir: string,
  sourceTarUrl: string,
  sourceTarDigest?: string,
): Promise<void> {
  sourceTarUrl = resolveOrchestratorUrl(sourceTarUrl);
  logger.info('Restoring .kici/ source from tarball', { sourceTarUrl });
  const startTime = Date.now();

  let data: Buffer;
  if (sourceTarUrl.startsWith('file://')) {
    const localPath = fileURLToPath(sourceTarUrl);
    data = await fsPromises.readFile(localPath);
  } else if (sourceTarUrl.startsWith('http://') || sourceTarUrl.startsWith('https://')) {
    data = await downloadUrl(sourceTarUrl);
  } else {
    throw new Error(`Unsupported source tarball URL scheme: ${sourceTarUrl}`);
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

  // Extract to a scratch dir beside the destination — same filesystem, so the
  // swap below is a rename rather than a copy — then replace `.kici` wholesale.
  const kiciDir = path.join(workDir, '.kici');
  const scratch = path.join(workDir, `.kici.restore-${process.pid}-${Date.now()}`);
  try {
    await extractSourceTarball(data, scratch);
    // The tarball's members are `.kici/…`, so the extracted tree it holds is
    // `<scratch>/.kici`. Fall back to the scratch root for a tarball packed
    // without the prefix rather than installing an empty directory.
    const extracted = path.join(scratch, '.kici');
    const src = (await fsPromises.stat(extracted).catch(() => null))?.isDirectory()
      ? extracted
      : scratch;
    // Carry an already-restored dependency tree across the replacement. The
    // tarball omits `.kici/node_modules` (`KICI_SOURCE_EXCLUDED_PREFIX`), and
    // every call path restores the deps tarball into `.kici/node_modules`
    // BEFORE this runs — so deleting `.kici` wholesale strands the workflow
    // with no `@kici-dev/sdk` to import, and the inline install that would
    // repair it is skipped precisely when `depsUrl` was dispatched.
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
