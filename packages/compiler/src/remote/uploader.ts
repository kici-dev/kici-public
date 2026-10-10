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

/**
 * Summary of files included in the overlay tarball.
 */
interface UploadSummary {
  /** Total files in tarball */
  fileCount: number;
  /** Untracked (new) files */
  newFiles: number;
  /** Modified files (staged + unstaged) */
  modifiedFiles: number;
  /** Files deleted locally */
  deletedFiles: number;
  /** Tarball size in bytes (compressed) */
  compressedSize: number;
  /** HEAD SHA */
  sha: string;
}

/**
 * Manifest describing the overlay contents.
 * Used by the agent to apply the overlay on top of a fresh clone.
 */
export interface OverlayManifest {
  /** HEAD SHA the overlay is based on */
  sha: string;
  /** Files deleted locally (need to be removed on agent) */
  deletions: string[];
  /** SHA256 checksums of each included file */
  checksums: Record<string, string>;
  /**
   * Symlinks whose target is a directory: repo-relative path → link text, as
   * `readlink` returns it. The agent recreates each one. Absent when there is
   * none, and ignored by an agent that predates it.
   */
  symlinks?: Record<string, string>;
}

/**
 * Options for uploading a tarball.
 */
interface UploadOptions {
  /** Path to the tarball file */
  tarballPath: string;
  /** Pre-signed URL to upload to */
  signedUrl: string;
  /** Orchestrator's X25519 public key for encryption */
  orchestratorPublicKey: Buffer;
  /** Progress callback (bytes uploaded, total bytes) */
  onProgress?: (bytes: number, total: number) => void;
}

/**
 * Result of a successful upload.
 */
export interface UploadResult {
  /** Upload identifier */
  uploadId: string;
  /** CLI's ephemeral public key (needed by agent for decryption) */
  cliPublicKey: Buffer;
  /** Encrypted tarball size in bytes */
  encryptedSize: number;
}

/** Size threshold for warning (50MB) */
const SIZE_WARN_THRESHOLD = 50 * 1024 * 1024;
/** Size threshold for hard error (500MB) */
const SIZE_ERROR_THRESHOLD = 500 * 1024 * 1024;
/** Maximum upload retry attempts */
const MAX_RETRIES = 3;

/**
 * Run a git command and return trimmed stdout lines.
 * Returns empty array if command produces no output.
 */
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
 * Result of selecting which files form the overlay over a clone at HEAD.
 *
 * Both the remote uploader and the local materializer consume this so the two
 * paths reconstruct the same workspace from the same selection logic.
 */
export interface OverlaySelection {
  /** HEAD SHA the selection is based on */
  sha: string;
  /** Whether the repo has at least one git remote */
  hasRemote: boolean;
  /** Selected files that exist on disk (to copy onto the clone) */
  existingFiles: string[];
  /** Selected files missing on disk (to delete from the clone) */
  deletedFiles: string[];
}

/**
 * Recursively enumerate every file under `<repoRoot>/.git`, returning paths
 * relative to `repoRoot` (so they keep the `.git/...` prefix in the tarball
 * and extract back in place).
 *
 * `git ls-files` never lists `.git` contents, so for `kici run remote` — which
 * uploads the developer's working tree as a self-contained overlay with NO
 * clone on the agent — we enumerate the directory explicitly. Including the
 * whole `.git` directory (objects, refs, HEAD, index, config, packed-refs)
 * makes the extracted overlay a real git repository, so workflow steps that
 * shell out to git work exactly as they do under `kici run --local`.
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

/**
 * Load .kiciignore patterns from a file.
 * Returns a picomatch matcher function or null if file doesn't exist.
 */
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
 * Select which files form the overlay over a clone checked out at HEAD.
 *
 * For repos with a remote: collects only dirty files (staged, unstaged, untracked).
 * For repos without a remote: collects ALL tracked + untracked files.
 *
 * The selected set is filtered by `.kiciignore` (picomatch) and partitioned
 * into files that still exist on disk (to copy onto the clone) and files that
 * are missing (to delete from the clone). Gitignored files — including secret
 * files like `.kici/.env.local` — are excluded by `--exclude-standard` and
 * never appear in the selection.
 *
 * When `fullWorkingTree` is set (the `kici run remote` path), the entire
 * `.git` directory is additively included so the extracted overlay is a real
 * git repository on the agent — workflow steps that shell out to git then work
 * exactly as they do under `kici run --local`. The `.git` files are added after
 * `.kiciignore` filtering (git internals are never subject to working-tree
 * ignore globs).
 *
 * @param repoRoot - Path to the git repository root
 * @param options - Optional configuration
 * @returns HEAD SHA, remote flag, and the existing/deleted file partition
 */
