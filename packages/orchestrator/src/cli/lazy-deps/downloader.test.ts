/**
 * Tests for the lazy dependency downloader.
 *
 * Mocks filesystem and crypto operations to test download, verify,
 * extract, and cache-hit scenarios without actual network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LazyDep } from './registry.js';

// We test the pure logic functions without actual HTTP/archive operations
// by mocking the filesystem layer.

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
      createWriteStream: vi.fn(() => ({
        on: vi.fn(),
        close: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      })),
      createReadStream: vi.fn(),
      statSync: vi.fn(() => ({ size: 1024 })),
      readFileSync: vi.fn(() => Buffer.alloc(0)),
    },
  };
});

const mockedExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockedMkdirSync = fs.mkdirSync as ReturnType<typeof vi.fn>;

const testDep: LazyDep = {
  name: 'test-dep',
  version: '1.0.0',
  platform: 'linux',
  arch: 'x64',
  url: 'https://example.com/test-dep-1.0.0.tar.gz',
  sha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  extractPath: 'test-dep/',
  archiveType: 'tar.gz',
};

const testCacheDir = '/tmp/kici-test-cache/deps/';

describe('lazy-deps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
  });

  describe('registry', () => {
    it('returns metadata for valid dep and platform', async () => {
      const { getDepMetadata } = await import('./registry.js');
      const dep = getDepMetadata('rolldown', 'linux', 'x64');
      expect(dep.name).toBe('rolldown');
      expect(dep.platform).toBe('linux');
      expect(dep.arch).toBe('x64');
      expect(dep.url).toContain('linux-x64');
    });

    it('throws for unknown dependency', async () => {
      const { getDepMetadata } = await import('./registry.js');
      expect(() => getDepMetadata('nonexistent')).toThrow('Unknown lazy dependency: nonexistent');
    });

    it('throws for unsupported platform/arch variant', async () => {
      const { getDepMetadata } = await import('./registry.js');
      expect(() => getDepMetadata('shawl', 'linux', 'x64')).toThrow(
        'No shawl variant for linux-x64',
      );
    });

    it('returns shawl metadata for Windows', async () => {
      const { getDepMetadata } = await import('./registry.js');
      const dep = getDepMetadata('shawl', 'win32', 'x64');
      expect(dep.name).toBe('shawl');
      expect(dep.archiveType).toBe('zip');
    });
  });

  describe('cache', () => {
    it('getCacheBasePath returns a path', async () => {
      // Need to mock os for this
      const { getCacheBasePath } = await import('./cache.js');
      const p = getCacheBasePath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });

    it('cleanCache removes directory when it exists', async () => {
      mockedExistsSync.mockReturnValue(true);
      const mockedRmSync = fs.rmSync as ReturnType<typeof vi.fn>;
      const { cleanCache } = await import('./cache.js');
      cleanCache('/tmp/test-cache');
      expect(mockedRmSync).toHaveBeenCalledWith('/tmp/test-cache', {
        recursive: true,
        force: true,
      });
    });

    it('cleanCache does nothing when directory does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const mockedRmSync = fs.rmSync as ReturnType<typeof vi.fn>;
      const { cleanCache } = await import('./cache.js');
      cleanCache('/tmp/nonexistent');
      expect(mockedRmSync).not.toHaveBeenCalled();
    });
  });

  describe('downloader', () => {
    it('returns cached path immediately on cache hit', async () => {
      const cachedPath = path.join(testCacheDir, 'test-dep', '1.0.0');
      mockedExistsSync.mockImplementation((p: unknown) => p === cachedPath);

      const { ensureDep } = await import('./downloader.js');
      const result = await ensureDep(testDep, testCacheDir);
      expect(result).toBe(cachedPath);
    });

    it('creates cache directory on cache miss', async () => {
      mockedExistsSync.mockReturnValue(false);

      const { ensureDep } = await import('./downloader.js');
      // Will throw because we can't actually download, but should attempt mkdir first
      try {
        await ensureDep(testDep, testCacheDir);
      } catch {
        // Expected - no actual HTTP available
      }
      expect(mockedMkdirSync).toHaveBeenCalled();
    });

    it('verifyIntegrity rejects on SHA-256 mismatch', async () => {
      const { verifyIntegrity } = await import('./downloader.js');
      // Create a buffer with known content
      const content = Buffer.from('test content');
      const wrongHash = 'wrong-hash-value';
      expect(() => verifyIntegrity(content, wrongHash)).toThrow('SHA-256 integrity check failed');
    });

    it('verifyIntegrity passes with correct hash', async () => {
      const { verifyIntegrity } = await import('./downloader.js');
      const content = Buffer.from('test content');
      // Pre-computed SHA-256 of "test content"
      const crypto = await import('node:crypto');
      const correctHash = crypto.createHash('sha256').update(content).digest('hex');
      expect(() => verifyIntegrity(content, correctHash)).not.toThrow();
    });
  });
});
