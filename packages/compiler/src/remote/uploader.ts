import { execSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { create as tarCreate, replace as tarReplace } from 'tar';
import picomatch from 'picomatch';
import { formatBytes, sha256, sha256File } from '@kici-dev/core';
import { singleLinkTarCaches } from '@kici-dev/core/tar-single-link';
import { makeTempDir } from '@kici-dev/core/tmp';
import { encryptTarball } from './encryption.js';
import {
  classifyOverlayEntries,
  isGitDirPath,
  isReservedOverlayPath,
  OVERLAY_MANIFEST_DIR,
  overlaySkipWarnings,
  SkipContext,
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
  /** HEAD SHA. */
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
   * Symlinks whose target is a directory: repo-relative path → link text, as
   * `readlink` returns it. The agent recreates each one. Absent when there is
   * none, and ignored by an agent that predates it.
   */
  symlinks?: Record<string, string>;
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
const MAX_RETRIES = 3;

/** Returns the non-empty stdout lines, or an empty array when the command fails. */
function gitLines(cmd: string, cwd: string): string[] {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
    if (!output) return [];
    return output.split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * The files that form the overlay over a clone at HEAD. The remote uploader and
 * the local materializer share it, so both reconstruct the same workspace.
 */
export interface OverlaySelection {
  sha: string;
  hasRemote: boolean;
  /** Copied onto the clone. */
  existingFiles: string[];
  /** Missing on disk, so deleted from the clone. */
  deletedFiles: string[];
}

/**
 * Lists every file under `<repoRoot>/.git`, relative to `repoRoot`, so each
 * extracts back in place. `git ls-files` never lists `.git`, and `kici run
 * remote` has no clone on the agent: shipping the whole `.git` makes the overlay
 * a real repository, so steps that run git behave as under `kici run --local`.
 */
async function collectGitDirFiles(repoRoot: string): Promise<string[]> {
  const gitRoot = path.join(repoRoot, '.git');
  const out: string[] = [];

  async function walk(absDir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          out.push(path.relative(repoRoot, abs));
        }
      }),
    );
  }

  await walk(gitRoot);
  return out;
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
 * Selects the files that form the overlay over a clone at HEAD: only dirty files
 * (staged, unstaged, untracked) for a repo with a remote, every tracked and
 * untracked file otherwise. `.kiciignore` (picomatch) filters the set. Gitignored
 * files, secrets such as `.kici/.env.local` included, never appear:
 * `--exclude-standard` drops them.
 *
 * `fullWorkingTree` (the `kici run remote` path) also adds the whole `.git`
 * directory, after `.kiciignore` filtering: working-tree ignore globs never
 * apply to git internals.
 */
export async function selectOverlayFiles(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean },
): Promise<OverlaySelection> {
  const sha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();

  const remotes = gitLines('git remote', repoRoot);
  const hasRemote = remotes.length > 0;

  let allFiles: string[];

  // `kici run remote` runs the LOCAL working tree with no clone, so it takes the
  // full selection even when a remote exists.
  if (hasRemote && !options?.fullWorkingTree) {
    const unstaged = gitLines('git diff --name-only HEAD', repoRoot);
    const staged = gitLines('git diff --name-only --cached HEAD', repoRoot);
    const untracked = gitLines('git ls-files --others --exclude-standard', repoRoot);

    allFiles = [...new Set([...unstaged, ...staged, ...untracked])];
  } else {
    const tracked = gitLines('git ls-files', repoRoot);
    const untracked = gitLines('git ls-files --others --exclude-standard', repoRoot);
    allFiles = [...new Set([...tracked, ...untracked])];
  }

  const kiciIgnorePath = options?.kiciIgnorePath ?? path.join(repoRoot, '.kiciignore');
  const kiciIgnore = await loadKiciIgnore(kiciIgnorePath);

  if (kiciIgnore) {
    allFiles = allFiles.filter((f) => !kiciIgnore(f));
  }
  // The manifest directory is reserved: a repository copy of it would collide
  // with the real manifest at the same tarball path.
  allFiles = allFiles.filter((f) => !isReservedOverlayPath(f));

  if (options?.fullWorkingTree) {
    const gitFiles = await collectGitDirFiles(repoRoot);
    allFiles = [...new Set([...allFiles, ...gitFiles])];
  }

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

  return { sha, hasRemote, existingFiles, deletedFiles };
}

/**
 * Writes the manifest at `.kici-overlay-tmp/manifest.json`, where the agent
 * reads it, then each repository entry. Nothing is written into the repository:
 * the manifest is packed from `workDir`, the entries appended from `repoRoot`,
 * and the archive gzipped.
 */
