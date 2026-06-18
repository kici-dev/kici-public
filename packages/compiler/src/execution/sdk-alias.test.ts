/**
 * Tests for SDK aliasing in development mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// vi.hoisted ensures mockLogger is available when vi.mock factory runs (hoisted)
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

import { getSdkAliasConfig, getTypeScriptPaths } from './sdk-alias.js';

describe('SDK aliasing', () => {
  const testDir = path.resolve(process.cwd(), '.test-sdk-alias');
  const kiciDir = path.join(testDir, '.kici');
  const sdkRepoDir = path.join(testDir, 'fake-kici-repo');
  const sdkDistPath = path.join(sdkRepoDir, 'packages/sdk/dist/index.js');

  let originalCwd: string;
  let originalDebug: string | undefined;

  beforeEach(async () => {
    // Save original state
    originalCwd = process.cwd();
    originalDebug = process.env.KICI_DEBUG;

    // Reset mock logger
    mockLogger.warn.mockClear();

    // Clean up from previous test
    await rm(testDir, { recursive: true, force: true });

    // Create test directory structure
    await mkdir(testDir, { recursive: true });
    await mkdir(kiciDir, { recursive: true });
    await mkdir(path.join(sdkRepoDir, 'packages/sdk/dist'), { recursive: true });

    // Create fake SDK build
    await writeFile(sdkDistPath, 'export {}', 'utf-8');

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(async () => {
    // Restore original state
    process.chdir(originalCwd);
    process.env.KICI_DEBUG = originalDebug;

    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getSdkAliasConfig', () => {
    it('should return empty config when sdkPath not configured', async () => {
      // No .kici/package.json
      const config = await getSdkAliasConfig();
      expect(config).toEqual({});
    });

    it('should return empty config when in kici repo', async () => {
      // Create package.json with kici.development flag
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

      const config = await getSdkAliasConfig();
      expect(config).toEqual({});
    });

    it('should return alias config when sdkPath configured and valid', async () => {
      // Create project package.json (NOT kici repo)
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

      const config = await getSdkAliasConfig();
      expect(config).toEqual({
        '@kici-dev/sdk': sdkDistPath,
      });
    });

    it('should handle relative sdkPath', async () => {
      // Create project package.json
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      // Use relative path in config
      const relativePath = path.relative(testDir, sdkRepoDir);
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: relativePath } }),
        'utf-8',
      );

      const config = await getSdkAliasConfig();
      expect(config).toEqual({
        '@kici-dev/sdk': sdkDistPath,
      });
    });

    it('should return empty config when SDK build missing', async () => {
      // Create project package.json
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      // Create .kici/package.json with sdkPath but remove SDK build
      await rm(sdkDistPath, { force: true });
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: sdkRepoDir } }),
        'utf-8',
      );

      const config = await getSdkAliasConfig();
      expect(config).toEqual({});
    });

    it('should log when using local SDK', async () => {
      // Create project package.json
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

      await getSdkAliasConfig();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[kici] Development mode: using local SDK from'),
      );
    });

    it('should log warning when SDK build missing', async () => {
      // Create project package.json
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      // Remove SDK build
      await rm(sdkDistPath, { force: true });

      // Create .kici/package.json with sdkPath
      await writeFile(
        path.join(kiciDir, 'package.json'),
        JSON.stringify({ kici: { sdkPath: sdkRepoDir } }),
        'utf-8',
      );

      await getSdkAliasConfig();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[kici] sdkPath configured but SDK not found'),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('pnpm build'));
    });

    it('should respect KICI_DEBUG for verbose logging', async () => {
      process.env.KICI_DEBUG = 'true';

      // Create project package.json
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

      await getSdkAliasConfig();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[kici] SDK alias resolved to:'),
      );
    });

    it('should log debug message when aliasing disabled in kici repo', async () => {
      process.env.KICI_DEBUG = 'true';

      // Create package.json with kici.development flag
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

      await getSdkAliasConfig();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[kici] SDK aliasing disabled: running inside kici development repo',
        ),
      );
    });
  });

  describe('getTypeScriptPaths', () => {
    it('should return null when sdkPath not configured', async () => {
      const paths = await getTypeScriptPaths();
      expect(paths).toBeNull();
    });

    it('should return null when in kici repo', async () => {
      // Create package.json with kici.development flag
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
      // Create project package.json (NOT kici repo)
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
      // Create project package.json
      await writeFile(
        path.join(testDir, 'package.json'),
        JSON.stringify({ name: 'test' }),
        'utf-8',
      );

      // Use relative path in config
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
