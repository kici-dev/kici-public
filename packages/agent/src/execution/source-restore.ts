/**
 * `.kici/` source tarball restoration for execution agents.
 *
 * Downloads a pre-built `.kici/` source tarball from the orchestrator's cache
 * and extracts it into `workDir/` so the workflow entry point becomes
 * importable. Mirrors the shape of `dep-restore.ts` but without the streaming
 * optimization — source tarballs are tiny (kilobytes, not the hundreds of
 * megabytes a `node_modules/` tarball carries).
 *
 * Note on integrity: `dispatch.sourceTarHash` is the workflow `contentHash`
 * (computed over the raw source per `workflow-loader.ts::computeContentHash`),
 * not the SHA-256 of the tarball bytes. The shared S3 cache key is derived
 * from that same contentHash, so a signed GET URL from the orchestrator
 * already establishes provenance for restored tarballs. Every
 * `loadWorkflowSource` call site — build, init, and dynamic eval — passes
 * the dispatched `contentHash` (and `resolvedHashFiles` when present) so
 * the lock-vs-source drift gate fires at each author-TS load site, not
 * only the build phase. That closes the corner cases where init or eval
 * runs without a preceding build (cache infrastructure unavailable, or a
 * build job that failed but left dynamic dispatch in flight).
 */

import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
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

export async function restoreSource(workDir: string, sourceTarUrl: string): Promise<void> {
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

  await extractSourceTarball(data, workDir);

  const durationMs = Date.now() - startTime;
  logger.info('.kici/ source restored', {
    sizeKB: (data.length / 1024).toFixed(2),
    durationMs,
  });
}
