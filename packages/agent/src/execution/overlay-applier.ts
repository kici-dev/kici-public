/**
 * Agent-side overlay application.
 *
 * Downloads an encrypted tarball uploaded by the CLI, decrypts it using
 * X25519 ECDH shared secret, verifies file checksums from the manifest,
 * and applies the overlay (file additions/modifications + deletions)
 * on top of the cloned repository.
 *
 * Wire format: [12-byte IV][16-byte auth tag][ciphertext]
 * Same encryption scheme as packages/compiler/src/remote/encryption.ts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';
import { createLogger, toErrorMessage, sha256File, deriveSharedSecret } from '@kici-dev/shared';
import { downloadUrl } from './download.js';
import {
  checkManifest,
  type CheckedManifest,
  type OverlayManifest,
} from './overlay-manifest-check.js';
import { applySymlinks, removeEmptyTree } from './overlay-symlinks.js';

const logger = createLogger({ prefix: 'overlay-applier' });

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Configuration for applying an overlay to a cloned repo.
 */
interface OverlayConfig {
  /** URL to download the encrypted tarball from (S3 pre-signed URL) */
  tarballUrl: string;
  /** Base64-encoded CLI ephemeral public key (DER/SPKI format) */
  cliPublicKey: string;
  /** Base64-encoded orchestrator ephemeral private key (DER/PKCS8 format) */
  orchestratorPrivateKey: string;
  /** Path to the cloned repository directory */
  repoDir: string;
}

/**
 * Result of applying an overlay.
 */
interface OverlayResult {
  /** Number of files copied/overwritten in the repo */
  filesApplied: number;
  /** Number of files deleted from the repo */
  filesDeleted: number;
  /** Number of directory symlinks created in the repo */
  symlinksApplied: number;
  /** Whether all checksums were verified successfully */
  verified: boolean;
}

/**
 * Decrypt an encrypted buffer using AES-256-GCM.
 *
 * Wire format: [12-byte IV][16-byte auth tag][ciphertext]
 */
function decryptBuffer(encrypted: Buffer, aesKey: Buffer): Buffer {
  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      `Tarball decryption failed: encrypted data too short (${encrypted.length} bytes, ` +
        `minimum ${IV_LENGTH + AUTH_TAG_LENGTH} bytes)`,
    );
  }

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(`Tarball decryption failed: ${toErrorMessage(err)}`);
  }
}

/**
 * The file an extracted overlay entry actually reads from, or why it is refused.
 *
 * The uploader ships a tracked symlink as a symlink entry and checksums the
 * content it points at, so a link is dereferenced — as long as it, and every
 * directory on the way to it, resolves to a regular file inside the extraction
 * root. A link to anywhere else would make the copy read a file of the agent
 * host into the repository. The tar extractor already drops a link whose
 * target leaves the extraction directory; this check does not rely on that.
 */
export async function resolveExtractedSource(
  realExtractRoot: string,
  src: string,
): Promise<{ path: string } | { refused: string }> {
  let real: string;
  try {
    real = await fs.realpath(src);
  } catch {
    return { refused: 'file not found in tarball' };
  }
  // fails-when: an entry, or a directory above it, is a symlink leaving the extraction root
  // breaks-if-wrong: an in-tree relative file symlink must still dereference to its target
  if (!real.startsWith(realExtractRoot + path.sep)) {
    return { refused: 'resolves outside the overlay' };
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) return { refused: 'does not resolve to a regular file' };
  return { path: real };
}

/**
 * Write a validated overlay into the repository, at the real paths the check
 * resolved. Deletions run first, so a path the developer turned from a file or
 * a symlink into a directory (or back) is cleared before its new content lands;
 * files run next; directory symlinks run last, once the files and deletions
 * they may replace are in place.
 */
async function applyChecked(checked: CheckedManifest): Promise<Omit<OverlayResult, 'verified'>> {
  let filesDeleted = 0;
  for (const { key: file, target: targetPath, mustRemove } of checked.deletions) {
    try {
      await fs.unlink(targetPath);
      filesDeleted++;
    } catch (err) {
      // fails-when: a file or link the check counted as deleted is still there
      // breaks-if-wrong: a deletion whose file the clone never had is still skipped
      if (mustRemove) {
        throw new Error(
          `Overlay deletion of ${JSON.stringify(file)} failed: ${toErrorMessage(err)}`,
        );
      }
      // File may not exist in clone (e.g., was only in working tree)
      logger.debug('Deletion target not found, skipping', { file });
    }
  }

  let filesApplied = 0;
  for (const { key, src: srcPath, dest: destPath } of checked.copies) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    // A symlink at the destination is replaced, not written through: copying
    // onto it would write the file it points at. A directory there was emptied
    // by the deletions (the check proved it), so it is removed.
    const existing = await fs.lstat(destPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) await fs.unlink(destPath);
    else if (existing?.isDirectory()) await removeEmptyTree(destPath, key);
    await fs.copyFile(srcPath, destPath);
    filesApplied++;
  }

  const symlinksApplied = await applySymlinks(checked.links);
  return { filesApplied, filesDeleted, symlinksApplied };
}

