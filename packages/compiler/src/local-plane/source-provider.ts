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
  // `cleanup`. mkdtemp creates it mode-0700; `git clone` into the empty dir is
  // fine.
  const workdir = await makeTempDir('local-run', { persist: true });
  const tmpDir = workdir.path;

  const { sha, existingFiles, deletedFiles } = await selectOverlayFiles(repoRoot);

  // Base tree at HEAD: local clone then pin to the exact SHA. `--no-hardlinks`
  // copies the object store (hardlinks cannot span filesystems: repo under
  // $HOME, tmp under /tmp on a separate mount would otherwise fail).
  execSync(`git clone --no-hardlinks --quiet ${shellQuote(repoRoot)} ${shellQuote(tmpDir)}`, {
    stdio: 'ignore',
  });
  execSync(`git checkout --quiet ${sha}`, { cwd: tmpDir, stdio: 'ignore' });

  await applyOverlay(repoRoot, tmpDir, existingFiles, deletedFiles);

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
    cleanup: () => workdir.cleanup(),
  };
}

/** Copy overlay files onto the clone and remove local deletions. */
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
 * Copy a single overlay file, preserving its mode. Symlinks are recreated as
 * links (not dereferenced) — the same shape the remote tarball preserves.
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
