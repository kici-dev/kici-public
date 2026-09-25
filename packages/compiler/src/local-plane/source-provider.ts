/**
 * LocalSourceProvider — resolve the workdir a `kici run --local` dispatch
 * registers as a `file://` source for the plane.
 *
 * The plane orchestrator's local provider fetches the lock from
 * `<repoBasePath>/.kici/kici.lock.json` and the ephemeral agent clones
 * `file://<repoBasePath>` at a committed sha. So the resolved workdir must be a
 * git repo whose HEAD carries the workflow + lock the run should execute.
 *
 * Two profiles:
 * - **default (isolated):** an isolated tmp clone at HEAD with the local overlay
 *   (dirty + untracked files) applied and committed onto a `kici-local` branch,
 *   so the clone-by-sha the agent performs sees uncommitted work without
 *   touching the developer's tree.
 * - **`--in-place`:** the repo root directly (ambient state, the profile the CI
 *   deploy jobs use). Cleanup is a no-op.
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

/** The `kici-local` branch the isolated profile commits its overlay onto. */
export const LOCAL_RUN_BRANCH = 'kici-local';

/** Max number of overlay files copied concurrently. */
const COPY_BATCH_SIZE = 32;

/** A resolved workdir plus the git coordinates the plane trigger needs. */
export interface ResolvedWorkdir {
  /** Absolute path registered as the local source `repoBasePath`. */
  dir: string;
  /** Git ref the synthetic push carries (`refs/heads/<branch>`). */
  ref: string;
  /** Committed HEAD sha the agent clones + checks out. */
  sha: string;
  /** Branch short name (matched by the workflow's push filter). */
  branch: string;
  /** Remove the tmp workdir (no-op for `--in-place`). */
  cleanup: () => Promise<void>;
  /** Paths the isolated checkout leaves out (submodules, dangling symlinks), one line per kind. */
  warnings: string[];
}

/**
 * Resolve the workdir for an offline routed run.
 *
 * @param opts.inPlace - Use the repo root directly instead of an isolated clone.
 * @param opts.repoRoot - The developer's repo root.
 */
export async function resolveWorkdir(opts: {
  inPlace: boolean;
  repoRoot: string;
}): Promise<ResolvedWorkdir> {
  requireGitRepo(opts.repoRoot);
  return opts.inPlace ? resolveInPlace(opts.repoRoot) : resolveIsolated(opts.repoRoot);
}

/** In-place: the repo root, triggered at its current branch + HEAD. */
function resolveInPlace(repoRoot: string): ResolvedWorkdir {
  const branch = gitOut(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
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

/**
 * Isolated: a tmp clone at HEAD with the local overlay applied and committed
 * onto the `kici-local` branch, then commits so the agent's clone-by-sha
 * carries the work.
 */
async function resolveIsolated(repoRoot: string): Promise<ResolvedWorkdir> {
  // Retained-until-GC clone dir: allocated in persist mode so it is not
  // auto-registered to any temp scope — its lifetime is owned by the returned
  // `cleanup`, or by the catch below when building the clone fails.
  // mkdtemp creates it mode-0700; `git clone` into the empty dir is fine.
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

/** Build the isolated clone in `tmpDir` and commit the overlay onto it. */
async function materializeIsolated(
  repoRoot: string,
  tmpDir: string,
  cleanup: () => Promise<void>,
): Promise<ResolvedWorkdir> {
  const selection = await selectOverlayFiles(repoRoot);
  const { sha } = selection;
  const entries = await classifySelection(repoRoot, selection);

  // Base tree at HEAD: local clone then pin to the exact SHA. `--no-hardlinks`
  // copies the object store (hardlinks cannot span filesystems: repo under
  // $HOME, tmp under /tmp on a separate mount would otherwise fail).
  execSync(`git clone --no-hardlinks --quiet ${shellQuote(repoRoot)} ${shellQuote(tmpDir)}`, {
    stdio: 'ignore',
  });
  execSync(`git checkout --quiet ${sha}`, { cwd: tmpDir, stdio: 'ignore' });

  await applyOverlay(repoRoot, tmpDir, entries);

  // Commit the overlay onto a named branch so the agent's clone-by-sha (and the
  // orchestrator's ref-scoped trigger) resolve a sha that carries it.
  execFileSync('git', ['checkout', '-B', LOCAL_RUN_BRANCH], { cwd: tmpDir, stdio: 'ignore' });
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
    ref: `refs/heads/${LOCAL_RUN_BRANCH}`,
    sha: committed,
    branch: LOCAL_RUN_BRANCH,
    cleanup,
    warnings: overlaySkipWarnings(entries.skipped, SkipContext.LocalRun),
  };
}

/**
 * Apply the classified overlay to the clone. Deletions run first, so a path the
 * developer turned from a file or symlink into a directory (or back) is gone
 * before its new content lands; then files and file symlinks; then directory
 * symlinks, once the directories they replace are emptied.
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
 * Remove the overlay's deletions from the clone, one at a time: a deletion and
 * the entry that replaces it must not race. A submodule the developer removed
 * is an empty directory in the clone, which checks out no submodule, so that
 * path is removed as an empty directory. Only a path the clone's index records
 * as a submodule is removed that way, and never recursively.
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
 * Make room for an overlay entry in the clone and return its path: create the
 * parent directories and remove whatever is at the path. A directory there is
 * the clone's copy of a directory the developer replaced, whose tracked files
 * the deletions already removed.
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

/**
 * Copy a single overlay file, preserving its mode. Symlinks are recreated as
 * links (not dereferenced) — the same shape the remote tarball preserves.
 */
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

/** Throw an actionable error if `repoRoot` is not a git work tree. */
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

/** Run a git command in `cwd` and return trimmed stdout. */
function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Minimal single-quote shell escaping for paths passed to git via execSync. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
