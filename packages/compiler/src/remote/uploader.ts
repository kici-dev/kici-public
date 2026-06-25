import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { create as tarCreate } from 'tar';
import picomatch from 'picomatch';
import { formatBytes, sha256, sha256File } from '@kici-dev/core';
import { encryptTarball } from './encryption.js';

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
interface UploadResult {
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

/** True for repo-relative paths inside the `.git` directory. */
function isGitDirPath(relPath: string): boolean {
  return relPath === '.git' || relPath.startsWith('.git/');
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
 * shell out to git work exactly as they do under `kici run local`.
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
 * exactly as they do under `kici run local`. The `.git` files are added after
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
 * @returns Tarball path, upload summary, and overlay manifest
 */
export async function createOverlayTarball(
  repoRoot: string,
  options?: { kiciIgnorePath?: string; fullWorkingTree?: boolean },
): Promise<{
  tarballPath: string;
  summary: UploadSummary;
  manifest: OverlayManifest;
  hasRemote: boolean;
}> {
  const { sha, hasRemote, existingFiles, deletedFiles } = await selectOverlayFiles(
    repoRoot,
    options,
  );

  // Count untracked (new) vs modified files. `.git/**` is overlay
  // infrastructure (it makes the extracted workspace a real git repo), not a
  // working-tree content change, so it's excluded from the new/modified
  // breakdown the developer sees — though it still counts toward `fileCount`.
  const untrackedSet = new Set(gitLines('git ls-files --others --exclude-standard', repoRoot));
  const workingTreeFiles = existingFiles.filter((f) => !isGitDirPath(f));
  const newFiles = workingTreeFiles.filter((f) => untrackedSet.has(f));
  const modifiedFiles = workingTreeFiles.filter((f) => !untrackedSet.has(f));

  // Compute checksums for existing files
  const checksums: Record<string, string> = {};
  await Promise.all(
    existingFiles.map(async (file) => {
      const fullPath = path.join(repoRoot, file);
      checksums[file] = await sha256File(fullPath);
    }),
  );

  // Create manifest
  const manifest: OverlayManifest = {
    sha,
    deletions: deletedFiles,
    checksums,
  };

  // Create temp dir for the tarball and manifest
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-overlay-'));
  const manifestPath = path.join(tmpDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Copy manifest into repo-relative temp location for tar inclusion
  const manifestRelDir = '.kici-overlay-tmp';
  const manifestRepoDir = path.join(repoRoot, manifestRelDir);
  await fs.mkdir(manifestRepoDir, { recursive: true });
  await fs.copyFile(manifestPath, path.join(manifestRepoDir, 'manifest.json'));

  const tarballPath = path.join(tmpDir, 'overlay.tar.gz');

  try {
    // Create tar.gz
    const filesToInclude = [...existingFiles, path.join(manifestRelDir, 'manifest.json')];

    if (filesToInclude.length > 0) {
      await tarCreate(
        {
          gzip: true,
          file: tarballPath,
          cwd: repoRoot,
        },
        filesToInclude,
      );
    } else {
      // Empty tarball (no changes)
      await tarCreate(
        {
          gzip: true,
          file: tarballPath,
          cwd: repoRoot,
        },
        [],
      );
    }
  } finally {
    // Clean up temp manifest dir from repo
    await fs.rm(manifestRepoDir, { recursive: true, force: true });
  }

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
    fileCount: existingFiles.length,
    newFiles: newFiles.length,
    modifiedFiles: modifiedFiles.length,
    deletedFiles: deletedFiles.length,
    compressedSize,
    sha,
  };

  return { tarballPath, summary, manifest, hasRemote };
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
