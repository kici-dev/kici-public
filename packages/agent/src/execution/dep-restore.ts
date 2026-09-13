/**
 * Dependency restoration from cached tarballs.
 *
 * Downloads a pre-built dependency tarball, verifies SHA-256 integrity,
 * and extracts to .kici/node_modules/ in the work directory.
 *
 * HTTP/HTTPS downloads use a streaming pipeline (response -> hash transform ->
 * gunzip -> tar extract) to avoid buffering entire tarballs in memory.
 * file:// URLs use a buffer-based approach (local, no streaming benefit).
 *
 * Streaming downloads have a 5-minute timeout and up to 2 retries.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises';
import { x as tarExtract } from 'tar';
import { createLogger, sha256 } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'dep-restore' });

/** Download timeout: 5 minutes. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum number of retries for HTTP downloads (0 = no retries). */
export const MAX_RETRIES = 2;

/**
 * Compute SHA-256 hash of a buffer.
 */
function computeHash(data: Buffer): string {
  return sha256(data);
}

/**
 * Extract a gzip tarball from a buffer into the target directory.
 * Used for file:// URLs where streaming provides no benefit.
 */
async function extractTarball(data: Buffer, targetDir: string): Promise<void> {
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
 * Stream download and extract an HTTP/HTTPS tarball.
 *
 * Computes SHA-256 hash on the fly via a Transform stream.
 * Returns the computed hash of the compressed tarball data.
 */
export async function streamFetchAndExtract(url: string, targetDir: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  if (!response.body) throw new Error('No response body');

  // Cast needed: fetch() returns a DOM ReadableStream, but Readable.fromWeb()
  // expects the Node.js web stream type. They are structurally identical at runtime.
  const nodeStream = Readable.fromWeb(response.body as any);
  const hash = createHash('sha256');

  const hashTransform = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(targetDir, { recursive: true });
  await pipeline(nodeStream, hashTransform, createGunzip(), tarExtract({ cwd: targetDir }));

  return hash.digest('hex');
}

/**
 * Path-relative-to-`.kici/` glob that matches every scratch dir
 * `extractIntoScratch` may create. Surfaced so the clone phase can register
 * it in `.git/info/exclude` (see `excludeScratchFromGit`) — keeping the glob
 * and the exclude rule in the same file means future renames of the scratch
 * dir prefix can't fall out of sync with the git-ignore wiring.
 */
const SCRATCH_DIR_BASENAME_PREFIX = '.dep-restore-scratch-';

/**
 * Glob suitable for `.gitignore` / `.git/info/exclude` that matches every
 * scratch dir created by `extractIntoScratch`, anchored to the workflow
 * working tree's `.kici/` subdir.
 */
export const SCRATCH_DIR_GIT_EXCLUDE_GLOB = `.kici/${SCRATCH_DIR_BASENAME_PREFIX}*`;

/**
 * Extract the dep tarball into a per-attempt scratch dir so retries never race
 * with still-draining I/O from a previous failed attempt.
 *
 * When `pipeline()` rejects on a network error or AbortSignal timeout, the
 * underlying `tar.x` continues flushing pending file writes for an unbounded
 * window after the promise settles — `pipeline` does not block on async
 * filesystem side effects. If the next retry then runs `rm -rf` on the same
 * `node_modules/`, the walk races with those writes and `rmdir` fails with
 * ENOTEMPTY (new files keep appearing under a directory we just emptied).
 *
 * We sidestep the race entirely by extracting each attempt into a unique
 * scratch dir under `.kici/`. Failed attempts leave orphan scratch dirs whose
 * draining writes are harmless — the next attempt does not touch them. On
 * success `moveScratchIntoRepo` renames the extracted entries into place
 * (atomic on the same filesystem), then best-effort cleans the scratch dir.
 *
 * Scratch dirs land inside the customer's cloned working tree, so the clone
 * phase registers `SCRATCH_DIR_GIT_EXCLUDE_GLOB` in `.git/info/exclude` to
 * keep them out of `git status` for any workflow step that shells out to git.
 * See `excludeScratchFromGit`.
 */
async function extractIntoScratch(
  url: string,
  kiciDir: string,
  attempt: number,
): Promise<{ scratchDir: string; hash: string }> {
  const scratchDir = join(
    kiciDir,
    `${SCRATCH_DIR_BASENAME_PREFIX}${process.pid}-${attempt}-${Date.now()}`,
  );
  await mkdir(scratchDir, { recursive: true });
  const hash = await streamFetchAndExtract(url, scratchDir);
  return { scratchDir, hash };
}

/**
 * Append `SCRATCH_DIR_GIT_EXCLUDE_GLOB` to `${repoWorkDir}/.git/info/exclude`
 * so any in-flight or orphaned dep-restore scratch dirs are invisible to
 * `git status` / `git add` inside the customer's cloned working tree.
 *
 * Why `.git/info/exclude` and not `.gitignore`:
 * - `.gitignore` lives in the customer's repo and is committed; we MUST NOT
 *   modify it. Doing so would surface the rule in their PRs and create a
 *   diff customers never asked for.
 * - `.git/info/exclude` is per-clone, on-disk only, and exactly the git
 *   mechanism for "ignore these patterns in THIS working tree". Git creates
 *   an empty (template-commented) file on `git init` / `git clone`, so it
 *   already exists by the time we're called.
 *
 * Why this lives next to `extractIntoScratch`:
 * - The exclude glob is tied 1:1 to the scratch dir naming convention. If
 *   the prefix ever changes, the rule must change too. Defining both in the
 *   same file means a rename touches one place, not two.
 *
 * Best-effort: if the exclude file is missing (e.g. caller sandbox blocked
 * `git clone` and the dir layout differs) we log and continue — failing the
 * job over a missing git ignore wiring would be worse than the cosmetic
 * issue we're solving.
 *
 * Idempotent: callers may invoke this multiple times (dual-clone path, retry
 * after partial setup). We skip the append if the glob is already present.
 *
 * @param repoWorkDir - The git working tree root (the dir that contains
 *   `.git/`). For normal workflows this is the agent's job workDir; for
 *   global workflows it is the workflow repo dir (whose `.kici/` carries
 *   the scratch dirs).
 */
export async function excludeScratchFromGit(repoWorkDir: string): Promise<void> {
  const excludePath = join(repoWorkDir, '.git', 'info', 'exclude');
  try {
    const existing = await fsPromises.readFile(excludePath, 'utf-8').catch(() => '');
    // Match the bare glob, ignoring leading whitespace/comments, so we treat
    // an existing entry the same regardless of surrounding template content.
    const alreadyPresent = existing
      .split('\n')
      .some((line) => line.trim() === SCRATCH_DIR_GIT_EXCLUDE_GLOB);
    if (alreadyPresent) return;
    const suffix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await fsPromises.appendFile(
      excludePath,
      `${suffix}# kici: hide dep-restore scratch dirs from customer git status\n${SCRATCH_DIR_GIT_EXCLUDE_GLOB}\n`,
    );
  } catch (err) {
    logger.warn('Failed to register scratch dir glob in .git/info/exclude', {
      excludePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Rewrite localhost URLs to use the orchestrator host.
 *
 * The orchestrator rewrites file:// cache URLs to http://localhost:PORT/...
 * but agent containers can't reach localhost. This utility replaces the
 * host with the orchestrator's host derived from KICI_ORCHESTRATOR_URL.
 */
export function resolveOrchestratorUrl(url: string): string {
  if (!url.match(/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/)) return url;

  const orchestratorUrl = process.env.KICI_ORCHESTRATOR_URL;
  if (!orchestratorUrl) return url;

  try {
    const orchestratorParsed = new URL(
      orchestratorUrl.replace(/^ws/, 'http'), // ws:// -> http://, wss:// -> https://
    );
    const parsed = new URL(url);
    parsed.hostname = orchestratorParsed.hostname;
    // Keep the original port (orchestrator HTTP port), not the WS port
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Move a fully-extracted scratch tree into the cloned repo. The dep tarball is
 * packed repo-root-relative, so the scratch holds repo-root entries:
 * `.kici/node_modules` for every manager, plus (for pnpm) the root
 * `node_modules/.pnpm` store and in-repo workspace sibling dirs. `.kici/` itself
 * already exists in the work tree (cloned or source-restored), so its children
 * are moved individually; every other top-level entry is moved wholesale.
 *
 * On a cache-hit execution agent the destinations do not pre-exist (source
 * restore excludes node_modules and never carries sibling dirs), so the renames
 * have nothing to race; the defensive `rm` covers re-runs.
 */
async function moveScratchIntoRepo(scratchDir: string, workDir: string): Promise<void> {
  for (const child of await fsPromises.readdir(scratchDir)) {
    if (child === '.kici') {
      const kiciScratch = join(scratchDir, '.kici');
      for (const sub of await fsPromises.readdir(kiciScratch)) {
        await moveInto(join(kiciScratch, sub), join(workDir, '.kici', sub));
      }
    } else {
      await moveInto(join(scratchDir, child), join(workDir, child));
    }
  }
}

/** Move `src` to `dest`, creating the parent and clearing any stale dest. */
async function moveInto(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await fsPromises.rm(dest, { recursive: true, force: true });
  await fsPromises.rename(src, dest);
}

/** Best-effort cleanup of a settled scratch dir; logs and continues on failure. */
async function cleanupScratch(scratchDir: string): Promise<void> {
  try {
    await fsPromises.rm(scratchDir, { recursive: true, force: true });
  } catch (cleanupErr) {
    logger.warn('Scratch dir cleanup failed (orphan left behind)', {
      scratchDir,
      error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    });
  }
}

/**
 * Restore dependencies from a cached tarball into the cloned repo.
 *
 * The tarball is packed repo-root-relative (see `dep-packer.ts`): every manager
 * carries `.kici/node_modules`; pnpm additionally carries the root
 * `node_modules/.pnpm` store and the in-repo workspace siblings `.kici` resolves.
 * Restore extracts into a scratch dir, then moves each entry into place — one
 * code path for all managers.
 *
 * For HTTP/HTTPS URLs: a streaming pipeline (response -> hash -> gunzip -> tar)
 * with a 5-minute timeout and up to 2 retries avoids buffering whole tarballs.
 * For file:// URLs: a buffer-based approach (local, no streaming benefit).
 *
 * @param workDir - Root directory of the cloned repository
 * @param depsUrl - URL to the dependency tarball (http://, https://, or file://)
 * @param depsHash - Optional expected SHA-256 hash of the tarball
 */
export async function restoreDeps(
  workDir: string,
  depsUrl: string,
  depsHash?: string,
): Promise<void> {
  // Rewrite localhost URLs for container agents
  depsUrl = resolveOrchestratorUrl(depsUrl);
  logger.info('Downloading dependency tarball', { url: depsUrl });

  const kiciDir = join(workDir, '.kici');

  if (depsUrl.startsWith('file://')) {
    // file:// URLs: keep buffer-based approach (local, no streaming benefit)
    const localPath = fileURLToPath(depsUrl);
    const data = await fsPromises.readFile(localPath);
    if (depsHash) {
      const actualHash = computeHash(data);
      if (actualHash !== depsHash) {
        throw new Error(`Dep tarball hash mismatch: expected ${depsHash}, got ${actualHash}`);
      }
    }
    const scratchDir = join(
      kiciDir,
      `${SCRATCH_DIR_BASENAME_PREFIX}${process.pid}-file-${Date.now()}`,
    );
    await extractTarball(data, scratchDir);
    await moveScratchIntoRepo(scratchDir, workDir);
    await cleanupScratch(scratchDir);
    const sizeMB = (data.length / (1024 * 1024)).toFixed(2);
    logger.info('Dependencies restored from cache (file)', { sizeMB, targetDir: workDir });
    return;
  }

  if (!depsUrl.startsWith('http://') && !depsUrl.startsWith('https://')) {
    throw new Error(`Unsupported deps URL scheme: ${depsUrl}`);
  }

  // HTTP/HTTPS: streaming with retry. Each attempt extracts into its own
  // scratch dir to avoid racing with in-flight tar writes from a prior
  // failed attempt — see `extractIntoScratch` for the full rationale.
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      logger.warn('Retrying dep tarball download', { attempt, url: depsUrl });
    }
    try {
      const { scratchDir, hash } = await extractIntoScratch(depsUrl, kiciDir, attempt);

      if (depsHash && hash !== depsHash) {
        throw new Error(`Dep tarball hash mismatch: expected ${depsHash}, got ${hash}`);
      }

      // Move the extracted repo-root-relative tree into the work dir. The
      // destinations never exist before this point (we always extract into a
      // fresh scratch dir), so the renames have nothing to race against.
      await moveScratchIntoRepo(scratchDir, workDir);
      await cleanupScratch(scratchDir);

      logger.info('Dependencies restored from cache (stream)', { targetDir: workDir });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn('Dep tarball download failed', {
        attempt,
        error: lastError.message,
      });
      // Intentionally do NOT clean up the scratch dir on failure: pipeline()
      // rejection does not drain tar's pending fs writes, so an immediate rm
      // would race them. Leaving the scratch dir orphaned is safe — the next
      // retry uses a different scratch dir and the workflow's tmp workDir is
      // wiped at job teardown.
    }
  }

  throw new Error(
    `Dep tarball download failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
  );
}
