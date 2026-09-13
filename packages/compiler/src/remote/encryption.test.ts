import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  generateEphemeralKeypair,
  deriveSharedSecret,
  encryptTarball,
  decryptTarball,
} from './encryption.js';

describe('X25519 ECDH encryption', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-encryption-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('generateEphemeralKeypair', () => {
    it('generates valid X25519 DER keypair', () => {
      const kp = generateEphemeralKeypair();
      expect(kp.publicKey).toBeInstanceOf(Buffer);
      expect(kp.privateKey).toBeInstanceOf(Buffer);
      // DER-encoded X25519 public keys (SPKI) are typically 44 bytes
      expect(kp.publicKey.length).toBeGreaterThan(0);
      expect(kp.privateKey.length).toBeGreaterThan(0);
    });

    it('generates unique keypairs on each call', () => {
      const kp1 = generateEphemeralKeypair();
      const kp2 = generateEphemeralKeypair();
      expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false);
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
    });
  });

  describe('deriveSharedSecret', () => {
    it('derives same shared secret from both sides', () => {
      const alice = generateEphemeralKeypair();
      const bob = generateEphemeralKeypair();

      const secretA = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretB = deriveSharedSecret(bob.privateKey, alice.publicKey);

      expect(secretA.equals(secretB)).toBe(true);
    });

    it('derives 32-byte AES-256 key', () => {
      const alice = generateEphemeralKeypair();
      const bob = generateEphemeralKeypair();
      const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.length).toBe(32);
    });

    it('produces different secrets for different keypairs', () => {
      const alice = generateEphemeralKeypair();
      const bob = generateEphemeralKeypair();
      const charlie = generateEphemeralKeypair();

      const secretAB = deriveSharedSecret(alice.privateKey, bob.publicKey);
      const secretAC = deriveSharedSecret(alice.privateKey, charlie.publicKey);

      expect(secretAB.equals(secretAC)).toBe(false);
    });
  });

  describe('encryptTarball / decryptTarball', () => {
    it('round-trips: encrypt with orchestrator pubkey, decrypt with orchestrator privkey', async () => {
      const orchestrator = generateEphemeralKeypair();
      const originalContent = Buffer.from('Hello, this is a tarball content for testing!');

      const tarballPath = path.join(tempDir, 'test.tar.gz');
      await fs.writeFile(tarballPath, originalContent);

      // CLI encrypts with orchestrator's public key
      const { encryptedPath, cliPublicKey } = await encryptTarball(
        tarballPath,
        orchestrator.publicKey,
      );

      expect(encryptedPath).toBe(`${tarballPath}.enc`);
      const encryptedContent = await fs.readFile(encryptedPath);
      expect(encryptedContent.equals(originalContent)).toBe(false);

      // Orchestrator/agent decrypts with own private key + CLI public key
      const decryptedPath = await decryptTarball(
        encryptedPath,
        cliPublicKey,
        orchestrator.privateKey,
      );

      const decryptedContent = await fs.readFile(decryptedPath);
      expect(decryptedContent.equals(originalContent)).toBe(true);
    });

    it('handles large binary content', async () => {
      const orchestrator = generateEphemeralKeypair();
      // 1MB of random binary data
      const originalContent = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < originalContent.length; i++) {
        originalContent[i] = i % 256;
      }

      const tarballPath = path.join(tempDir, 'large.tar.gz');
      await fs.writeFile(tarballPath, originalContent);

      const { encryptedPath, cliPublicKey } = await encryptTarball(
        tarballPath,
        orchestrator.publicKey,
      );

      const decryptedPath = await decryptTarball(
        encryptedPath,
        cliPublicKey,
        orchestrator.privateKey,
      );

      const decryptedContent = await fs.readFile(decryptedPath);
      expect(decryptedContent.equals(originalContent)).toBe(true);
    });

    it('different keypairs produce different ciphertext', async () => {
      const orch1 = generateEphemeralKeypair();
      const orch2 = generateEphemeralKeypair();
      const content = Buffer.from('same content for both');

      const tarball1 = path.join(tempDir, 'test1.tar.gz');
      const tarball2 = path.join(tempDir, 'test2.tar.gz');
      await fs.writeFile(tarball1, content);
      await fs.writeFile(tarball2, content);

      const result1 = await encryptTarball(tarball1, orch1.publicKey);
      const result2 = await encryptTarball(tarball2, orch2.publicKey);

      const enc1 = await fs.readFile(result1.encryptedPath);
      const enc2 = await fs.readFile(result2.encryptedPath);

      // Different keys => different ciphertext
      expect(enc1.equals(enc2)).toBe(false);
    });

    it('tampered ciphertext fails decryption (auth tag verification)', async () => {
      const orchestrator = generateEphemeralKeypair();
      const content = Buffer.from('tamper test data');

      const tarballPath = path.join(tempDir, 'tamper.tar.gz');
      await fs.writeFile(tarballPath, content);

      const { encryptedPath, cliPublicKey } = await encryptTarball(
        tarballPath,
        orchestrator.publicKey,
      );

      // Tamper with the ciphertext (flip a byte in the ciphertext section)
      const encrypted = await fs.readFile(encryptedPath);
      // Byte 28 is the first byte of ciphertext (after 12-byte IV + 16-byte auth tag)
      if (encrypted.length > 28) {
        encrypted[28] ^= 0xff;
      }
      await fs.writeFile(encryptedPath, encrypted);

      await expect(
        decryptTarball(encryptedPath, cliPublicKey, orchestrator.privateKey),
      ).rejects.toThrow();
    });

    it('wire format has correct structure (12+16+N bytes)', async () => {
      const orchestrator = generateEphemeralKeypair();
      const content = Buffer.from('wire format test');

      const tarballPath = path.join(tempDir, 'wire.tar.gz');
      await fs.writeFile(tarballPath, content);

      const { encryptedPath } = await encryptTarball(tarballPath, orchestrator.publicKey);

      const encrypted = await fs.readFile(encryptedPath);

      // Total: 12 (IV) + 16 (auth tag) + content.length (ciphertext)
      expect(encrypted.length).toBe(12 + 16 + content.length);

      // IV is first 12 bytes (should not be all zeros since it's random)
      const iv = encrypted.subarray(0, 12);
      expect(iv.length).toBe(12);
      expect(iv.every((b) => b === 0)).toBe(false);

      // Auth tag is next 16 bytes
      const authTag = encrypted.subarray(12, 28);
      expect(authTag.length).toBe(16);
    });

    it('decrypted path removes .enc suffix', async () => {
      const orchestrator = generateEphemeralKeypair();
      const tarballPath = path.join(tempDir, 'output.tar.gz');
      await fs.writeFile(tarballPath, Buffer.from('test'));

      const { encryptedPath, cliPublicKey } = await encryptTarball(
        tarballPath,
        orchestrator.publicKey,
      );

      expect(encryptedPath.endsWith('.enc')).toBe(true);

      const decryptedPath = await decryptTarball(
        encryptedPath,
        cliPublicKey,
        orchestrator.privateKey,
      );

      // Original tarball was overwritten by decrypt output at the same path (without .enc)
      expect(decryptedPath).toBe(tarballPath);
    });
  });
});
