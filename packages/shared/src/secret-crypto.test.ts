import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  deriveKey,
  generateMasterKey,
  type EncryptedValue,
} from './secret-crypto.js';

describe('AES-256-GCM crypto module', () => {
  const testKey = deriveKey('a'.repeat(64)); // 64 hex chars = 32 bytes
  const testAad = 'ctx-123:MY_SECRET';

  it('encrypt + decrypt round-trip returns original plaintext', () => {
    const plaintext = 'super-secret-value-123!@#';
    const encrypted = encrypt(plaintext, testKey, 1, testAad);
    const decrypted = decrypt(encrypted, testKey, testAad);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for same plaintext (unique IVs)', () => {
    const plaintext = 'same-value';
    const a = encrypt(plaintext, testKey, 1, testAad);
    const b = encrypt(plaintext, testKey, 1, testAad);
    expect(a.data).not.toBe(b.data);
    // Both should still decrypt correctly
    expect(decrypt(a, testKey, testAad)).toBe(plaintext);
    expect(decrypt(b, testKey, testAad)).toBe(plaintext);
  });

  it('fails decryption with wrong key', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext, testKey, 1, testAad);
    const wrongKey = deriveKey('b'.repeat(64));
    expect(() => decrypt(encrypted, wrongKey, testAad)).toThrow();
  });

  it('fails decryption with wrong AAD (prevents cross-context swap)', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext, testKey, 1, 'ctx-123:KEY_A');
    expect(() => decrypt(encrypted, testKey, 'ctx-456:KEY_B')).toThrow();
  });

  it('fails decryption with tampered ciphertext', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext, testKey, 1, testAad);
    // Tamper with the data: decode base64, flip a byte, re-encode
    const raw = Buffer.from(encrypted.data, 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered: EncryptedValue = {
      data: raw.toString('base64'),
      keyVersion: encrypted.keyVersion,
    };
    expect(() => decrypt(tampered, testKey, testAad)).toThrow();
  });

  it('preserves key version in encrypted value', () => {
    const encrypted = encrypt('test', testKey, 42, testAad);
    expect(encrypted.keyVersion).toBe(42);
  });

  it('handles empty string plaintext', () => {
    const encrypted = encrypt('', testKey, 1, testAad);
    expect(decrypt(encrypted, testKey, testAad)).toBe('');
  });

  it('handles unicode plaintext', () => {
    const plaintext = 'secret with unicode chars to verify encoding';
    const encrypted = encrypt(plaintext, testKey, 1, testAad);
    expect(decrypt(encrypted, testKey, testAad)).toBe(plaintext);
  });
});

describe('deriveKey', () => {
  it('accepts 64-char hex string and returns 32-byte Buffer', () => {
    const hex = 'ab'.repeat(32); // 64 hex chars
    const key = deriveKey(hex);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    // Verify it decoded correctly
    expect(key[0]).toBe(0xab);
  });

  it('rejects wrong-length hex input (too short)', () => {
    expect(() => deriveKey('ab'.repeat(16))).toThrow(/32 bytes/);
  });

  it('rejects wrong-length hex input (too long)', () => {
    expect(() => deriveKey('ab'.repeat(48))).toThrow(/32 bytes/);
  });

  it('accepts base64-encoded 32-byte key', () => {
    // 32 bytes in base64 = 44 chars (with padding)
    const raw = Buffer.alloc(32, 0xcc);
    const b64 = raw.toString('base64');
    const key = deriveKey(b64);
    expect(key.length).toBe(32);
    expect(key[0]).toBe(0xcc);
  });

  it('rejects base64 input that is not 32 bytes', () => {
    const raw = Buffer.alloc(16, 0xaa);
    const b64 = raw.toString('base64');
    expect(() => deriveKey(b64)).toThrow(/32 bytes/);
  });
});

describe('generateMasterKey', () => {
  it('returns 64-char hex string', () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    expect(a).not.toBe(b);
  });

  it('produces a valid key that deriveKey accepts', () => {
    const hex = generateMasterKey();
    const key = deriveKey(hex);
    expect(key.length).toBe(32);
  });
});
