/**
 * Lazy dependency downloader: SHA-256-verified, extracted and cached for
 * offline use. An atomic rename keeps partial downloads out of the cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '@kici-dev/shared';
import type { LazyDep } from './registry.js';

/** @throws If the SHA-256 hex digest does not match. */
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

async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} from ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  const tar = await import('tar');
  await tar.extract({
    file: archivePath,
    cwd: destDir,
  });
}

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

/** Return the cached path, downloading, verifying and extracting on a miss. */
export async function ensureDep(dep: LazyDep, cacheDir: string): Promise<string> {
  const finalPath = path.join(cacheDir, dep.name, dep.version);

  if (fs.existsSync(finalPath)) {
    return finalPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  const tmpDir = path.join(cacheDir, `.tmp-${dep.name}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`Downloading ${dep.name} v${dep.version} for ${dep.platform}-${dep.arch}...`);
    const content = await downloadFile(dep.url);

    console.log(`Verifying SHA-256 integrity...`);
    verifyIntegrity(content, dep.sha256);

    const archiveExt =
      dep.archiveType === 'tar.gz' ? '.tar.gz' : dep.archiveType === 'zip' ? '.zip' : '';
    const archivePath = path.join(tmpDir, `archive${archiveExt}`);
    fs.writeFileSync(archivePath, content);

    console.log(`Extracting...`);
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    if (dep.archiveType === 'tar.gz') {
      await extractTarGz(archivePath, extractDir);
    } else if (dep.archiveType === 'zip') {
      await extractZip(archivePath, extractDir);
    } else if (dep.archiveType === 'binary') {
      const destPath = path.join(extractDir, path.basename(dep.extractPath));
      fs.copyFileSync(archivePath, destPath);
      fs.chmodSync(destPath, 0o755);
    }

    // Atomic rename into the cache.
    const parentDir = path.dirname(finalPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.renameSync(extractDir, finalPath);

    console.log(`Cached ${dep.name} v${dep.version} at ${finalPath}`);
    return finalPath;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
