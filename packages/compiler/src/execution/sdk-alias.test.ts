import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Hoisted, so the hoisted vi.mock factory can reach it.
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@kici-dev/core', () => ({
  logger: mockLogger,
  createLogger: () => mockLogger,

  toErrorMessage: (err) => (err instanceof Error ? err.message : String(err)),
}));

import { getTypeScriptPaths } from './sdk-alias.js';

describe('SDK aliasing', () => {
  const testDir = path.resolve(process.cwd(), '.test-sdk-alias');
  const kiciDir = path.join(testDir, '.kici');
  const sdkRepoDir = path.join(testDir, 'fake-kici-repo');
  const sdkDistPath = path.join(sdkRepoDir, 'packages/sdk/dist/index.js');

  let originalCwd: string;
  let originalDebug: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDebug = process.env.KICI_DEBUG;

    mockLogger.warn.mockClear();

    await rm(testDir, { recursive: true, force: true });

    await mkdir(testDir, { recursive: true });
    await mkdir(kiciDir, { recursive: true });
    await mkdir(path.join(sdkRepoDir, 'packages/sdk/dist'), { recursive: true });

    // A fake SDK build.
    await writeFile(sdkDistPath, 'export {}', 'utf-8');

    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.KICI_DEBUG = originalDebug;

    await rm(testDir, { recursive: true, force: true });
  });

  describe('getTypeScriptPaths', () => {
    it('should return null when sdkPath not configured', async () => {
      const paths = await getTypeScriptPaths();
      expect(paths).toBeNull();
    });

    it('should return null when in kici repo', async () => {
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ kici: { development: true } }),
        'utf-8',
      );

      // Create .kici/package.json with sdkPath
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: sdkRepoDir } }),
        'utf-8',
      );

      const paths = await getTypeScriptPaths();
      expect(paths).toBeNull();
    });

    it('should return path mapping when sdkPath configured', async () => {
      // NOT the kici repo.
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      // Create .kici/package.json with sdkPath
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: sdkRepoDir } }),
        'utf-8',
      );

      const paths = await getTypeScriptPaths();
      expect(paths).toEqual({
        '@kici-dev/sdk': [path.join(sdkRepoDir, 'packages/sdk/src/index.ts')],
      });
    });

    it('should handle relative sdkPath', async () => {
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      const relativePath = path.relative(testDir, sdkRepoDir);
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: relativePath } }),
        'utf-8',
      );

      const paths = await getTypeScriptPaths();
      expect(paths).toEqual({
        '@kici-dev/sdk': [path.join(sdkRepoDir, 'packages/sdk/src/index.ts')],
      });
    });
  });
});