export async function selectOverlayFiles(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean },
): Promise<OverlaySelection> {
  // Get HEAD SHA
  const sha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();

  // Detect if repo has a remote
  const remotes = gitLines('git remote', repoRoot);
  const hasRemote = remotes.length > 0;

  let allFiles: string[];

  // `fullWorkingTree` forces the full tracked+untracked selection regardless of
  // whether a remote exists. `kici run remote` runs the developer's LOCAL
  // working tree on the orchestrator (the remote is irrelevant — there is no
  // clone), so it always uploads the complete tree as a self-contained overlay.
  if (hasRemote && !options?.fullWorkingTree) {
    // Overlay mode: only changed files
    const unstaged = gitLines('git diff --name-only HEAD', repoRoot);
    const staged = gitLines('git diff --name-only --cached HEAD', repoRoot);
    const untracked = gitLines('git ls-files --others --exclude-standard', repoRoot);

    // Deduplicate
    allFiles = [...new Set([...unstaged, ...staged, ...untracked])];
  } else {
    // Full tarball mode: all tracked + untracked
    const tracked = gitLines('git ls-files', repoRoot);
    const untracked = gitLines('git ls-files --others --exclude-standard', repoRoot);
    allFiles = [...new Set([...tracked, ...untracked])];
  }

  // Load .kiciignore if present
  const kiciIgnorePath = options?.kiciIgnorePath ?? path.join(repoRoot, '.kiciignore');
  const kiciIgnore = await loadKiciIgnore(kiciIgnorePath);

  // Apply .kiciignore filtering
  if (kiciIgnore) {
    allFiles = allFiles.filter((f) => !kiciIgnore(f));
  }
  // The manifest directory is reserved: a repository copy of it would collide
  // with the real manifest at the same tarball path.
  allFiles = allFiles.filter((f) => !isReservedOverlayPath(f));

  // For a full-working-tree overlay (`kici run remote`), additively include the
  // entire `.git` directory so the extracted overlay is a real git repository
  // and workflow steps that run git commands work exactly as they do locally.
  // `.git` is enumerated after `.kiciignore` filtering — git internals are never
  // subject to the working-tree ignore globs.
  if (options?.fullWorkingTree) {
    const gitFiles = await collectGitDirFiles(repoRoot);
    allFiles = [...new Set([...allFiles, ...gitFiles])];
  }

  // Separate existing files from deleted files
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
 * Write the overlay tarball: the manifest at `.kici-overlay-tmp/manifest.json`,
 * where the agent reads it, then each repository entry.
 *
 * Nothing is written into the repository. The manifest is packed from a
 * directory under `workDir`, the repository entries are appended to the same
 * uncompressed archive from `repoRoot`, and the result is gzipped.
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
 * Create an overlay tarball from a git repo, including only changed files.
 *
 * For repos with a remote: collects only dirty files (staged, unstaged, untracked).
 * For repos without a remote: collects ALL tracked + untracked files (full tarball).
 *
 * The tarball includes a `manifest.json` with the HEAD SHA, deletions list,
 * and SHA256 checksums for integrity verification.
 *
 * @param repoRoot - Path to the git repository root
 * @param options - Optional configuration
 * @returns Tarball path, upload summary, overlay manifest, and a warning per kind of
 *   selected path the overlay leaves out (submodules, dangling symlinks)
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

  // Count untracked (new) vs modified files among the developer's own changes.
  // `.git/**` is overlay infrastructure (it makes the extracted workspace a
  // real git repo), and a link target shipped alongside a changed link is not
  // a change either: both are excluded from the new/modified breakdown the
  // developer sees, though they still count toward `fileCount`.
  const untrackedSet = new Set(gitLines('git ls-files --others --exclude-standard', repoRoot));
  const workingTreeFiles = selection.existingFiles.filter(
    (f) => shipped.has(f) && !isGitDirPath(f),
  );
  const newFiles = workingTreeFiles.filter((f) => untrackedSet.has(f));
  const modifiedFiles = workingTreeFiles.filter((f) => !untrackedSet.has(f));

  // Checksum the content entries. A file symlink's checksum covers the file it
  // points at, which is what the agent reads through it.
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

  // Persist mode: the dir holds the returned tarball path and outlives this
  // function, so it is not auto-registered to any temp scope (cleanup is the
  // caller's / GC's).
  const { path: tmpDir } = await makeTempDir('overlay', { persist: true });
  const tarballPath = path.join(tmpDir, 'overlay.tar.gz');
  await packOverlayTarball(repoRoot, tmpDir, manifest, [...shipped], tarballPath);

  const stat = await fs.stat(tarballPath);
  const compressedSize = stat.size;

  // Size validation
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

/**
 * Returns a human-readable size warning if above threshold, or null.
 */
export function getSizeWarning(compressedSize: number): string | null {
  if (compressedSize >= SIZE_WARN_THRESHOLD && compressedSize < SIZE_ERROR_THRESHOLD) {
    return `Warning: tarball size is ${formatBytes(compressedSize)} (above 50MB warning threshold)`;
  }
  return null;
}

/**
 * Upload an encrypted tarball to a pre-signed URL.
 *
 * Encrypts the tarball with X25519 ECDH, uploads via HTTP PUT,
 * and retries up to 3 times on network failures (not on 4xx).
 */
export async function uploadTarball(opts: UploadOptions): Promise<UploadResult> {
  const { tarballPath, signedUrl, orchestratorPublicKey, onProgress } = opts;

  // The orchestrator mints the presigned PUT URL; an empty value means it has no
  // object storage configured (or upload init otherwise failed). Fail fast with
  // an actionable message instead of letting fetch('') throw an opaque
  // "Failed to parse URL from " after three pointless retries.
  if (!signedUrl) {
    throw new Error(
      'The orchestrator did not return an upload URL, so the overlay cannot be ' +
        'uploaded. This usually means the orchestrator has no object storage ' +
        'configured for remote runs. Ask your orchestrator operator to enable ' +
        'cache storage (KICI_STORAGE_TYPE=s3 or filesystem).',
    );
  }

  // Encrypt tarball
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
        // Client error -- do not retry
        throw new Error(`Upload failed with status ${response.status}: ${response.statusText}`);
      }

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}: ${response.statusText}`);
      }

      // Report full progress on completion
      onProgress?.(encryptedSize, encryptedSize);

      // Extract upload ID from ETag or generate one
      const etag = response.headers.get('etag')?.replace(/"/g, '') ?? '';
      const uploadId = etag || sha256(encryptedData).slice(0, 16);

      // Clean up encrypted file
      await fs.unlink(encryptedPath).catch(() => {});

      return { uploadId, cliPublicKey, encryptedSize };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on 4xx client errors
      if (lastError.message.includes('status 4')) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES) {
        // Wait before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  // Clean up encrypted file on final failure
  await fs.unlink(encryptedPath).catch(() => {});

  throw new Error(`Upload failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}
