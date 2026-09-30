/**
 * Dependency restoration from cached tarballs.
 *
 * Three phases, in this order, never overlapping:
 *
 * 1. **Download** the tarball into a file at network speed
 *    (`resumable-download.ts`): retried, resumed with a `Range` request after
 *    a cut, each attempt bounded on its own. A `file://` URL is read in place.
 * 2. **Verify** the file's SHA-256 against the dispatched hash. Nothing is
 *    extracted from unverified bytes, and a mismatch is final: the key is
 *    content-addressed, so a second download would read the same bytes.
 * 3. **Extract** from the file into a scratch dir under a time bound, then
 *    move the tree into the repository.
 *
 * Downloading first matters because extraction (tens of thousands of small
 * files) is far slower than the network: a body streamed straight into `tar`
 * would hold the connection open for the whole extraction, and an object store
 * that closes it meanwhile fails the restore.
 *
 * The temp root is a sibling of `.kici/` at the repository root, never inside
 * it: the workflow `contentHash` walks `.kici/`, so a leftover there would
 * change it.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises';
import { createLogger } from '@kici-dev/shared';
import {
  DEFAULT_DOWNLOAD_LIMITS,
  DownloadFailedError,
  describeError,
  downloadToFile,
  elapsedMs,
  redactUrl,
  type DownloadLimits,
  type NextAttempt,
  type DownloadAttempt,
} from './resumable-download.js';
import {
  DepRestoreOutcome,
  clipDescribedError,
  formatAttemptFailure,
  logDepRestoreReport,
  type DepRestoreReport,
} from './dep-restore-report.js';
import { DepRestoreError, DepTarballHashMismatchError } from './dep-restore-errors.js';
import { extractTarballFile, sha256File } from './tarball-file.js';

const logger = createLogger({ prefix: 'dep-restore' });

/** Download bounds plus the bound on extraction. */
export interface DepRestoreLimits extends DownloadLimits {
  /**
   * Gunzip + tar extraction from the downloaded file. Matches the inline
   * install bound (`INSTALL_TIMEOUT_MS`, 10 min): an extraction slower than
   * installing from the registry is not worth waiting for.
   */
  extractTimeoutMs: number;
}

export const DEFAULT_DEP_RESTORE_LIMITS: DepRestoreLimits = {
  ...DEFAULT_DOWNLOAD_LIMITS,
  extractTimeoutMs: 10 * 60 * 1000,
};

export interface RestoreDepsOptions {
  /** Test override of {@link DEFAULT_DEP_RESTORE_LIMITS}. */
  limits?: Partial<DepRestoreLimits>;
  /** Receives one human line per failed download attempt, as it happens. */
  onProgress?: (line: string) => void;
}

/**
 * Basename prefix of the per-restore temp root at the repository root. The
 * clone phase registers {@link SCRATCH_DIR_GIT_EXCLUDE_GLOB} in
 * `.git/info/exclude`, so the glob and the prefix are defined together.
 */
const TEMP_ROOT_PREFIX = '.kici-dep-restore-';

/**
 * `.git/info/exclude` pattern matching every temp root {@link restoreDeps}
 * creates, anchored at the repository root.
 */
export const SCRATCH_DIR_GIT_EXCLUDE_GLOB = `/${TEMP_ROOT_PREFIX}*`;

/**
 * Append `SCRATCH_DIR_GIT_EXCLUDE_GLOB` to `${repoWorkDir}/.git/info/exclude`
 * so an in-flight or leftover dep-restore temp root is invisible to
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
 *   global workflows it is the workflow repo dir (whose `.kici/` the restore
 *   fills).
 */