/**
 * Apply an overlay tarball to a cloned repository.
 *
 * Flow:
 * 1. Download encrypted tarball from tarballUrl
 * 2. Derive ECDH shared secret from orchestratorPrivateKey + cliPublicKey
 * 3. Decrypt tarball using AES-256-GCM
 * 4. Extract tar.gz to temp directory
 * 5. Read manifest.json, validate every path, and verify checksums
 * 6. Apply deletions from manifest
 * 7. Copy files to repoDir preserving directory structure
 * 8. Create the manifest's directory symlinks
 * 9. Clean up temp files
 */
export async function applyOverlay(config: OverlayConfig): Promise<OverlayResult> {
  const { tarballUrl, cliPublicKey, orchestratorPrivateKey, repoDir } = config;

  // Create temp directory for extraction
  const { path: tmpDir, cleanup } = await makeTempDir('overlay');

  try {
    // Step 1: Download encrypted tarball
    logger.info('Downloading overlay tarball', {
      url: tarballUrl.replace(/\?.*$/, '?[redacted]'),
    });

    let encryptedData: Buffer;
    try {
      encryptedData = await downloadUrl(tarballUrl);
    } catch (err) {
      throw new Error(
        `Overlay download failed from ${tarballUrl.replace(/\?.*$/, '?[redacted]')}: ` +
          `${toErrorMessage(err)}`,
      );
    }

    // Step 2: Derive shared secret
    const cliPubKeyBuf = Buffer.from(cliPublicKey, 'base64');
    const orchPrivKeyBuf = Buffer.from(orchestratorPrivateKey, 'base64');
    const aesKey = deriveSharedSecret(orchPrivKeyBuf, cliPubKeyBuf);

    // Step 3: Decrypt tarball
    const decryptedData = decryptBuffer(encryptedData, aesKey);

    // Step 4: Extract tar.gz to temp directory
    logger.info('Extracting overlay tarball', { size: decryptedData.length });

    const extractDir = path.join(tmpDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });

    try {
      const readable = Readable.from(decryptedData);
      await new Promise<void>((resolve, reject) => {
        readable
          .pipe(tarExtract({ cwd: extractDir, gzip: true }))
          .on('finish', resolve)
          .on('error', reject);
      });
    } catch (err) {
      throw new Error(`Overlay extraction failed: ${toErrorMessage(err)}`);
    }

    // Step 5: Read manifest
    const manifestPath = path.join(extractDir, '.kici-overlay-tmp', 'manifest.json');
    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      throw new Error(
        'Overlay manifest not found: expected .kici-overlay-tmp/manifest.json in tarball',
      );
    }

    const manifest: OverlayManifest = JSON.parse(manifestContent);
    const checked = await checkManifest(manifest, repoDir, extractDir);

    // Step 6: Verify checksums. Each entry is read through its real path, which
    // must be a regular file inside the extraction root: a symlink entry is
    // followed to its in-tree target, never to a file elsewhere on the host.
    const failedChecksums: string[] = [];
    const realExtractRoot = await fs.realpath(extractDir);

    for (const copy of checked.copies) {
      const file = copy.key;
      try {
        const source = await resolveExtractedSource(realExtractRoot, copy.src);
        if ('refused' in source) {
          failedChecksums.push(`${file}: ${source.refused}`);
          continue;
        }
        // The copy below reads the same resolved file the checksum covered.
        copy.src = source.path;
        const actualHash = await sha256File(source.path);
        if (actualHash !== manifest.checksums[file]) {
          failedChecksums.push(`${file}: expected ${manifest.checksums[file]}, got ${actualHash}`);
        }
      } catch {
        failedChecksums.push(`${file}: file not found in tarball`);
      }
    }

    if (failedChecksums.length > 0) {
      throw new Error(
        `Overlay checksum verification failed for ${failedChecksums.length} file(s):\n` +
          failedChecksums.map((f) => `  - ${f}`).join('\n'),
      );
    }

    // Steps 7-9: deletions, then files, then directory symlinks.
    const result = await applyChecked(checked);
    logger.info('Overlay applied successfully', result);
    return { ...result, verified: true };
  } finally {
    // Clean up temp directory
    await cleanup().catch(() => {});
  }
}
