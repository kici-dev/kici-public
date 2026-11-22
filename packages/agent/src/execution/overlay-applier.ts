/**
 * Builds a job workspace from a CLI-uploaded overlay: download, decrypt with an
 * X25519 ECDH shared secret, verify manifest checksums, then apply. A full-repo
 * run has no clone: the overlay fills an empty workspace with the working tree
 * and its `.git`. Any other run applies the overlay on top of the workspace
 * its checkout prepared.
 *
 * Wire format: [12-byte IV][16-byte auth tag][ciphertext], the scheme of
 * packages/compiler/src/remote/encryption.ts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import { overlayGitRecordSchema, type OverlayGitRecord } from '@kici-dev/engine';
import { createLogger, toErrorMessage, sha256File, deriveSharedSecret } from '@kici-dev/shared';
import { downloadUrl } from './download.js';
import {
  checkManifest,
  type CheckedManifest,
  type OverlayManifest,
} from './overlay-manifest-check.js';
import {
  extractOverlay,
  readExtractedRegularFile,
  skippedLinkNote,
  type SkippedLink,
} from './overlay-extract.js';
import { relinkFileSymlinks, type FileLinkCandidate } from './overlay-file-links.js';
import { applySymlinks, removeEmptyTree } from './overlay-symlinks.js';

const logger = createLogger({ prefix: 'overlay-applier' });

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

interface OverlayConfig {
  /** S3 pre-signed URL. */
  tarballUrl: string;
  /** Base64 DER/SPKI CLI ephemeral public key. */
  cliPublicKey: string;
  /** Base64 DER/PKCS8 orchestrator ephemeral private key. */
  orchestratorPrivateKey: string;
  repoDir: string;
  /** Apply only entries under this prefix (manifest checksums and deletions filtered the same way). */
  onlyPathPrefix?: '.kici/';
}

interface OverlayResult {
  filesApplied: number;
  filesDeleted: number;
  symlinksApplied: number;
  verified: boolean;
  /** What the shipped `.git` holds, when the manifest carries a valid record. */
  git?: OverlayGitRecord;
}

/** AES-256-GCM over the wire format in the file header. */
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
 * The file an extracted entry reads from, or why it is refused. The uploader
 * checksums a tracked symlink's target, so a link is dereferenced — only when
 * it and every directory above it resolve to a regular file inside the
 * extraction root; otherwise the copy would read an agent-host file into the
 * repo. Independent of the tar extractor dropping escaping links.
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

/** The copied file symlinks, for `relinkFileSymlinks`. */
function fileLinkCandidates(checked: CheckedManifest): FileLinkCandidate[] {
  return checked.copies.flatMap(({ key, dest, src, linkText, linkTarget }) =>
    linkText === undefined || linkTarget === undefined
      ? []
      : [{ key, dest, src, text: linkText, target: linkTarget }],
  );
}

/**
 * Write a validated overlay at the real paths the check resolved. Order:
 * deletions (so a path that changed between file, symlink and directory is
 * cleared first), then files, then directory symlinks, then file symlinks.
 */
async function applyChecked(
  checked: CheckedManifest,
  realRoot: string,
): Promise<Omit<OverlayResult, 'verified' | 'git'>> {
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
      // E.g. the file existed only in the working tree.
      logger.debug('Deletion target not found, skipping', { file });
    }
  }

  let filesApplied = 0;
  for (const { key, src: srcPath, dest: destPath } of checked.copies) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    // Replace a symlink rather than write through it. A directory here was
    // emptied by the deletions (the check proved it), so it is removed.
    const existing = await fs.lstat(destPath).catch(() => undefined);
    if (existing?.isSymbolicLink()) await fs.unlink(destPath);
    else if (existing?.isDirectory()) await removeEmptyTree(destPath, key);
    await fs.copyFile(srcPath, destPath);
    filesApplied++;
  }

  const symlinksApplied =
    (await applySymlinks(checked.links)) +
    (await relinkFileSymlinks(
      fileLinkCandidates(checked),
      realRoot,
      new Map(checked.copies.map((c) => [c.dest, c.src])),
    ));
  return { filesApplied, filesDeleted, symlinksApplied };
}

/** The manifest narrowed to the entries under `prefix`: files, deletions and directory symlinks alike. */
function filterManifest(manifest: OverlayManifest, prefix: string): OverlayManifest {
  // The prefix test reads the normalized key, so `.kici/../src/a.ts` (which
  // normalizes to `src/a.ts`) is not under `.kici/`.
  const under = (key: string): boolean => path.posix.normalize(key).startsWith(prefix);
  const pick = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => under(key)));
  return {
    ...manifest,
    deletions: manifest.deletions.filter(under),
    checksums: pick(manifest.checksums),
    ...(manifest.symlinks && { symlinks: pick(manifest.symlinks) }),
  };
}