export async function excludeScratchFromGit(repoWorkDir: string): Promise<void> {
  const excludePath = join(repoWorkDir, '.git', 'info', 'exclude');
  try {
    const existing = await fsPromises.readFile(excludePath, 'utf-8').catch(() => '');
    const alreadyPresent = existing
      .split('\n')
      .some((line) => line.trim() === SCRATCH_DIR_GIT_EXCLUDE_GLOB);
    if (alreadyPresent) return;
    const suffix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await fsPromises.appendFile(
      excludePath,
      `${suffix}# kici: hide dep-restore temp dirs from customer git status\n${SCRATCH_DIR_GIT_EXCLUDE_GLOB}\n`,
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

/**
 * Remove the temp root. After a failed extraction `tar` may still be flushing
 * writes into it, which `rm` meets as `ENOTEMPTY`; `maxRetries` absorbs that.
 * A leftover sits outside `.kici/`, is hidden from git, and goes with the job
 * workdir.
 */
async function removeTempRoot(tempRoot: string): Promise<void> {
  try {
    await fsPromises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    logger.warn('Dep restore temp dir cleanup failed (left behind)', {
      tempRoot,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toReportAttempt(a: DownloadAttempt): DepRestoreReport['attempts'][number] {
  return { ...a, ...(a.error && { error: clipDescribedError(a.error) }) };
}

/**
 * Restore dependencies from a cached tarball into the cloned repo.
 *
 * The tarball is packed repo-root-relative (see `dep-packer.ts`): every manager
 * carries `.kici/node_modules`; pnpm additionally carries the root
 * `node_modules/.pnpm` store and the in-repo workspace siblings `.kici`
 * resolves.
 *
 * Resolves with the restore's report; rejects with a {@link DepRestoreError}
 * (a {@link DepTarballHashMismatchError} for a hash mismatch) carrying it.
 *
 * @param workDir - Root directory of the cloned repository
 * @param depsUrl - URL to the dependency tarball (http://, https://, or file://)
 * @param depsHash - Optional expected SHA-256 hash of the tarball
 */
export async function restoreDeps(
  workDir: string,
  depsUrl: string,
  depsHash?: string,
  opts: RestoreDepsOptions = {},
): Promise<DepRestoreReport> {
  const url = resolveOrchestratorUrl(depsUrl);
  const limits = { ...DEFAULT_DEP_RESTORE_LIMITS, ...opts.limits };
  const report: DepRestoreReport = {
    outcome: DepRestoreOutcome.enum.restored,
    source: redactUrl(url),
    verified: false,
    attempts: [],
  };
  const fail = (outcome: DepRestoreOutcome, err: unknown, message?: string): DepRestoreError => {
    report.outcome = outcome;
    report.error = clipDescribedError(describeError(err));
    return new DepRestoreError(message ?? report.error.message, report, err);
  };
  logger.info('Downloading dependency tarball', { url: report.source });

  const isFile = url.startsWith('file://');
  if (!isFile && !url.startsWith('http://') && !url.startsWith('https://')) {
    const err = fail(
      DepRestoreOutcome.enum['unsupported-url'],
      new Error(`Unsupported deps URL scheme: ${report.source}`),
    );
    logDepRestoreReport(report);
    throw err;
  }

  const tempRoot = join(workDir, `${TEMP_ROOT_PREFIX}${process.pid}-${Date.now()}`);
  try {
    await mkdir(tempRoot, { recursive: true });

    // 1. Download (or read a local file in place).
    let tarPath: string;
    const downloadStart = performance.now();
    if (isFile) {
      tarPath = fileURLToPath(url);
    } else {
      tarPath = join(tempRoot, 'deps.tar.gz');
      try {
        const result = await downloadToFile(url, tarPath, {
          limits,
          onAttemptFailed: (a: DownloadAttempt, next: NextAttempt | undefined) =>
            opts.onProgress?.(formatAttemptFailure(a, limits.maxAttempts, next)),
        });
        report.attempts = result.attempts.map(toReportAttempt);
      } catch (err) {
        if (err instanceof DownloadFailedError) report.attempts = err.attempts.map(toReportAttempt);
        throw fail(
          DepRestoreOutcome.enum['download-failed'],
          err,
          `Dep tarball download failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    report.downloadMs = elapsedMs(downloadStart);
    report.tarballBytes = (await fsPromises.stat(tarPath)).size;

    // 2. Verify before a single byte is extracted.
    if (depsHash) {
      const verifyStart = performance.now();
      const actual = await sha256File(tarPath);
      report.verifyMs = elapsedMs(verifyStart);
      if (actual !== depsHash) {
        report.outcome = DepRestoreOutcome.enum['hash-mismatch'];
        const err = new DepTarballHashMismatchError(depsHash, actual, report);
        report.error = clipDescribedError(describeError(err));
        throw err;
      }
      report.verified = true;
    }

    // 3. Extract from the file, then move into place.
    const extractStart = performance.now();
    const scratchDir = join(tempRoot, 'extract');
    try {
      await extractTarballFile(tarPath, scratchDir, limits.extractTimeoutMs);
      await moveScratchIntoRepo(scratchDir, workDir);
    } catch (err) {
      throw fail(
        DepRestoreOutcome.enum['extract-failed'],
        err,
        `Dep tarball extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    report.extractMs = elapsedMs(extractStart);
    return report;
  } catch (err) {
    if (err instanceof DepRestoreError) throw err;
    // mkdir / stat failures: the restore never reached its own phases.
    throw fail(DepRestoreOutcome.enum['download-failed'], err);
  } finally {
    await removeTempRoot(tempRoot);
    logDepRestoreReport(report, { targetDir: workDir });
  }
}
