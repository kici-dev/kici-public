/**
 * Materialize an isolated tmp checkout of the repo for `kici run local`.
 *
 * Reproduces the same workspace `kici run remote` reconstructs on the agent:
 * a clone checked out at HEAD, with the local overlay (dirty + untracked,
 * minus gitignored, with `.kiciignore` applied) copied on top and local
 * deletions removed. Steps then execute against this copy so the developer's
 * real working tree is never mutated.
 *
 * Secrets are NOT part of the overlay: gitignored files such as
 * `.kici/.env.local` are excluded by the shared selection, so the tmp checkout
 * never receives them — the run reads them from the original `.kici/`.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@kici-dev/core';
import { gcStaleTmpDirs } from '@kici-dev/core/tmp-gc';
import { selectOverlayFiles } from '../remote/uploader.js';

/**
 * A materialized isolated checkout.
 */
export interface MaterializedCheckout {
  /** Absolute path to the tmp checkout directory */
  path: string;
  /** Remove the tmp checkout directory */
  cleanup: () => Promise<void>;
}

/**
 * Options for {@link materializeCheckout}.
 */
export interface MaterializeOptions {
  /** Base directory for the tmp checkout (default: os.tmpdir()) */
  runDir?: string;
}

/** Max number of overlay files copied concurrently. */
const COPY_BATCH_SIZE = 32;

/**
 * Materialize the repo at `repoRoot` into an isolated tmp checkout.
 *
 * @param repoRoot - Path to the git repository root
 * @param opts - Optional configuration (tmp base directory)
 * @returns The tmp checkout path and a cleanup callback
 * @throws If `repoRoot` is not inside a git work tree
 */
export async function materializeCheckout(
  repoRoot: string,
  opts?: MaterializeOptions,
): Promise<MaterializedCheckout> {
  requireGitRepo(repoRoot);

  const base = opts?.runDir ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const tmpDir = path.join(base, `kici-run-${randomBytes(3).toString('hex')}`);

  const { sha, existingFiles, deletedFiles } = await selectOverlayFiles(repoRoot);

  // Base tree at HEAD: local clone then pin to the exact SHA. `--no-hardlinks`
  // copies the object store instead of hardlinking it — hardlinks cannot span
  // filesystems, and the common case (repo under $HOME, tmp under /tmp on a
  // separate mount) would otherwise fail with "Invalid cross-device link".
  execSync(`git clone --no-hardlinks --quiet ${shellQuote(repoRoot)} ${shellQuote(tmpDir)}`, {
    stdio: 'ignore',
  });
  execSync(`git checkout --quiet ${sha}`, { cwd: tmpDir, stdio: 'ignore' });

  await applyOverlay(repoRoot, tmpDir, existingFiles, deletedFiles);

  return {
    path: tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Checkouts retained for inspection (failed runs, --keep) stay around this
 * long before the next `kici run local` invocation collects them.
 */
const RUN_CHECKOUT_GC_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** Matches the kici-run-<6 hex> dirs materializeCheckout creates — nothing else. */
const RUN_CHECKOUT_PATTERN = /^kici-run-[0-9a-f]{6}$/;

/**
 * Collect stale retained checkouts under the run base. Invoked on every
 * `kici run local`; never throws (the GC must not break the run).
 */
export async function gcStaleRunCheckouts(base: string): Promise<string[]> {
  return gcStaleTmpDirs({
    base,
    pattern: RUN_CHECKOUT_PATTERN,
    maxAgeMs: RUN_CHECKOUT_GC_MAX_AGE_MS,
    log: (m) => logger.debug(m),
  });
}

/**
 * Throw an actionable error if `repoRoot` is not a git work tree.
 */
function requireGitRepo(repoRoot: string): void {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    throw new Error(
      `kici run local needs a git repository to build an isolated checkout, but ` +
        `"${repoRoot}" is not inside a git work tree. Initialize a repo, or re-run ` +
        `with --in-place to execute against the working directory directly.`,
    );
  }
}

/**
 * Copy the overlay files onto the clone and remove local deletions.
 */
async function applyOverlay(
  repoRoot: string,
  tmpDir: string,
  existingFiles: string[],
  deletedFiles: string[],
): Promise<void> {
  for (let i = 0; i < existingFiles.length; i += COPY_BATCH_SIZE) {
    const batch = existingFiles.slice(i, i + COPY_BATCH_SIZE);
    await Promise.all(batch.map((file) => copyOverlayFile(repoRoot, tmpDir, file)));
  }

  for (let i = 0; i < deletedFiles.length; i += COPY_BATCH_SIZE) {
    const batch = deletedFiles.slice(i, i + COPY_BATCH_SIZE);
    await Promise.all(batch.map((file) => fs.rm(path.join(tmpDir, file), { force: true })));
  }
}

/**
 * Copy a single overlay file, preserving its mode (e.g. the exec bit).
 *
 * Symlinks are recreated as links rather than dereferenced — the same shape the
 * remote path's tarball preserves. Following them would copy the link target's
 * content (and a directory symlink such as `node_modules/@scope/pkg` would
 * throw `EISDIR`), losing the link identity the workspace relies on.
 */
async function copyOverlayFile(repoRoot: string, tmpDir: string, file: string): Promise<void> {
  const src = path.join(repoRoot, file);
  const dest = path.join(tmpDir, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const srcStat = await fs.lstat(src);
  if (srcStat.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.rm(dest, { force: true });
    await fs.symlink(target, dest);
    return;
  }

  await fs.copyFile(src, dest);
  await fs.chmod(dest, srcStat.mode);
}

/**
 * Minimal single-quote shell escaping for paths passed to git via execSync.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