const MANIFEST_PARTS = ['.kici-overlay-tmp', 'manifest.json'] as const;

/**
 * The manifest text, read as a regular file that no symlink leads to: a link
 * would read an agent-host file, or a FIFO or device, as the manifest.
 */
async function readManifest(
  extractDir: string,
  skippedLinks: readonly SkippedLink[],
): Promise<string> {
  const name = MANIFEST_PARTS.join('/');
  const read = await readExtractedRegularFile(extractDir, MANIFEST_PARTS);
  if ('refused' in read) throw new Error(`Overlay manifest refused: ${name}: ${read.refused}`);
  if ('missing' in read) {
    const why = skippedLinkNote(skippedLinks, name);
    throw new Error(
      `Overlay manifest not found: expected ${name} in tarball${why ? ` (${why})` : ''}`,
    );
  }
  return read.data.toString('utf-8');
}

/** Download, decrypt, extract, validate and checksum the manifest, then apply. */
export async function applyOverlay(config: OverlayConfig): Promise<OverlayResult> {
  const { tarballUrl, cliPublicKey, orchestratorPrivateKey, repoDir, onlyPathPrefix } = config;

  const { path: tmpDir, cleanup } = await makeTempDir('overlay');

  try {
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

    const cliPubKeyBuf = Buffer.from(cliPublicKey, 'base64');
    const orchPrivKeyBuf = Buffer.from(orchestratorPrivateKey, 'base64');
    const aesKey = deriveSharedSecret(orchPrivKeyBuf, cliPubKeyBuf);

    const decryptedData = decryptBuffer(encryptedData, aesKey);

    logger.info('Extracting overlay tarball', { size: decryptedData.length });

    const extractDir = path.join(tmpDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });

    let skippedLinks: SkippedLink[];
    try {
      ({ skippedLinks } = await extractOverlay(decryptedData, extractDir));
    } catch (err) {
      throw new Error(`Overlay extraction failed: ${toErrorMessage(err)}`);
    }
    for (const skipped of skippedLinks) {
      logger.warn('Overlay symlink entry not extracted', { ...skipped });
    }

    const fullManifest: OverlayManifest = JSON.parse(await readManifest(extractDir, skippedLinks));
    // fails-when: a checkout: false full-repo job gets the overlay's `.git` and repository files
    const manifest = onlyPathPrefix ? filterManifest(fullManifest, onlyPathPrefix) : fullManifest;
    const checked = await checkManifest(manifest, repoDir, extractDir);

    const failedChecksums: string[] = [];
    const realExtractRoot = await fs.realpath(extractDir);

    for (const copy of checked.copies) {
      const file = copy.key;
      try {
        const source = await resolveExtractedSource(realExtractRoot, copy.src);
        if ('refused' in source) {
          // fails-when: a link an older CLI shipped without its target reports only "file not found"
          failedChecksums.push(`${file}: ${skippedLinkNote(skippedLinks, file) ?? source.refused}`);
          continue;
        }
        const entry = await fs.lstat(copy.src);
        if (entry.isSymbolicLink()) {
          copy.linkText = await fs.readlink(copy.src);
          copy.linkTarget = path.relative(realExtractRoot, source.path);
        }
        // The copy reads the same resolved file the checksum covered.
        copy.src = source.path;
        const actualHash = await sha256File(source.path);
        if (actualHash !== manifest.checksums[file]) {
          failedChecksums.push(`${file}: expected ${manifest.checksums[file]}, got ${actualHash}`);
        }
      } catch {
        failedChecksums.push(
          `${file}: ${skippedLinkNote(skippedLinks, file) ?? 'file not found in tarball'}`,
        );
      }
    }

    if (failedChecksums.length > 0) {
      throw new Error(
        `Overlay checksum verification failed for ${failedChecksums.length} file(s):\n` +
          failedChecksums.map((f) => `  - ${f}`).join('\n'),
      );
    }

    const result = await applyChecked(checked, await fs.realpath(repoDir));
    logger.info('Overlay applied successfully', result);
    // A malformed record is dropped, never fatal: it only feeds a warning.
    const git = overlayGitRecordSchema.safeParse(fullManifest.git);
    return { ...result, verified: true, ...(git.success && { git: git.data }) };
  } finally {
    await cleanup().catch(() => {});
  }
}
