import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { create as tarCreate } from 'tar';
import { deriveSharedSecret } from '@kici-dev/shared';
import { applyOverlay } from './overlay-applier.js';

// --- Helpers ---

const IV_LENGTH = 12;
const HKDF_INFO = 'kici-upload-encryption';
const HKDF_SALT = Buffer.alloc(0);

/** Generate an X25519 keypair (DER-encoded buffers). */
function generateKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

/** Encrypt a buffer using the same scheme as the CLI uploader. */
function encryptBuffer(data: Buffer, aesKey: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Compute SHA256 of a buffer. */
function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Create a complete encrypted overlay tarball for testing.
 *
 * Returns the encrypted data, the CLI public key, and orchestrator private key
 * needed by the agent to decrypt.
 */
async function createTestOverlay(
  tmpDir: string,
  files: Record<string, string>,
  deletions: string[] = [],
): Promise<{ encryptedData: Buffer; cliPublicKey: string; orchestratorPrivateKey: string }> {
  // Generate keypairs (simulating orchestrator and CLI)
  const orchestratorKp = generateKeypair();
  const cliKp = generateKeypair();

  // Create files in a staging directory
  const stagingDir = path.join(tmpDir, 'staging');
  await fs.mkdir(stagingDir, { recursive: true });

  // Build checksums and write files
  const checksums: Record<string, string> = {};
  const fileList: string[] = [];

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(stagingDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    checksums[filePath] = sha256(Buffer.from(content));
    fileList.push(filePath);
  }

  // Write manifest
  const manifestDir = path.join(stagingDir, '.kici-overlay-tmp');
  await fs.mkdir(manifestDir, { recursive: true });
  const manifest = { sha: 'abc123', deletions, checksums };
  await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));

  // Create tarball
  const tarballPath = path.join(tmpDir, 'overlay.tar.gz');
  await tarCreate({ gzip: true, file: tarballPath, cwd: stagingDir }, [
    ...fileList,
    '.kici-overlay-tmp/manifest.json',
  ]);

  const tarballData = await fs.readFile(tarballPath);

  // Derive shared secret (CLI side: cli private + orchestrator public)
  const aesKey = deriveSharedSecret(cliKp.privateKey, orchestratorKp.publicKey);

  // Encrypt tarball
  const encryptedData = encryptBuffer(tarballData, aesKey);

  return {
    encryptedData,
    cliPublicKey: cliKp.publicKey.toString('base64'),
    orchestratorPrivateKey: orchestratorKp.privateKey.toString('base64'),
  };
}

// --- Tests ---

