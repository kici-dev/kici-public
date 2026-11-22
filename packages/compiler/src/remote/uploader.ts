import { execSync, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { create as tarCreate, replace as tarReplace } from 'tar';
import picomatch from 'picomatch';
import { formatBytes, sha256, sha256File } from '@kici-dev/core';
import { singleLinkTarCaches } from '@kici-dev/core/tar-single-link';
import { KICI_TMP_PREFIX, kiciTmpBase, makeTempDir, type TempHandle } from '@kici-dev/core/tmp';
import { gcStaleTmpDirs } from '@kici-dev/core/tmp-gc';
import type { OverlayGitRecord } from '@kici-dev/engine';
import { encryptTarball } from './encryption.js';
import type { GitShipOptions, ShippedGit } from './shipped-git/git-ship-types.js';
import { assertHasCommit, buildShippedGit } from './shipped-git/shipped-git.js';
import {
  classifyOverlayEntries,
  isReservedOverlayPath,
  OVERLAY_MANIFEST_DIR,
  overlaySkipWarnings,
  SkipContext,
  type OverlayEntries,
} from './overlay-links.js';

interface UploadSummary {
  fileCount: number;
  /** Untracked files. */
  newFiles: number;
  /** Staged plus unstaged. */
  modifiedFiles: number;
  deletedFiles: number;
  /** Compressed tarball size in bytes. */
  compressedSize: number;
  /** The commit the remote workspace checks out when a `.git` ships, else HEAD. */
  sha: string;
}

/** The agent applies the overlay over a fresh clone with this manifest. */
export interface OverlayManifest {
  /** HEAD SHA the overlay is based on. */
  sha: string;
  /** Files deleted locally, which the agent removes. */
  deletions: string[];
  /** SHA-256 of each included file. */
  checksums: Record<string, string>;
  /**
   * Directory symlinks: path → `readlink` text, which the agent recreates. Absent when there is
   * none; an agent that predates it ignores it.
   */
  symlinks?: Record<string, string>;
  /**
   * The shipped `.git`'s history, which the agent compares against a job's checkout options.
   * Absent when no `.git` ships; an agent that predates it ignores it.
   */
  git?: OverlayGitRecord;
}

interface UploadOptions {
  tarballPath: string;
  signedUrl: string;
  /** Orchestrator's X25519 public key for encryption. */
  orchestratorPublicKey: Buffer;
  onProgress?: (bytes: number, total: number) => void;
}

export interface UploadResult {
  uploadId: string;
  /** CLI's ephemeral public key, which the agent needs to decrypt. */
  cliPublicKey: Buffer;
  /** Encrypted tarball size in bytes. */
  encryptedSize: number;
}

/** 50 MB. */
const SIZE_WARN_THRESHOLD = 50 * 1024 * 1024;
/** 500 MB: a hard error. */
const SIZE_ERROR_THRESHOLD = 500 * 1024 * 1024;

const OVERLAY_TMP_LABEL = 'overlay';
const OVERLAY_TMP_DIR_PREFIX = `${KICI_TMP_PREFIX}${OVERLAY_TMP_LABEL}-`;
const OVERLAY_TMP_DIR_PATTERN = new RegExp(`^${OVERLAY_TMP_DIR_PREFIX}[A-Za-z0-9]{6}$`);
export const OVERLAY_TMP_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_RETRIES = 3;

const UNTRACKED_FILES_ARGS = ['ls-files', '--others', '--exclude-standard'];

/** Large enough for `ls-files` of a big monorepo. */
const MAX_PATHS_BUFFER = 256 * 1024 * 1024;

/** Where the shipped repository stays, beside the tarball, once the tarball holds it. */
const SHIPPED_GIT_DIRNAME = 'ship';

/**
 * The paths a git listing prints, NUL-separated so a newline or non-ASCII name arrives verbatim.
 * A failing listing throws git's message: an empty list would ship an incomplete workspace.
 */
function gitPaths(args: string[], cwd: string): string[] {
  const result = spawnSync('git', ['--no-optional-locks', ...args, '-z'], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: MAX_PATHS_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${reason || `exit ${result.status}`}`);
  }
  return result.stdout.split('\0').filter((p) => p.length > 0);
}

/** Whether the repository has a remote; false when git cannot tell. */
function hasGitRemote(repoRoot: string): boolean {
  try {
    return (
      execSync('git --no-optional-locks remote', { cwd: repoRoot, encoding: 'utf-8' }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/** The overlay over a clone at HEAD, shared by the remote uploader and the local materializer. */
export interface OverlaySelection {
  sha: string;
  hasRemote: boolean;
  /** Copied onto the clone. */
  existingFiles: string[];
  /** Missing on disk, so deleted from the clone. */
  deletedFiles: string[];
  /** Paths git reports changed against HEAD, filtered as the selection is (all of a dirty-only one). */
  changedFiles: string[];
}

/** Returns a picomatch matcher, or null when the file is missing or has no patterns. */
async function loadKiciIgnore(kiciIgnorePath: string): Promise<((file: string) => boolean) | null> {
  try {
    const content = await fs.readFile(kiciIgnorePath, 'utf-8');
    const patterns = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    if (patterns.length === 0) return null;

    const matcher = picomatch(patterns);
    return (file: string) => matcher(file);
  } catch {
    return null;
  }
}

/**
 * The overlay over a clone at HEAD: the dirty files for a repo with a remote, else every tracked
 * and untracked file, filtered by `.kiciignore` (picomatch). `--exclude-standard` drops
 * gitignored files (secrets such as `.kici/.env.local`); `git ls-files` never lists `.git`.
 * `--no-optional-locks` keeps the developer's index unrefreshed.
 */
export async function selectOverlayFiles(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean },
): Promise<OverlaySelection> {
  const sha = execSync('git --no-optional-locks rev-parse HEAD', {
    cwd: repoRoot,
    encoding: 'utf-8',
  }).trim();

  const hasRemote = hasGitRemote(repoRoot);

  // `--no-renames`: a rename lists both its paths, so the old one is deleted.
  const unstaged = gitPaths(['diff', '--name-only', '--no-renames', 'HEAD'], repoRoot);
  const staged = gitPaths(['diff', '--name-only', '--no-renames', '--cached', 'HEAD'], repoRoot);
  const untracked = gitPaths(UNTRACKED_FILES_ARGS, repoRoot);
  const changed = [...new Set([...unstaged, ...staged, ...untracked])];

  // `kici run remote` runs the local working tree with no clone: always the full selection.
  const unfiltered =
    hasRemote && !options?.fullWorkingTree
      ? changed
      : [...new Set([...gitPaths(['ls-files'], repoRoot), ...untracked])];

  const kiciIgnorePath = options?.kiciIgnorePath ?? path.join(repoRoot, '.kiciignore');
  const kiciIgnore = await loadKiciIgnore(kiciIgnorePath);
  // Reserved: a repository copy would collide with the real manifest's tarball path.
  const selected = (f: string): boolean => !kiciIgnore?.(f) && !isReservedOverlayPath(f);
  const allFiles = unfiltered.filter(selected);

  const existingFiles: string[] = [];
  const deletedFiles: string[] = [];

  await Promise.all(
    allFiles.map(async (file) => {
      const fullPath = path.join(repoRoot, file);
      try {
        await fs.access(fullPath);
        existingFiles.push(file);
      } catch {
        deletedFiles.push(file);
      }
    }),
  );

  return { sha, hasRemote, existingFiles, deletedFiles, changedFiles: changed.filter(selected) };
}

/**
 * `buildShippedGit`'s inputs from an overlay. A dangling tracked link is absent remotely but no
 * deletion: it stays in the shipped history, skip-worktree in the remote index.
 */
export function shippedGitInputs(
  selection: OverlaySelection,
  entries: OverlayEntries,
): { shippedPaths: Set<string>; changedPaths: Set<string>; deletions: string[] } {
  const dangling = new Set(entries.skipped.danglingLinks);
  return {
    shippedPaths: new Set([...entries.files, ...Object.keys(entries.symlinks)]),
    changedPaths: new Set(selection.changedFiles),
    deletions: entries.deletions.filter((p) => !dangling.has(p)),
  };
}

/**
 * Pack the manifest (from `workDir`, at `.kici-overlay-tmp/manifest.json`), then the repository
 * entries, then each extra root's (the built `.git`), and gzip. Nothing is written into the repo.
 */
async function packOverlayTarball(
  repoRoot: string,
  workDir: string,
  manifest: OverlayManifest,
  repoEntries: string[],
  tarballPath: string,
  extraRoots: Array<{ root: string; entries: string[] }> = [],
): Promise<void> {
  const manifestRoot = path.join(workDir, 'manifest-root');
  const manifestRel = path.posix.join(OVERLAY_MANIFEST_DIR, 'manifest.json');
  await fs.mkdir(path.join(manifestRoot, OVERLAY_MANIFEST_DIR), { recursive: true });
  await fs.writeFile(path.join(manifestRoot, manifestRel), JSON.stringify(manifest, null, 2));

  const rawTarPath = path.join(workDir, 'overlay.tar');
  try {
    await tarCreate({ file: rawTarPath, cwd: manifestRoot }, [manifestRel]);
    if (repoEntries.length > 0) {
      // node-tar ships a symlink as a link entry; git records no hard links, so each path
      // ships as its own content.
      await tarReplace(
        {
          file: rawTarPath,
          cwd: repoRoot,
          ...(await singleLinkTarCaches(repoRoot, repoEntries)),
        },
        repoEntries,
      );
    }
    for (const { root, entries } of extraRoots) {
      if (entries.length === 0) continue;
      await tarReplace(
        { file: rawTarPath, cwd: root, ...(await singleLinkTarCaches(root, entries)) },
        entries,
      );
    }
    await pipeline(createReadStream(rawTarPath), createGzip(), createWriteStream(tarballPath));
  } finally {
    await fs.rm(rawTarPath, { force: true });
    await fs.rm(manifestRoot, { recursive: true, force: true });
  }
}

/** SHA-256 of each `files` entry, read under `root`. */
async function checksumFiles(
  root: string,
  files: string[],
  into: Record<string, string>,
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      into[file] = await sha256File(path.join(root, file));
    }),
  );
}

/** SHA-256 of each file as packed: `checkout` paths, and links to them, read the replacement. */
async function checksumOverlayFiles(
  repoRoot: string,
  files: string[],
  checkout: { root: string; paths: string[] } | undefined,
  into: Record<string, string>,
): Promise<void> {
  if (!checkout) return checksumFiles(repoRoot, files, into);
  const replaced = new Set(checkout.paths);
  const realRoot = await fs.realpath(repoRoot);
  await Promise.all(
    files.map(async (file) => {
      const target = path.relative(realRoot, await fs.realpath(path.join(repoRoot, file)));
      const rel = target.split(path.sep).join('/');
      into[file] = replaced.has(rel)
        ? await sha256File(path.join(checkout.root, rel))
        : await sha256File(path.join(repoRoot, file));
    }),
  );
}

/**
 * The overlay tarball of `selectOverlayFiles`'s selection, with a `manifest.json` of the HEAD
 * SHA, deletions and SHA-256 checksums. With `git`, it also ships a fresh-clone `.git`
 * (`buildShippedGit`), never the developer's, recorded under the manifest's `git` key; a file
 * whose default-config checkout differs ships as that checkout writes it.
 *
 * @returns also a warning per kind of path left out, and one when no `.git` can ship
 */
export async function createOverlayTarball(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean; git?: GitShipOptions },
): Promise<{
  tarballPath: string;
  summary: UploadSummary;
  manifest: OverlayManifest;
  hasRemote: boolean;
  warnings: string[];
  git?: ShippedGit;
  /** Holds the tarball and the shipped repository; the caller removes it once the upload is done. */
  tempDir: TempHandle;
}> {
  // Before any read of HEAD: a repository with no commit gets the actionable error.
  assertHasCommit(repoRoot);
  const selection = await selectOverlayFiles(repoRoot, options);
  const { sha, hasRemote } = selection;
  const kiciIgnore = await loadKiciIgnore(
    options?.kiciIgnorePath ?? path.join(repoRoot, '.kiciignore'),
  );
  // Directory links ship as text, file links bring their in-repo targets, and paths beneath a
  // link are deletions (git tracks nothing there).
  const entries = await classifyOverlayEntries(repoRoot, selection, kiciIgnore ?? (() => false));
  const linkPaths = Object.keys(entries.symlinks);
  const shipped = new Set([...entries.files, ...linkPaths]);

  // A shipped link target is no change: out of the new/modified breakdown, in `fileCount`.
  const untrackedSet = new Set(gitPaths(UNTRACKED_FILES_ARGS, repoRoot));
  const workingTreeFiles = selection.existingFiles.filter((f) => shipped.has(f));
  const newFiles = workingTreeFiles.filter((f) => untrackedSet.has(f));
  const modifiedFiles = workingTreeFiles.filter((f) => !untrackedSet.has(f));

  // The returned tarball outlives this function: the caller removes the dir.
  const overlayDir = await makeTempDir(OVERLAY_TMP_LABEL);
  const tmpDir = overlayDir.path;
  const warnings = overlaySkipWarnings(entries.skipped, SkipContext.RemoteRun);
  // The built `.git` (a full history copy at depth 0) gets its own temp dir, removed once
  // packed; only the shipped repository stays, beside the tarball, for the caller.
  let gitWork: TempHandle | undefined;
  let git: ShippedGit | undefined;
  let tarballPath: string;
  let manifest: OverlayManifest;
  let compressedSize: number;
  try {
    if (options?.git) {
      gitWork = await makeTempDir('shipped-git', { base: tmpDir });
      const result = await buildShippedGit({
        repoRoot,
        workDir: gitWork.path,
        options: options.git,
        ...shippedGitInputs(selection, entries),
      });
      if ('skipped' in result) warnings.push(result.skipped);
      else {
        git = result.git;
        warnings.push(...git.warnings);
      }
    }

    // A file symlink's checksum covers its target, which the agent reads through it.
    const replaced = new Set(git?.checkout?.paths ?? []);
    const checksums: Record<string, string> = {};
    await checksumOverlayFiles(repoRoot, entries.files, git?.checkout, checksums);
    if (git) await checksumFiles(git.root, git.files, checksums);

    manifest = {
      sha,
      deletions: entries.deletions,
      checksums,
      ...(linkPaths.length > 0 ? { symlinks: entries.symlinks } : {}),
      ...(git ? { git: git.record } : {}),
    };

    tarballPath = path.join(tmpDir, 'overlay.tar.gz');
    await packOverlayTarball(
      repoRoot,
      tmpDir,
      manifest,
      [...shipped].filter((p) => !replaced.has(p)),
      tarballPath,
      [
        ...(git ? [{ root: git.root, entries: git.files }] : []),
        ...(git?.checkout ? [{ root: git.checkout.root, entries: git.checkout.paths }] : []),
      ],
    );

    compressedSize = (await fs.stat(tarballPath)).size;
    assertOverlayWithinLimit(compressedSize);
    if (git) {
      // The caller reads the shipped objects (the synthetic commit's diff): move them out.
      const shipRoot = path.join(tmpDir, SHIPPED_GIT_DIRNAME);
      await fs.rename(git.root, shipRoot);
      git = { ...git, root: shipRoot };
    }
  } catch (err) {
    // No tarball is returned, so nothing in the overlay dir outlives the failure.
    // A cleanup failure must not replace the error that says why packing failed.
    await overlayDir.cleanup().catch(() => undefined);
    throw err;
  } finally {
    await gitWork?.cleanup();
  }

  const summary: UploadSummary = {
    fileCount: shipped.size + (git?.files.length ?? 0),
    newFiles: newFiles.length,
    modifiedFiles: modifiedFiles.length,
    deletedFiles: entries.deletions.length,
    compressedSize,
    sha: git?.workspaceSha ?? sha,
  };

  return {
    tarballPath,
    summary,
    manifest,
    hasRemote,
    warnings,
    ...(git ? { git } : {}),
    tempDir: overlayDir,
  };
}

/** Throws when the compressed overlay is above the 500 MB upload limit. */
export function assertOverlayWithinLimit(compressedSize: number): void {
  if (compressedSize > SIZE_ERROR_THRESHOLD) {
    throw new Error(
      `Overlay is ${formatBytes(compressedSize)}, above the 500MB limit. ` +
        'Exclude large files with .kiciignore, or ship less history with a smaller --git-depth.',
    );
  }
}

export async function gcStaleOverlayDirs(base: string = kiciTmpBase()): Promise<string[]> {
  return gcStaleTmpDirs({
    base,
    pattern: OVERLAY_TMP_DIR_PATTERN,
    maxAgeMs: OVERLAY_TMP_GC_MAX_AGE_MS,
  });
}

/** Returns a warning between the warn and error thresholds, or null. */
export function getSizeWarning(compressedSize: number): string | null {
  if (compressedSize >= SIZE_WARN_THRESHOLD && compressedSize < SIZE_ERROR_THRESHOLD) {
    return `Warning: tarball size is ${formatBytes(compressedSize)} (above 50MB warning threshold)`;
  }
  return null;
}

/** Encrypt with X25519 ECDH and PUT to a pre-signed URL: up to 3 attempts, never retrying a 4xx. */
export async function uploadTarball(opts: UploadOptions): Promise<UploadResult> {
  const { tarballPath, signedUrl, orchestratorPublicKey, onProgress } = opts;

  // Empty: no object storage, or upload init failed. fetch('') would fail opaquely after retries.
  if (!signedUrl) {
    throw new Error(
      'The orchestrator did not return an upload URL, so the overlay cannot be ' +
        'uploaded. This usually means the orchestrator has no object storage ' +
        'configured for remote runs. Ask your orchestrator operator to enable ' +
        'cache storage (KICI_STORAGE_TYPE=s3 or filesystem).',
    );
  }

  const { encryptedPath, cliPublicKey } = await encryptTarball(tarballPath, orchestratorPublicKey);

  const encryptedData = await fs.readFile(encryptedPath);
  const encryptedSize = encryptedData.length;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(signedUrl, {
        method: 'PUT',
        body: encryptedData,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': encryptedSize.toString(),
        },
      });

      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Upload failed with status ${response.status}: ${response.statusText}`);
      }

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}: ${response.statusText}`);
      }

      onProgress?.(encryptedSize, encryptedSize);

      // The ETag, or a content hash when the store returns none.
      const etag = response.headers.get('etag')?.replace(/"/g, '') ?? '';
      const uploadId = etag || sha256(encryptedData).slice(0, 16);

      await fs.unlink(encryptedPath).catch(() => {});

      return { uploadId, cliPublicKey, encryptedSize };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // The 4xx error thrown above lands here too; it must not retry.
      if (lastError.message.includes('status 4')) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        // Linear backoff: 1 s, then 2 s.
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  await fs.unlink(encryptedPath).catch(() => {});

  throw new Error(`Upload failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}