async function packOverlayTarball(
  repoRoot: string,
  workDir: string,
  manifest: OverlayManifest,
  repoEntries: string[],
  tarballPath: string,
): Promise<void> {
  const manifestRoot = path.join(workDir, 'manifest-root');
  const manifestRel = path.posix.join(OVERLAY_MANIFEST_DIR, 'manifest.json');
  await fs.mkdir(path.join(manifestRoot, OVERLAY_MANIFEST_DIR), { recursive: true });
  await fs.writeFile(path.join(manifestRoot, manifestRel), JSON.stringify(manifest, null, 2));

  const rawTarPath = path.join(workDir, 'overlay.tar');
  try {
    await tarCreate({ file: rawTarPath, cwd: manifestRoot }, [manifestRel]);
    if (repoEntries.length > 0) {
      // A symlink (file or directory) ships as a link entry: node-tar does not
      // follow links unless asked to. git records no hard links, so each path
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
    await pipeline(createReadStream(rawTarPath), createGzip(), createWriteStream(tarballPath));
  } finally {
    await fs.rm(rawTarPath, { force: true });
    await fs.rm(manifestRoot, { recursive: true, force: true });
  }
}

/**
 * Creates an overlay tarball from the selection `selectOverlayFiles` makes. It
 * carries a `manifest.json` with the HEAD SHA, the deletions and SHA-256
 * checksums for integrity verification.
 *
 * @returns also a warning per kind of selected path the overlay leaves out
 *   (submodules, dangling symlinks)
 */
export async function createOverlayTarball(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean },
): Promise<{
  tarballPath: string;
  summary: UploadSummary;
  manifest: OverlayManifest;
  hasRemote: boolean;
  warnings: string[];
}> {
  const selection = await selectOverlayFiles(repoRoot, options);
  const { sha, hasRemote } = selection;
  const kiciIgnore = await loadKiciIgnore(
    options?.kiciIgnorePath ?? path.join(repoRoot, '.kiciignore'),
  );
  // Directory symlinks ship as link text, file symlinks bring the in-repo
  // targets the agent dereferences them to, and paths beneath a symlink are
  // deletions (git tracks nothing there).
  const entries = await classifyOverlayEntries(repoRoot, selection, kiciIgnore ?? (() => false));
  const linkPaths = Object.keys(entries.symlinks);
  const shipped = new Set([...entries.files, ...linkPaths]);

  // `.git/**` and a link target shipped beside a changed link are not the
  // developer's changes: both stay out of the new/modified breakdown but count
  // toward `fileCount`.
  const untrackedSet = new Set(gitLines('git ls-files --others --exclude-standard', repoRoot));
  const workingTreeFiles = selection.existingFiles.filter(
    (f) => shipped.has(f) && !isGitDirPath(f),
  );
  const newFiles = workingTreeFiles.filter((f) => untrackedSet.has(f));
  const modifiedFiles = workingTreeFiles.filter((f) => !untrackedSet.has(f));

  // A file symlink's checksum covers its target, which the agent reads through it.
  const checksums: Record<string, string> = {};
  await Promise.all(
    entries.files.map(async (file) => {
      const fullPath = path.join(repoRoot, file);
      checksums[file] = await sha256File(fullPath);
    }),
  );

  const manifest: OverlayManifest = {
    sha,
    deletions: entries.deletions,
    checksums,
    ...(linkPaths.length > 0 ? { symlinks: entries.symlinks } : {}),
  };

  // Persisted: the returned tarball outlives this function, so the caller cleans up.
  const { path: tmpDir } = await makeTempDir('overlay', { persist: true });
  const tarballPath = path.join(tmpDir, 'overlay.tar.gz');
  await packOverlayTarball(repoRoot, tmpDir, manifest, [...shipped], tarballPath);

  const stat = await fs.stat(tarballPath);
  const compressedSize = stat.size;

  if (compressedSize > SIZE_ERROR_THRESHOLD) {
    throw new Error(
      `Tarball size ${formatBytes(compressedSize)} exceeds 500MB limit. ` +
        'Use --dangerously-allow-large-upload to override.',
    );
  }

  const summary: UploadSummary = {
    fileCount: shipped.size,
    newFiles: newFiles.length,
    modifiedFiles: modifiedFiles.length,
    deletedFiles: entries.deletions.length,
    compressedSize,
    sha,
  };

  return {
    tarballPath,
    summary,
    manifest,
    hasRemote,
    warnings: overlaySkipWarnings(entries.skipped, SkipContext.RemoteRun),
  };
}

/** Returns a warning between the warn and error thresholds, or null. */
export function getSizeWarning(compressedSize: number): string | null {
  if (compressedSize >= SIZE_WARN_THRESHOLD && compressedSize < SIZE_ERROR_THRESHOLD) {
    return `Warning: tarball size is ${formatBytes(compressedSize)} (above 50MB warning threshold)`;
  }
  return null;
}

/**
 * Encrypts the tarball with X25519 ECDH and PUTs it to a pre-signed URL, with up
 * to 3 attempts in total; a 4xx is never retried.
 */
export async function uploadTarball(opts: UploadOptions): Promise<UploadResult> {
  const { tarballPath, signedUrl, orchestratorPublicKey, onProgress } = opts;

  // An empty URL means the orchestrator has no object storage (or upload init
  // failed). Fail fast: fetch('') throws an opaque "Failed to parse URL from "
  // only after every retry.
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
