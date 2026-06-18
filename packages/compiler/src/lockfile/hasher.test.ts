import { describe, it, expect } from 'vitest';
import { computeContentHash, COMPILE_SCHEMA_VERSION } from './hasher.js';

describe('hasher', () => {
  describe('COMPILE_SCHEMA_VERSION', () => {
    it('is a positive integer', () => {
      expect(COMPILE_SCHEMA_VERSION).toBe(5);
    });
  });

  describe('computeContentHash', () => {
    it('returns a 64-character hex string', () => {
      const hash = computeContentHash('console.log("hello")', 1);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: same input produces same output', () => {
      const source = 'export const foo = 42;';
      const hash1 = computeContentHash(source, 1);
      const hash2 = computeContentHash(source, 1);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different bundle sources', () => {
      const hash1 = computeContentHash('export const a = 1;', 1);
      const hash2 = computeContentHash('export const b = 2;', 1);
      expect(hash1).not.toBe(hash2);
    });

    it('produces different hashes when schema version changes', () => {
      const source = 'export const foo = 42;';
      const hash1 = computeContentHash(source, 1);
      const hash2 = computeContentHash(source, 2);
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty bundle source', () => {
      const hash = computeContentHash('', 1);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles large bundle source', () => {
      const largeSource = 'x'.repeat(1_000_000);
      const hash = computeContentHash(largeSource, 1);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('backward compat: no assetDigest produces same hash as before', () => {
      const source = 'export const x = 1;';
      const hashNoArg = computeContentHash(source, 1);
      const hashUndefined = computeContentHash(source, 1, undefined);
      expect(hashNoArg).toBe(hashUndefined);
    });

    it('includes assetDigest in hash when provided', () => {
      const source = 'export const x = 1;';
      const hashBundleOnly = computeContentHash(source, 1);
      const hashWithAssets = computeContentHash(source, 1, 'file.txt\ncontent');
      expect(hashWithAssets).not.toBe(hashBundleOnly);
    });

    it('is deterministic with assetDigest', () => {
      const source = 'export const x = 1;';
      const digest = 'a.txt\nhello\nb.txt\nworld';
      const hash1 = computeContentHash(source, 1, digest);
      const hash2 = computeContentHash(source, 1, digest);
      expect(hash1).toBe(hash2);
    });

    it('different assetDigest produces different hash', () => {
      const source = 'export const x = 1;';
      expect(computeContentHash(source, 1, 'f\nA')).not.toBe(computeContentHash(source, 1, 'f\nB'));
    });

    // Regression: Git for Windows ships with `core.autocrlf=true` set in the
    // system gitconfig, so a `git clone` of a Linux-authored repo on a Windows
    // host writes CRLF into the working tree. Without normalization the
    // Windows agent computed a different hash than the Linux compiler and
    // every dispatched workflow failed with "lock file is out of date".
    it('LF and CRLF source produce identical hashes (autocrlf parity)', () => {
      const lf = 'export const x = 1;\nexport const y = 2;\n';
      const crlf = 'export const x = 1;\r\nexport const y = 2;\r\n';
      expect(computeContentHash(crlf, 1)).toBe(computeContentHash(lf, 1));
    });

    it('LF and CRLF assetDigest produce identical hashes (autocrlf parity)', () => {
      const source = 'export const x = 1;\n';
      const lf = 'a.txt\nhello\nworld\n';
      const crlf = 'a.txt\r\nhello\r\nworld\r\n';
      expect(computeContentHash(source, 1, crlf)).toBe(computeContentHash(source, 1, lf));
    });
  });
});