describe('overlay-applier', () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-overlay-test-'));
    repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('deriveSharedSecret', () => {
    it('derives same shared secret from both sides', () => {
      const alice = generateKeypair();
      const bob = generateKeypair();

      const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey);

      expect(secretA.equals(secretB)).toBe(true);
    });

    it('derives 32-byte AES-256 key', () => {
      const alice = generateKeypair();
      const bob = generateKeypair();
      const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.length).toBe(32);
    });
  });

  describe('applyOverlay', () => {
    it('downloads, decrypts, and applies overlay files', async () => {
      // Create existing file in repo
      await fs.writeFile(path.join(repoDir, 'existing.txt'), 'old content');

      // Create overlay with modified + new files
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        {
          'existing.txt': 'updated content',
          'new-file.txt': 'brand new',
          'src/deep/nested.ts': 'nested content',
        },
      );

      // Serve encrypted data via mock -- mock downloadUrl
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      const result = await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(result.filesApplied).toBe(3);
      expect(result.filesDeleted).toBe(0);
      expect(result.verified).toBe(true);

      // Verify files were written
      const existing = await fs.readFile(path.join(repoDir, 'existing.txt'), 'utf-8');
      expect(existing).toBe('updated content');

      const newFile = await fs.readFile(path.join(repoDir, 'new-file.txt'), 'utf-8');
      expect(newFile).toBe('brand new');

      const nested = await fs.readFile(path.join(repoDir, 'src/deep/nested.ts'), 'utf-8');
      expect(nested).toBe('nested content');
    });

    it('applies deletions from manifest', async () => {
      // Create files to be deleted in repo
      await fs.writeFile(path.join(repoDir, 'to-delete.txt'), 'will be deleted');
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(repoDir, 'src/remove-me.ts'), 'also deleted');

      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'keep.txt': 'keep this' },
        ['to-delete.txt', 'src/remove-me.ts'],
      );

      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      const result = await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(result.filesApplied).toBe(1);
      expect(result.filesDeleted).toBe(2);
      expect(result.verified).toBe(true);

      // Verify deletions
      await expect(fs.access(path.join(repoDir, 'to-delete.txt'))).rejects.toThrow();
      await expect(fs.access(path.join(repoDir, 'src/remove-me.ts'))).rejects.toThrow();

      // Verify kept file
      const kept = await fs.readFile(path.join(repoDir, 'keep.txt'), 'utf-8');
      expect(kept).toBe('keep this');
    });

    it('verifies checksums match extracted files', async () => {
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'hello.txt': 'hello world' },
      );

      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      const result = await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(result.verified).toBe(true);
    });

    it('throws on checksum mismatch', async () => {
      // Create overlay with correct checksums
      const orchestratorKp = generateKeypair();
      const cliKp = generateKeypair();

      const stagingDir = path.join(tmpDir, 'staging-bad');
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'file.txt'), 'real content');

      // Write manifest with WRONG checksums
      const manifestDir = path.join(stagingDir, '.kici-overlay-tmp');
      await fs.mkdir(manifestDir, { recursive: true });
      const manifest = {
        sha: 'abc123',
        deletions: [],
        checksums: { 'file.txt': 'deadbeef_wrong_checksum' },
      };
      await fs.writeFile(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest));

      const tarballPath = path.join(tmpDir, 'bad-overlay.tar.gz');
      await tarCreate({ gzip: true, file: tarballPath, cwd: stagingDir }, [
        'file.txt',
        '.kici-overlay-tmp/manifest.json',
      ]);

      const tarballData = await fs.readFile(tarballPath);
      const aesKey = deriveSharedSecret(cliKp.privateKey, orchestratorKp.publicKey);
      const encryptedData = encryptBuffer(tarballData, aesKey);

      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      await expect(
        applyOverlay({
          tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
          cliPublicKey: cliKp.publicKey.toString('base64'),
          orchestratorPrivateKey: orchestratorKp.privateKey.toString('base64'),
          repoDir,
        }),
      ).rejects.toThrow(/checksum verification failed/i);
    });

    it('throws on decryption failure with wrong key', async () => {
      const { encryptedData } = await createTestOverlay(tmpDir, { 'file.txt': 'content' });

      // Use a completely different keypair for decryption (will fail)
      const wrongKp = generateKeypair();
      const wrongCli = generateKeypair();

      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      await expect(
        applyOverlay({
          tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
          cliPublicKey: wrongCli.publicKey.toString('base64'),
          orchestratorPrivateKey: wrongKp.privateKey.toString('base64'),
          repoDir,
        }),
      ).rejects.toThrow(/tarball decryption failed/i);
    });

    it('throws on download failure', async () => {
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockRejectedValue(new Error('HTTP 404'));

      await expect(
        applyOverlay({
          tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
          cliPublicKey: 'dummyKey',
          orchestratorPrivateKey: 'dummyKey',
          repoDir,
        }),
      ).rejects.toThrow(/overlay download failed/i);
    });

    it('handles deletion of non-existent files gracefully', async () => {
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'file.txt': 'content' },
        ['does-not-exist.txt'],
      );

      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      // Should not throw -- deletion of missing file is a no-op
      const result = await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(result.filesApplied).toBe(1);
      expect(result.filesDeleted).toBe(0); // File didn't exist, so not counted
      expect(result.verified).toBe(true);
    });
  });
});
