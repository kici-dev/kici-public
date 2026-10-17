/**
 * Resolves the workdir a `kici run --local` dispatch registers as a `file://`
 * source. The plane reads `<repoBasePath>/.kici/kici.lock.json` and the agent
 * clones `file://<repoBasePath>` at a committed sha, so the workdir must be a git
 * repo whose HEAD carries the workflow and lock to run.
 *
 * - **default (isolated):** a tmp clone at HEAD with dirty and untracked files
 *   committed onto the current branch's name (`kici-local` when detached), so the
 *   agent sees uncommitted work without touching the developer's tree.
 * - **`--in-place`:** the repo root directly (the profile CI deploy jobs use).
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import {
  classifySelection,
  gitlinkPaths,
  overlaySkipWarnings,
  SkipContext,
  type OverlayEntries,
} from '../remote/overlay-links.js';
import { selectOverlayFiles } from '../remote/uploader.js';
import { detectCurrentBranch } from '../test-runner/git-detector.js';
import { shQuote } from '@kici-dev/core';

export const LOCAL_RUN_BRANCH = 'kici-local';

/** Max overlay files copied concurrently. */
const COPY_BATCH_SIZE = 32;

export interface ResolvedWorkdir {
  /** Absolute path registered as the local source `repoBasePath`. */
  dir: string;
  /** `refs/heads/<branch>`, carried by the synthetic push. */
  ref: string;
  /** Committed HEAD sha the agent clones. */
  sha: string;
  /** Matched by the workflow's push filter. */
  branch: string;
  /** No-op for `--in-place`. */
  cleanup: () => Promise<void>;
  /** Paths the isolated checkout leaves out (submodules, dangling symlinks), one line per kind. */
  warnings: string[];
}

export async function resolveWorkdir(opts: {
  inPlace: boolean;
  repoRoot: string;
}): Promise<ResolvedWorkdir> {
  requireGitRepo(opts.repoRoot);
  return opts.inPlace ? resolveInPlace(opts.repoRoot) : resolveIsolated(opts.repoRoot);
}

function resolveInPlace(repoRoot: string): ResolvedWorkdir {
  const branch = detectCurrentBranch(repoRoot) ?? LOCAL_RUN_BRANCH;
  const sha = gitOut(repoRoot, ['rev-parse', 'HEAD']);
  return {
    dir: repoRoot,
    ref: `refs/heads/${branch}`,
    sha,
    branch,
    cleanup: async () => {
      /* the working tree is the developer's — never removed */
    },
    warnings: [],
  };
}

async function resolveIsolated(repoRoot: string): Promise<ResolvedWorkdir> {
  // Persist mode keeps it out of any temp scope: the returned `cleanup`, or the
  // catch below, owns its lifetime. mkdtemp creates it mode 0700.
  const workdir = await makeTempDir('local-run', { persist: true });
  try {
    return await materializeIsolated(repoRoot, workdir.path, () => workdir.cleanup());
  } catch (err) {
    // fails-when: a failed clone, overlay copy or commit leaves the tmp clone behind
    // A cleanup failure must not replace the error that says why the clone failed.
    await workdir.cleanup().catch(() => undefined);
    throw err;
  }
}

async function materializeIsolated(
  repoRoot: string,
  tmpDir: string,
  cleanup: () => Promise<void>,
): Promise<ResolvedWorkdir> {
  const selection = await selectOverlayFiles(repoRoot);
  const { sha } = selection;
  const entries = await classifySelection(repoRoot, selection);

  // `--no-hardlinks`: hardlinks cannot span filesystems (repo under $HOME, tmp
  // on a separate /tmp mount).
  execSync(`git clone --no-hardlinks --quiet ${shQuote(repoRoot)} ${shQuote(tmpDir)}`, {
    stdio: 'ignore',
  });
  execSync(`git checkout --quiet ${sha}`, { cwd: tmpDir, stdio: 'ignore' });

  await applyOverlay(repoRoot, tmpDir, entries);

  // So the agent's clone-by-sha and the ref-scoped trigger resolve a sha that
  // carries the overlay.
  const branch = detectCurrentBranch(repoRoot) ?? LOCAL_RUN_BRANCH;
  execFileSync('git', ['checkout', '-B', branch], { cwd: tmpDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'ignore' });
  if (gitOut(tmpDir, ['status', '--porcelain'])) {
    execFileSync(
      'git',
      [
        '-c',
        'user.email=local@kici.dev',
        '-c',
        'user.name=kici local',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        'kici run --local overlay',
      ],
      { cwd: tmpDir, stdio: 'ignore' },
    );
  }
  const committed = gitOut(tmpDir, ['rev-parse', 'HEAD']);

  return {
    dir: tmpDir,
    ref: `refs/heads/${branch}`,
    sha: committed,
    branch,
    cleanup,
    warnings: overlaySkipWarnings(entries.skipped, SkipContext.LocalRun),
  };
}

