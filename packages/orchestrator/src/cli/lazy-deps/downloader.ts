/**
 * Lazy dependency downloader with integrity verification.
 *
 * Downloads, verifies SHA-256 integrity, extracts archives, and caches
 * dependencies for offline use. Uses atomic rename to prevent partial
 * downloads from polluting the cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '@kici-dev/shared';
import type { LazyDep } from './registry.js';

/**
 * Verify SHA-256 integrity of downloaded content.
 *
 * @param content - Downloaded file contents as a Buffer
 * @param expectedHash - Expected SHA-256 hex digest
 * @throws If the hash does not match
 */
export function verifyIntegrity(content: Buffer, expectedHash: string): void {
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 integrity check failed.\n` +
        `  Expected: ${expectedHash}\n` +
        `  Actual:   ${actualHash}`,
    );
  }
}

/**
 * Download a file from a URL, following redirects.
 *
 * @param url - URL to download from
 * @returns Downloaded content as a Buffer
 */
async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} from ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Extract a .tar.gz archive to a directory.
 *
 * Uses node:zlib for gunzip and the `tar` npm package for extraction.
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  const tar = await import('tar');
  await tar.extract({
    file: archivePath,
    cwd: destDir,
  });
}

/**
 * Extract a .zip archive to a directory.
 *
 * On Windows, uses PowerShell Expand-Archive.
 * On Unix, uses the `unzip` CLI.
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'ignore' },
    );
  } else {
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'ignore' });
  }
}

/**
 * Ensure a lazy dependency is available in the cache.
 *
 * Flow:
 * 1. Check if already cached -> return path immediately
 * 2. Download from URL to temp directory
 * 3. Verify SHA-256 integrity
 * 4. Extract archive
 * 5. Atomic rename to final cache location
 * 6. Return path to cached dependency
 *
 * @param dep - Dependency metadata from the registry
 * @param cacheDir - Base cache directory
 * @returns Path to the cached dependency
 */
export async function ensureDep(dep: LazyDep, cacheDir: string): Promise<string> {
  const finalPath = path.join(cacheDir, dep.name, dep.version);

  // Cache hit - skip download entirely
  if (fs.existsSync(finalPath)) {
    return finalPath;
  }

  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  // Create temp directory for atomic operation
  const tmpDir = path.join(cacheDir, `.tmp-${dep.name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Download
    console.log(`Downloading ${dep.name} v${dep.version} for ${dep.platform}-${dep.arch}...`);
    const content = await downloadFile(dep.url);

    // Verify integrity
    console.log(`Verifying SHA-256 integrity...`);
    verifyIntegrity(content, dep.sha256);

    // Write archive to temp
    const archiveExt =
      dep.archiveType === 'tar.gz' ? '.tar.gz' : dep.archiveType === 'zip' ? '.zip' : '';
    const archivePath = path.join(tmpDir, `archive${archiveExt}`);
    fs.writeFileSync(archivePath, content);

    // Extract
    console.log(`Extracting...`);
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    if (dep.archiveType === 'tar.gz') {
      await extractTarGz(archivePath, extractDir);
    } else if (dep.archiveType === 'zip') {
      await extractZip(archivePath, extractDir);
    } else if (dep.archiveType === 'binary') {
      // Binary files are used directly - just copy to extracted dir
      const destPath = path.join(extractDir, path.basename(dep.extractPath));
      fs.copyFileSync(archivePath, destPath);
      fs.chmodSync(destPath, 0o755);
    }

    // Atomic rename: move extracted content to final cache location
    const parentDir = path.dirname(finalPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.renameSync(extractDir, finalPath);

    console.log(`Cached ${dep.name} v${dep.version} at ${finalPath}`);
    return finalPath;
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
