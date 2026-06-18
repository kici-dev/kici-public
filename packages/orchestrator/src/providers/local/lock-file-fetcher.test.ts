import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LockFileParseError } from '@kici-dev/engine';
import { LocalLockFileFetcher } from './lock-file-fetcher.js';

describe('LocalLockFileFetcher', () => {
  const testDir = join(tmpdir(), `kici-local-lock-test-${Date.now()}`);
  const repoDir = join(testDir, 'test-repo');
  const kiciDir = join(repoDir, '.kici');

  const validLockFile = {
    schemaVersion: 4,
    source: { file: '.kici/workflows/ci.ts', export: '#default' },
    contentHash: 'abc123',
    workflows: [
      {
        name: 'test',
        contentHash: 'def456',
        compileSchemaVersion: 2,
        triggers: [{ _type: 'push', branches: [], paths: [] }],
        jobs: [],
      },
    ],
  };

  beforeAll(() => {
    mkdirSync(kiciDir, { recursive: true });
    writeFileSync(join(kiciDir, 'kici.lock.json'), JSON.stringify(validLockFile, null, 2));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('has provider set to local', () => {
    const fetcher = new LocalLockFileFetcher(testDir);
    expect(fetcher.provider).toBe('local');
  });

  describe('fetchLockFile', () => {
    it('fetches lock file from file:// URL', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);
      const result = await fetcher.fetchLockFile(`file://${repoDir}`, 'master', null);

      expect(result).not.toBeNull();
      expect(result!.schemaVersion).toBe(4);
      expect(result!.workflows).toHaveLength(1);
      expect(result!.workflows[0].name).toBe('test');
    });

    it('fetches lock file from relative path under repoBasePath', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);
      const result = await fetcher.fetchLockFile('test-repo', 'main', null);

      expect(result).not.toBeNull();
      expect(result!.schemaVersion).toBe(4);
    });

    it('returns null for non-existent repo path', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);
      const result = await fetcher.fetchLockFile('nonexistent-repo', 'main', null);

      expect(result).toBeNull();
    });

    it('returns null for non-existent file:// path', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);
      const result = await fetcher.fetchLockFile('file:///tmp/does-not-exist', 'main', null);

      expect(result).toBeNull();
    });

    it('throws LockFileParseError for invalid lock file (missing schemaVersion)', async () => {
      const invalidDir = join(testDir, 'invalid-repo', '.kici');
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, 'kici.lock.json'), JSON.stringify({ workflows: [] }));

      const fetcher = new LocalLockFileFetcher(testDir);
      await expect(fetcher.fetchLockFile('invalid-repo', 'main', null)).rejects.toBeInstanceOf(
        LockFileParseError,
      );
    });

    it('throws LockFileParseError for a lock file that is not valid JSON', async () => {
      const corruptDir = join(testDir, 'corrupt-repo', '.kici');
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(join(corruptDir, 'kici.lock.json'), 'not json{');

      const fetcher = new LocalLockFileFetcher(testDir);
      await expect(fetcher.fetchLockFile('corrupt-repo', 'main', null)).rejects.toBeInstanceOf(
        LockFileParseError,
      );
    });

    it('ignores ref parameter (always reads current filesystem state)', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);

      const result1 = await fetcher.fetchLockFile(`file://${repoDir}`, 'master', null);
      const result2 = await fetcher.fetchLockFile(`file://${repoDir}`, 'feature-branch', null);

      expect(result1).toEqual(result2);
    });

    it('ignores credentials parameter', async () => {
      const fetcher = new LocalLockFileFetcher(testDir);
      const result = await fetcher.fetchLockFile(`file://${repoDir}`, 'main', {
        token: 'should-be-ignored',
      });

      expect(result).not.toBeNull();
    });
  });
});