/**
 * Deletions first, so a path that changed between file, symlink and directory
 * is gone before its new content lands; then files and file symlinks; then
 * directory symlinks, once the directories they replace are emptied.
 */
async function applyOverlay(
  repoRoot: string,
  tmpDir: string,
  entries: OverlayEntries,
): Promise<void> {
  await removeDeletions(tmpDir, entries.deletions);
  for (let i = 0; i < entries.files.length; i += COPY_BATCH_SIZE) {
    const batch = entries.files.slice(i, i + COPY_BATCH_SIZE);
    // Every copy settles before a failure is thrown, so the caller's cleanup
    // never races a copy still writing into the clone.
    const results = await Promise.allSettled(
      batch.map((file) => copyOverlayFile(repoRoot, tmpDir, file)),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  for (const [file, text] of Object.entries(entries.symlinks)) {
    const dest = await clearDestination(tmpDir, file);
    await fs.symlink(text, dest, 'dir');
  }
}

/**
 * One at a time: a deletion and the entry that replaces it must not race. A
 * removed submodule is an empty directory in the clone (which checks out no
 * submodules); only a path the clone's index records as a submodule is removed
 * that way, never recursively.
 */
async function removeDeletions(tmpDir: string, deletions: string[]): Promise<void> {
  const stats = await Promise.all(
    deletions.map((file) => fs.lstat(path.join(tmpDir, file)).catch(() => undefined)),
  );
  const dirs = deletions.filter((_, i) => stats[i]?.isDirectory());
  const submodules = dirs.length > 0 ? gitlinkPaths(tmpDir, dirs) : new Set<string>();
  for (const file of deletions) {
    const dest = path.join(tmpDir, file);
    // fails-when: the clone's empty directory for a removed submodule is removed as a file (EISDIR)
    // breaks-if-wrong: a deleted regular file or symlink is still removed
    if (submodules.has(file)) await fs.rmdir(dest);
    else await fs.rm(dest, { force: true });
  }
}

/**
 * Creates parents and removes whatever is at the path. A directory there is one
 * the developer replaced, whose tracked files the deletions already removed.
 */
async function clearDestination(tmpDir: string, file: string): Promise<string> {
  const dest = path.join(tmpDir, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const existing = await fs.lstat(dest).catch(() => undefined);
  // fails-when: the clone has a directory where the developer now has a file or a link
  // breaks-if-wrong: a path the clone does not have is written without a removal
  if (existing?.isDirectory()) await fs.rm(dest, { recursive: true, force: true });
  else if (existing) await fs.rm(dest, { force: true });
  return dest;
}

/** Preserves the mode; symlinks stay links, as in the remote tarball. */
async function copyOverlayFile(repoRoot: string, tmpDir: string, file: string): Promise<void> {
  const src = path.join(repoRoot, file);
  const dest = await clearDestination(tmpDir, file);
  const srcStat = await fs.lstat(src);
  if (srcStat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(src), dest);
    return;
  }
  await fs.copyFile(src, dest);
  await fs.chmod(dest, srcStat.mode);
}

function requireGitRepo(repoRoot: string): void {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    throw new Error(
      `kici run --local needs a git repository, but "${repoRoot}" is not inside a git work tree. ` +
        `Initialize a repo (git init) before running.`,
    );
  }
}

/**
 * The parent of `sha` in `dir`, or undefined for a root commit or an
 * unreadable repo. For an isolated run it is the developer's HEAD (the overlay
 * commit's parent); in place it is `HEAD^`.
 */
export function readParentSha(dir: string, sha: string): string | undefined {
  try {
    const parent = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^`], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parent || undefined;
  } catch {
    return undefined;
  }
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
