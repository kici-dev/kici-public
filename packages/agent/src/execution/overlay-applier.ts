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
import os from 'node:os';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';
import { createLogger, toErrorMessage, sha256File, deriveSharedSecret } from '@kici-dev/shared';
import { downloadUrl } from './download.js';

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
  /** Whether all checksums were verified successfully */
  verified: boolean;
}

/**
 * Manifest describing the overlay contents.
 * Written by the CLI uploader, read by the agent.
 */
interface OverlayManifest {
  /** HEAD SHA the overlay is based on */
  sha: string;
  /** Files deleted locally (need to be removed on agent) */
  deletions: string[];
  /** SHA256 checksums of each included file */
  checksums: Record<string, string>;
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
 * Apply an overlay tarball to a cloned repository.
 *
 * Flow:
 * 1. Download encrypted tarball from tarballUrl
 * 2. Derive ECDH shared secret from orchestratorPrivateKey + cliPublicKey
 * 3. Decrypt tarball using AES-256-GCM
 * 4. Extract tar.gz to temp directory
 * 5. Read manifest.json and verify checksums
 * 6. Copy files to repoDir preserving directory structure
 * 7. Apply deletions from manifest
 * 8. Clean up temp files
 */
export async function applyOverlay(config: OverlayConfig): Promise<OverlayResult> {
  const { tarballUrl, cliPublicKey, orchestratorPrivateKey, repoDir } = config;

  // Create temp directory for extraction
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-overlay-'));

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

    // Step 6: Verify checksums
    const checksumFiles = Object.keys(manifest.checksums);
    const failedChecksums: string[] = [];

    for (const file of checksumFiles) {
      const extractedPath = path.join(extractDir, file);
      try {
        const actualHash = await sha256File(extractedPath);
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

    // Step 7: Copy files to repoDir
    let filesApplied = 0;

    for (const file of checksumFiles) {
      const srcPath = path.join(extractDir, file);
      const destPath = path.join(repoDir, file);

      // Create parent directory if needed
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
      filesApplied++;
    }

    // Step 8: Apply deletions
    let filesDeleted = 0;

    for (const file of manifest.deletions) {
      const targetPath = path.join(repoDir, file);
      try {
        await fs.unlink(targetPath);
        filesDeleted++;
      } catch {
        // File may not exist in clone (e.g., was only in working tree)
        logger.debug('Deletion target not found, skipping', { file });
      }
    }

    logger.info('Overlay applied successfully', { filesApplied, filesDeleted });

    return { filesApplied, filesDeleted, verified: true };
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
