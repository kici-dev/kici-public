import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { create as tarCreate } from 'tar';
import { deriveSharedSecret } from '@kici-dev/shared';
import { applyOverlay, resolveExtractedSource } from './overlay-applier.js';

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
  /** Manifest checksum keys with no file in the tarball (for hostile manifests). */
  extraChecksums: Record<string, string> = {},
  /**
   * Symlink entries, shipped the way the uploader ships a tracked symlink: a
   * SymbolicLink tar entry (node-tar's default `follow: false`) whose manifest
   * checksum covers the content it points at. `hashOf` is that content.
   */
  symlinks: Record<string, { target: string; hashOf: string }> = {},
  /**
   * Directory symlinks, shipped the way the uploader ships them: a link entry
   * in the tarball, and the link text in the manifest's `symlinks` map.
   */
  dirLinks: Record<string, string> = {},
  /** Manifest fields written over the generated ones (for malformed manifests). */
  manifestOverride: Record<string, unknown> = {},
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

  for (const [linkPath, { target, hashOf }] of Object.entries(symlinks)) {
    const fullPath = path.join(stagingDir, linkPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.symlink(target, fullPath);
    checksums[linkPath] = sha256(Buffer.from(hashOf));
    fileList.push(linkPath);
  }

  for (const [linkPath, text] of Object.entries(dirLinks)) {
    const fullPath = path.join(stagingDir, linkPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.symlink(text, fullPath);
    fileList.push(linkPath);
  }

  // Write manifest
  const manifestDir = path.join(stagingDir, '.kici-overlay-tmp');
  await fs.mkdir(manifestDir, { recursive: true });
  const manifest = {
    sha: 'abc123',
    deletions,
    checksums: { ...checksums, ...extraChecksums },
    ...(Object.keys(dirLinks).length > 0 ? { symlinks: dirLinks } : {}),
    ...manifestOverride,
  };
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

  describe('path containment', () => {
    /**
     * Apply a hostile overlay next to a normal one and prove the refusal is
     * total: the error names the bad key, and neither the sentinel outside the
     * repository nor the file the overlay would have written inside it changed.
     */
    async function expectRefused(
      opts: { deletions?: string[]; extraChecksums?: Record<string, string> },
      pattern: RegExp,
    ): Promise<void> {
      const outside = path.join(tmpDir, 'outside.txt');
      await fs.writeFile(outside, 'agent-owned');
      await fs.writeFile(path.join(repoDir, 'inside.txt'), 'original');
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'inside.txt': 'overwritten' },
        opts.deletions ?? [],
        opts.extraChecksums ?? {},
      );
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      await expect(
        applyOverlay({
          tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
          cliPublicKey,
          orchestratorPrivateKey,
          repoDir,
        }),
      ).rejects.toThrow(pattern);

      expect(await fs.readFile(outside, 'utf-8')).toBe('agent-owned');
      // Validation runs before any write, so the good entry is not applied either.
      expect(await fs.readFile(path.join(repoDir, 'inside.txt'), 'utf-8')).toBe('original');
    }

    it('refuses a deletion that climbs out with ../', async () => {
      // fails-when: the deletion is joined onto repoDir and unlinks ../outside.txt
      await expectRefused({ deletions: ['../outside.txt'] }, /resolves outside the repository/);
    });

    it('refuses a file entry that climbs out with ../', async () => {
      await expectRefused(
        { extraChecksums: { '../outside.txt': 'a'.repeat(64) } },
        /resolves outside the repository/,
      );
    });

    it('refuses an absolute path', async () => {
      await expectRefused({ deletions: [path.join(tmpDir, 'outside.txt')] }, /is an absolute path/);
    });

    it('refuses a path that climbs out through an inner directory', async () => {
      await expectRefused(
        { deletions: ['a/../../outside.txt'] },
        /resolves outside the repository/,
      );
    });

    it('refuses a path carrying a NUL byte', async () => {
      await expectRefused({ deletions: ['inside.txt\u0000.bak'] }, /contains a NUL byte/);
    });

    it('refuses a path that leaves through a symlinked directory in the repository', async () => {
      const outsideDir = path.join(tmpDir, 'outside-dir');
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(outsideDir, 'victim.txt'), 'agent-owned');
      await fs.symlink(outsideDir, path.join(repoDir, 'link'));

      await expectRefused(
        {
          deletions: ['link/victim.txt'],
          extraChecksums: { 'link/pwn.txt': 'a'.repeat(64) },
        },
        /passes through a symlink out of the repository/,
      );
      expect(await fs.readFile(path.join(outsideDir, 'victim.txt'), 'utf-8')).toBe('agent-owned');
      await expect(fs.access(path.join(outsideDir, 'pwn.txt'))).rejects.toThrow();
    });

    it('replaces a symlinked file in the repository instead of writing through it', async () => {
      // breaks-if-wrong: an overlay file whose destination is a symlink must still land
      const outside = path.join(tmpDir, 'target.txt');
      await fs.writeFile(outside, 'agent-owned');
      await fs.symlink(outside, path.join(repoDir, 'config.txt'));
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'config.txt': 'from overlay' },
      );
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(await fs.readFile(outside, 'utf-8')).toBe('agent-owned');
      const written = path.join(repoDir, 'config.txt');
      expect((await fs.lstat(written)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(written, 'utf-8')).toBe('from overlay');
    });

    it('refuses a file beneath a repository symlink that does not resolve', async () => {
      await fs.symlink('nowhere', path.join(repoDir, 'd'));
      // fails-when: the dangling link reads as a missing directory, which mkdir would follow
      await expectRefused(
        { extraChecksums: { 'd/f': 'a'.repeat(64) } },
        /"d\/f" \(file\): passes through a symlink that does not resolve/,
      );
      await expect(fs.access(path.join(repoDir, 'nowhere'))).rejects.toThrow();
    });

    it('refuses a file beneath another file of the overlay', async () => {
      await expectRefused(
        { extraChecksums: { a: 'a'.repeat(64), 'a/b': 'b'.repeat(64) } },
        /"a\/b" \(file\): lies beneath the file "a"/,
      );
    });

    it('still applies a nested path and a nested deletion', async () => {
      // breaks-if-wrong: the containment check must admit ordinary repository paths
      await fs.mkdir(path.join(repoDir, 'src/old'), { recursive: true });
      await fs.writeFile(path.join(repoDir, 'src/old/gone.ts'), 'x');
      const { encryptedData, cliPublicKey, orchestratorPrivateKey } = await createTestOverlay(
        tmpDir,
        { 'src/a/b.ts': 'nested' },
        ['src/old/gone.ts'],
      );
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(encryptedData);

      const result = await applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir,
      });

      expect(result).toMatchObject({ filesApplied: 1, filesDeleted: 1 });
      expect(await fs.readFile(path.join(repoDir, 'src/a/b.ts'), 'utf-8')).toBe('nested');
      await expect(fs.access(path.join(repoDir, 'src/old/gone.ts'))).rejects.toThrow();
    });
  });

  describe('resolveExtractedSource', () => {
    // The tar extractor never produces an escaping link, so the resolver is
    // driven with links planted directly in an extraction directory.
    let extractRoot: string;
    let outsideFile: string;
    beforeEach(async () => {
      extractRoot = path.join(tmpDir, 'extracted');
      await fs.mkdir(path.join(extractRoot, 'docs'), { recursive: true });
      await fs.writeFile(path.join(extractRoot, 'docs/alerts.yaml'), 'groups: []');
      outsideFile = path.join(tmpDir, 'host-secret.txt');
      await fs.writeFile(outsideFile, 'agent-owned');
    });

    it('dereferences an in-tree file link to its target', async () => {
      // breaks-if-wrong: a tracked relative file symlink must still resolve
      await fs.symlink('docs/alerts.yaml', path.join(extractRoot, 'alerts.yaml'));
      const real = await fs.realpath(extractRoot);
      expect(await resolveExtractedSource(real, path.join(extractRoot, 'alerts.yaml'))).toEqual({
        path: path.join(real, 'docs/alerts.yaml'),
      });
    });

    it('refuses a link to a file outside the extraction root', async () => {
      // fails-when: the resolver follows the link without checking where it lands
      await fs.symlink(outsideFile, path.join(extractRoot, 'leak.txt'));
      const real = await fs.realpath(extractRoot);
      expect(await resolveExtractedSource(real, path.join(extractRoot, 'leak.txt'))).toEqual({
        refused: 'resolves outside the overlay',
      });
    });

    it('refuses an entry reached through a symlinked directory leaving the root', async () => {
      await fs.symlink(tmpDir, path.join(extractRoot, 'dir'));
      const real = await fs.realpath(extractRoot);
      expect(
        await resolveExtractedSource(real, path.join(extractRoot, 'dir/host-secret.txt')),
      ).toEqual({ refused: 'resolves outside the overlay' });
    });

    it('refuses a link to a directory', async () => {
      await fs.symlink('docs', path.join(extractRoot, 'docs-link'));
      const real = await fs.realpath(extractRoot);
      expect(await resolveExtractedSource(real, path.join(extractRoot, 'docs-link'))).toEqual({
        refused: 'does not resolve to a regular file',
      });
    });
  });

  describe('symlink entries', () => {
    /**
     * A relative link target that climbs from wherever the tarball is extracted
     * to `absolute`. The tar extractor drops such a link (as it drops an
     * absolute one), so through a tarball the entry arrives missing; the
     * resolver's own refusal is proved directly below.
     */
    const climbTo = (absolute: string): string => '../'.repeat(40) + absolute.replace(/^\/+/, '');

    async function apply(overlay: {
      encryptedData: Buffer;
      cliPublicKey: string;
      orchestratorPrivateKey: string;
    }) {
      const downloadMod = await import('./download.js');
      vi.spyOn(downloadMod, 'downloadUrl').mockResolvedValue(overlay.encryptedData);
      return applyOverlay({
        tarballUrl: 'https://s3.example.com/test.tar.gz.enc',
        cliPublicKey: overlay.cliPublicKey,
        orchestratorPrivateKey: overlay.orchestratorPrivateKey,
        repoDir,
      });
    }

    it('applies a tracked relative file symlink as its target content', async () => {
      // breaks-if-wrong: a repository with a tracked file symlink (this one has
      // docs-site/public/monitoring-pack/* -> docs/) must still run remotely.
      const overlay = await createTestOverlay(
        tmpDir,
        { 'docs/alerts.yaml': 'groups: []' },
        [],
        {},
        { 'site/alerts.yaml': { target: '../docs/alerts.yaml', hashOf: 'groups: []' } },
      );

      const result = await apply(overlay);

      expect(result.filesApplied).toBe(2);
      const dest = path.join(repoDir, 'site/alerts.yaml');
      expect(await fs.readFile(dest, 'utf-8')).toBe('groups: []');
    });

    it('refuses a symlink entry that points outside the extraction root', async () => {
      const outside = path.join(tmpDir, 'host-secret.txt');
      await fs.writeFile(outside, 'agent-owned');
      const overlay = await createTestOverlay(
        tmpDir,
        { 'inside.txt': 'overwritten' },
        [],
        {},
        { 'leak.txt': { target: climbTo(outside), hashOf: 'agent-owned' } },
      );
      await fs.writeFile(path.join(repoDir, 'inside.txt'), 'original');

      // fails-when: the applier follows the link to the host file and copies it in
      await expect(apply(overlay)).rejects.toThrow(
        /leak\.txt: (resolves outside the overlay|file not found in tarball)/,
      );
      await expect(fs.access(path.join(repoDir, 'leak.txt'))).rejects.toThrow();
      expect(await fs.readFile(path.join(repoDir, 'inside.txt'), 'utf-8')).toBe('original');
    });

    it('refuses an entry reached through a symlinked directory that leaves the extraction root', async () => {
      const outsideDir = path.join(tmpDir, 'host-dir');
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'agent-owned');
      // The tarball carries the `dir` link entry, but the manifest lists only the
      // file beneath it: listing `dir` too is refused before extraction is read.
      const secretHash = sha256(Buffer.from('agent-owned'));
      const overlay = await createTestOverlay(
        tmpDir,
        {},
        [],
        {},
        { dir: { target: climbTo(outsideDir), hashOf: '' } },
        {},
        { checksums: { 'dir/secret.txt': secretHash } },
      );

      await expect(apply(overlay)).rejects.toThrow(
        /dir\/secret\.txt: (resolves outside the overlay|file not found in tarball)/,
      );
      await expect(fs.access(path.join(repoDir, 'dir/secret.txt'))).rejects.toThrow();
    });

    describe('a changed file symlink over a clone', () => {
      /** A clone carrying two docs and a link to the first. */
      beforeEach(async () => {
        await fs.mkdir(path.join(repoDir, 'docs'));
        await fs.mkdir(path.join(repoDir, 'site'));
        await fs.writeFile(path.join(repoDir, 'docs/a.yaml'), 'a');
        await fs.writeFile(path.join(repoDir, 'docs/b.yaml'), 'b');
        await fs.symlink('../docs/a.yaml', path.join(repoDir, 'site/alerts.yaml'));
      });

      const changedLink = { 'site/alerts.yaml': { target: '../docs/b.yaml', hashOf: 'b' } };

      it('applies the link when its unchanged target ships with it', async () => {
        // breaks-if-wrong: the uploader ships the target, so the link must dereference to it
        const overlay = await createTestOverlay(
          tmpDir,
          { 'docs/b.yaml': 'b' },
          [],
          {},
          changedLink,
        );

        await apply(overlay);

        expect(await fs.readFile(path.join(repoDir, 'site/alerts.yaml'), 'utf-8')).toBe('b');
      });

      it('refuses the link when it ships without its target', async () => {
        // fails-when: the link alone is shipped and the applier reads the clone's file through it
        const overlay = await createTestOverlay(tmpDir, {}, [], {}, changedLink);

        await expect(apply(overlay)).rejects.toThrow(
          /site\/alerts\.yaml: file not found in tarball/,
        );
        expect(await fs.readlink(path.join(repoDir, 'site/alerts.yaml'))).toBe('../docs/a.yaml');
      });
    });

    describe('directory symlinks', () => {
      /** Ship directory links (plus an ordinary file), then read back each link's text. */
      async function applyDirLinks(
        dirLinks: Record<string, string>,
        opts: { files?: Record<string, string>; deletions?: string[] } = {},
      ) {
        const overlay = await createTestOverlay(
          tmpDir,
          opts.files ?? {},
          opts.deletions ?? [],
          {},
          {},
          dirLinks,
        );
        return apply(overlay);
      }

      it('recreates a contained relative directory symlink', async () => {
        // breaks-if-wrong: a repository with a tracked `lib -> shared` link must still run remotely
        const result = await applyDirLinks({ lib: 'shared' }, { files: { 'shared/a.txt': 'a' } });

        expect(result).toMatchObject({ filesApplied: 1, symlinksApplied: 1 });
        expect(await fs.readlink(path.join(repoDir, 'lib'))).toBe('shared');
        expect(await fs.readFile(path.join(repoDir, 'lib/a.txt'), 'utf-8')).toBe('a');
      });

      it('recreates a nested link that climbs to a sibling inside the repository', async () => {
        // breaks-if-wrong: `..` inside the repository is ordinary, not an escape
        await applyDirLinks({ 'packages/app/lib': '../../shared' });

        expect(await fs.readlink(path.join(repoDir, 'packages/app/lib'))).toBe('../../shared');
      });

      it('replaces a link the clone already has', async () => {
        await fs.mkdir(path.join(repoDir, 'shared'));
        await fs.symlink('shared', path.join(repoDir, 'lib'));

        await applyDirLinks({ lib: 'shared2' });

        expect(await fs.readlink(path.join(repoDir, 'lib'))).toBe('shared2');
        expect((await fs.lstat(path.join(repoDir, 'shared'))).isDirectory()).toBe(true);
      });

      it('replaces a directory the overlay deletes the files of', async () => {
        await fs.mkdir(path.join(repoDir, 'lib/sub'), { recursive: true });
        await fs.writeFile(path.join(repoDir, 'lib/a.txt'), 'a');
        await fs.writeFile(path.join(repoDir, 'lib/sub/b.txt'), 'b');

        await applyDirLinks({ lib: 'shared' }, { deletions: ['lib/a.txt', 'lib/sub/b.txt'] });

        expect(await fs.readlink(path.join(repoDir, 'lib'))).toBe('shared');
      });

      it('refuses to replace a directory that still holds a file', async () => {
        await fs.mkdir(path.join(repoDir, 'lib'));
        await fs.writeFile(path.join(repoDir, 'lib/keep.txt'), 'keep');

        // fails-when: the directory is removed recursively and takes keep.txt with it
        await expect(applyDirLinks({ lib: 'shared' })).rejects.toThrow(/"lib".*keep\.txt/);
        expect(await fs.readFile(path.join(repoDir, 'lib/keep.txt'), 'utf-8')).toBe('keep');
      });

      it('removes a deleted directory symlink without entering its target', async () => {
        await fs.mkdir(path.join(repoDir, 'shared'));
        await fs.writeFile(path.join(repoDir, 'shared/a.txt'), 'a');
        await fs.symlink('shared', path.join(repoDir, 'lib'));

        const result = await applyDirLinks({}, { files: { 'keep.txt': 'k' }, deletions: ['lib'] });

        expect(result).toMatchObject({ filesDeleted: 1, symlinksApplied: 0 });
        await expect(fs.lstat(path.join(repoDir, 'lib'))).rejects.toThrow();
        expect(await fs.readFile(path.join(repoDir, 'shared/a.txt'), 'utf-8')).toBe('a');
      });

      it('applies a manifest without a symlinks field as before', async () => {
        // breaks-if-wrong: an overlay from a CLI that predates `symlinks` must still apply
        const overlay = await createTestOverlay(tmpDir, { 'a.txt': 'a' });

        const result = await apply(overlay);

        expect(result).toMatchObject({ filesApplied: 1, filesDeleted: 0, symlinksApplied: 0 });
        expect(await fs.readFile(path.join(repoDir, 'a.txt'), 'utf-8')).toBe('a');
      });

      describe('refusals', () => {
        /**
         * Apply a hostile directory link next to a normal file and prove the
         * refusal is total: the error names the entry, no link exists, and the
         * normal file was not written either.
         */
        async function expectLinkRefused(
          overlay: Awaited<ReturnType<typeof createTestOverlay>>,
          pattern: RegExp,
          link: string,
        ): Promise<void> {
          await fs.writeFile(path.join(repoDir, 'inside.txt'), 'original');

          await expect(apply(overlay)).rejects.toThrow(pattern);

          await expect(fs.lstat(path.join(repoDir, link))).rejects.toThrow();
          expect(await fs.readFile(path.join(repoDir, 'inside.txt'), 'utf-8')).toBe('original');
        }

        const withLinks = (dirLinks: Record<string, string>, override = {}) =>
          createTestOverlay(
            tmpDir,
            { 'inside.txt': 'overwritten' },
            [],
            {},
            {},
            dirLinks,
            override,
          );

        it('refuses an absolute link', async () => {
          // fails-when: the link is created without checking where its text points
          await expectLinkRefused(
            await withLinks({ lib: '/etc' }),
            /"lib" \(symlink\): link text is an absolute path/,
            'lib',
          );
        });

        it('refuses a link that climbs out of the repository', async () => {
          await expectLinkRefused(
            await withLinks({ 'a/lib': '../../outside' }),
            /"a\/lib" \(symlink\): link target resolves outside the repository/,
            'a/lib',
          );
        });

        it('refuses a link created through a repository symlink that climbs out from there', async () => {
          // `sub` is the repository root, so `sub/lib` is created at `lib`, and
          // `..` from there names the root's parent.
          await fs.symlink('.', path.join(repoDir, 'sub'));

          // fails-when: the text is resolved from the path as written (`sub/`), where `..` is the root
          await expectLinkRefused(
            await withLinks({ 'sub/lib': '..' }),
            /"sub\/lib" \(symlink\): link target resolves outside the repository/,
            'lib',
          );
        });

        it('refuses a link whose text leaves through a symlink the repository already has', async () => {
          // `up -> .` is the root: `a/x -> ../up/..` stays inside as written and
          // climbs out once `up` is followed.
          await fs.symlink('.', path.join(repoDir, 'up'));

          // fails-when: only the as-written `path.resolve` check runs
          await expectLinkRefused(
            await withLinks({ 'a/x': '../up/..' }),
            /"a\/x" \(symlink\): link target leaves the repository through a symlink/,
            'a',
          );
        });

        it('refuses a link that leaves through another link the overlay creates', async () => {
          // `q/b -> ..` is the root on its own; `a -> q/b/..` climbs above it.
          await expectLinkRefused(
            await withLinks({ 'q/b': '..', a: 'q/b/..' }),
            /"a" \(symlink\): link target leaves the repository through a symlink/,
            'a',
          );
        });

        it('refuses a file entry beneath a symlink entry', async () => {
          const overlay = await createTestOverlay(
            tmpDir,
            { 'inside.txt': 'overwritten' },
            [],
            { 'lib/x.txt': 'a'.repeat(64) },
            {},
            { lib: 'shared' },
          );
          await expectLinkRefused(
            overlay,
            /"lib\/x\.txt" \(file\): lies beneath the symlink "lib"/,
            'lib',
          );
        });

        it('refuses link text carrying a NUL byte', async () => {
          await expectLinkRefused(
            await withLinks({}, { symlinks: { lib: 'shared\u0000x' } }),
            /"lib" \(symlink\): link text contains a NUL byte/,
            'lib',
          );
        });

        it('refuses a symlinks field that is not an object', async () => {
          await expectLinkRefused(
            await withLinks({}, { symlinks: ['lib'] }),
            /Overlay manifest is malformed/,
            'lib',
          );
        });

        it('refuses a link beneath a repository symlink that does not resolve yet', async () => {
          // `p/q/x -> ../../nonexist` resolves once the overlay writes `nonexist/f`,
          // so a link created beneath it would sit in `nonexist/` and climb out.
          await fs.mkdir(path.join(repoDir, 'p/q'), { recursive: true });
          await fs.symlink('../../nonexist', path.join(repoDir, 'p/q/x'));
          const overlay = await createTestOverlay(
            tmpDir,
            { 'inside.txt': 'overwritten', 'nonexist/f': 'x' },
            [],
            {},
            {},
            { 'p/q/x/lib': '../../..' },
          );

          // fails-when: the dangling link is read as a missing directory and validated as written
          await expectLinkRefused(
            overlay,
            /"p\/q\/x\/lib" \(symlink\): passes through a symlink that does not resolve/,
            'nonexist',
          );
        });

        it('refuses a link beneath a repository symlink that needs a link the overlay creates', async () => {
          // `p/q/x -> ../../a` resolves only once the overlay creates `a -> .`.
          await fs.mkdir(path.join(repoDir, 'p/q'), { recursive: true });
          await fs.symlink('../../a', path.join(repoDir, 'p/q/x'));

          await expectLinkRefused(
            await withLinks({ a: '.', 'p/q/x/lib': '../../..' }),
            /"p\/q\/x\/lib" \(symlink\): passes through a symlink that does not resolve/,
            'a',
          );
        });

        it('refuses a link beneath a repository symlink to a directory the overlay replaces', async () => {
          // `a` exists now, but the overlay turns it into a link, so `p/q/x` would
          // resolve differently depending on which link is created first.
          await fs.mkdir(path.join(repoDir, 'p/q'), { recursive: true });
          await fs.mkdir(path.join(repoDir, 'a'));
          await fs.symlink('../../a', path.join(repoDir, 'p/q/x'));

          await expectLinkRefused(
            await withLinks({ a: '.', 'p/q/x/lib': '../../..' }),
            /"p\/q\/x\/lib" \(symlink\): passes through the symlink "a", which the overlay creates/,
            'p/q/x/lib',
          );
        });

        it('refuses a file that reaches a symlink entry through a repository symlink', async () => {
          await fs.symlink('.', path.join(repoDir, 'y'));
          const overlay = await createTestOverlay(
            tmpDir,
            { 'inside.txt': 'overwritten', 'y/lib/f': 'x' },
            [],
            {},
            {},
            { lib: 'shared' },
          );

          // fails-when: a file is compared with the symlink entries by its path as written
          await expectLinkRefused(
            overlay,
            /"y\/lib\/f" \(file\): lies beneath the symlink "lib"/,
            'lib',
          );
        });

        it('refuses a key listed both as a file and as a symlink', async () => {
          const overlay = await createTestOverlay(
            tmpDir,
            { 'inside.txt': 'overwritten' },
            [],
            { lib: 'a'.repeat(64) },
            {},
            { lib: 'shared' },
          );

          await expectLinkRefused(overlay, /"lib" \(file\): is also listed as a symlink/, 'lib');
        });
      });
    });

    describe('deletions other entries rely on', () => {
      /**
       * A clone with `y -> d` and `d/f -> <outside>`. Deleting `y` first used to
       * make the written deletion path `y/f` miss, so `d/f` survived and the
       * next write followed it out of the repository.
       */
      let outsideDir: string;
      beforeEach(async () => {
        outsideDir = path.join(tmpDir, 'outside-dir');
        await fs.mkdir(outsideDir);
        await fs.mkdir(path.join(repoDir, 'd'));
        await fs.symlink('d', path.join(repoDir, 'y'));
        await fs.symlink(outsideDir, path.join(repoDir, 'd/f'));
      });

      it('deletes by real path, so a file lands inside whatever the deletion order', async () => {
        const overlay = await createTestOverlay(tmpDir, { 'd/f/pwn': 'x' }, ['y', 'y/f']);

        // fails-when: the second deletion unlinks the written path `y/f`, which no longer exists
        await apply(overlay);

        expect(await fs.readdir(outsideDir)).toEqual([]);
        expect((await fs.lstat(path.join(repoDir, 'd/f'))).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(repoDir, 'd/f/pwn'), 'utf-8')).toBe('x');
      });

      it('deletes by real path, so a directory link lands inside whatever the deletion order', async () => {
        const overlay = await createTestOverlay(
          tmpDir,
          {},
          ['y', 'y/f'],
          {},
          {},
          { 'd/f/lib': '..' },
        );

        await apply(overlay);

        expect(await fs.readdir(outsideDir)).toEqual([]);
        const real = await fs.realpath(path.join(repoDir, 'd/f/lib'));
        expect(real).toBe(await fs.realpath(path.join(repoDir, 'd')));
      });
    });

    it('fails loudly when a deletion the check relied on does not happen', async () => {
      await fs.writeFile(path.join(repoDir, 'gone.txt'), 'x');
      const overlay = await createTestOverlay(tmpDir, { 'keep.txt': 'k' }, ['gone.txt']);
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
        if (String(target).endsWith('gone.txt'))
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return realUnlink(target);
      });

      // fails-when: the failed unlink is swallowed like a missing file's
      // breaks-if-wrong: a deletion of a file the clone never had is still skipped (tested above)
      await expect(apply(overlay)).rejects.toThrow(
        /Overlay deletion of "gone\.txt" failed: EACCES/,
      );
    });

    describe('an entry beneath a path the overlay replaces', () => {
      // `y -> d` in the clone: `y` becomes a file, so nothing can be written beneath it.
      beforeEach(async () => {
        await fs.mkdir(path.join(repoDir, 'd'));
        await fs.symlink('d', path.join(repoDir, 'y'));
      });

      it('refuses a file beneath a symlink the overlay replaces with a file', async () => {
        // `y/f` is listed in the manifest only: the helper cannot stage a file and a path beneath it.
        const overlay = await createTestOverlay(tmpDir, { y: 'now a file' }, [], {
          'y/f': 'a'.repeat(64),
        });

        // fails-when: `y/f` is compared by its real path `d/f`, which no entry names
        await expect(apply(overlay)).rejects.toThrow(/"y\/f" \(file\): lies beneath the file "y"/);
        expect(await fs.readlink(path.join(repoDir, 'y'))).toBe('d');
        await expect(fs.access(path.join(repoDir, 'd/f'))).rejects.toThrow();
      });

      it('refuses a directory link beneath a symlink the overlay replaces with a file', async () => {
        const overlay = await createTestOverlay(
          tmpDir,
          { y: 'now a file' },
          [],
          {},
          {},
          {},
          { symlinks: { 'y/lib': '.' } },
        );

        await expect(apply(overlay)).rejects.toThrow(
          /"y\/lib" \(symlink\): lies beneath the file "y"/,
        );
        expect(await fs.readlink(path.join(repoDir, 'y'))).toBe('d');
      });
    });

    describe('type changes', () => {
      it('turns a directory symlink back into a directory without writing through it', async () => {
        await fs.mkdir(path.join(repoDir, 'shared'));
        await fs.writeFile(path.join(repoDir, 'shared/s.txt'), 's');
        await fs.symlink('shared', path.join(repoDir, 'lib'));
        const overlay = await createTestOverlay(tmpDir, { 'lib/x.txt': 'x' }, ['lib']);

        // breaks-if-wrong: with files written before deletions, lib/x.txt lands in shared/
        const result = await apply(overlay);

        expect(result).toMatchObject({ filesApplied: 1, filesDeleted: 1 });
        expect((await fs.lstat(path.join(repoDir, 'lib'))).isDirectory()).toBe(true);
        expect(await fs.readFile(path.join(repoDir, 'lib/x.txt'), 'utf-8')).toBe('x');
        await expect(fs.access(path.join(repoDir, 'shared/x.txt'))).rejects.toThrow();
      });

      it('replaces a directory the overlay turns into a file', async () => {
        await fs.mkdir(path.join(repoDir, 'a'));
        await fs.writeFile(path.join(repoDir, 'a/x'), 'x');
        const overlay = await createTestOverlay(tmpDir, { a: 'now a file' }, ['a/x']);

        await apply(overlay);

        expect(await fs.readFile(path.join(repoDir, 'a'), 'utf-8')).toBe('now a file');
      });
    });
  });
});
